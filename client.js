// 莉娅 DSH 壁纸插件 —— Client 半（dsh client bundle，手写）
// 功能：
//   1. 在 设置 里注册「壁纸」小节：wallpapers/ 目录的图片（缩略图选择、动态切换）
//   2. 图片透明度滑条 0-100（只作用于壁纸图片本身）
//   3. 底层背景叠半透明层让壁纸透出：颜色运行时读当前皮肤 token，换皮肤自动重算
//   4. 状态持久化走 host（$DSH_HOME/liya-wallpaper-state.json），换浏览器/重启都恢复
// 皮肤说明：Catppuccin 方案已移除（2026-08-15 定稿），只用 DSH 原生浅/深皮肤。
// 参考资料：
//   - 壁纸注入：host 半 index.js 的 tapIndex 脚本（状态 = wallpapers/ 文件名）
//   - 半透明层：ThemeRuntime.overrideTokens（读当前皮肤值转 rgba，不写死颜色）
window.__ModuleLoader__.load({
  id: 'dsh-liya-skin-plugin',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var react = require('react');

    // ── 壁纸 ──
    // 壁纸以图片为主：wallpapers/ 目录里的图（缩略图选择、动态切换），不设预设。
    // 图片透明度 0-100（默认 100）：只作用于壁纸图片本身（body::before 的 opacity）。
    var WALLPAPER_KEY = 'dsh-liya-wallpaper';
    var WALLPAPER_OPACITY_KEY = 'dsh-liya-wallpaper-opacity';
    var DEFAULT_OPACITY = 100;

    function wallpaperCss(value) {
      if (!value || value === 'off') return 'none';
      return 'url("/liya-wallpaper/file/' + encodeURIComponent(value) + '")';
    }

    function applyWallpaperToBody(value) {
      try {
        document.body.style.setProperty('--dsh-wallpaper', wallpaperCss(value));
        document.body.style.setProperty('--dsh-wallpaper-opacity', String(opacityValue()));
      } catch (e) {}
    }

    // ── 壁纸与皮肤正交的关键：
    // 半透明层不写死颜色，而是运行时读「当前皮肤」的实际 token 值再转 rgba，
    // 并在 theme/change（换皮肤）时重算——皮肤管颜色、壁纸只管透图，互不打架。
    // 底层背景固定半透明（保证壁纸透出来），滑条只控制图片本身的透明度。
    var WALLPAPER_BG_ALPHA = 0.6;
    var WALLPAPER_TOKENS = ['--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-specific-sidebar-fill'];
    var wallpaperOverrideDisposer = null;

    // 图片透明度 0-100 → body::before 的 opacity（0-1）
    function currentOpacity() {
      try {
        var v = parseInt(localStorage.getItem(WALLPAPER_OPACITY_KEY), 10);
        if (!isNaN(v)) return Math.max(0, Math.min(100, v));
      } catch (e) {}
      return DEFAULT_OPACITY;
    }
    function opacityValue() { return currentOpacity() / 100; }

    // 颜色统一转成带 alpha 的 rgba：支持 rgb()/rgba() 与 #rgb / #rrggbb / #rrggbbaa；
    // 认不出的原样兜底（0.2.1 起主题 token 用十六进制，0.5.2 栽在只认 rgb()）。
    function toTranslucent(value, alpha) {
      var v = String(value || '').trim();
      if (!v) return '';
      var m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(v);
      if (m) return 'rgba(' + m[1] + ', ' + m[2] + ', ' + m[3] + ', ' + alpha + ')';
      var hex = /^#([0-9a-fA-F]{3,8})$/.exec(v);
      if (hex) {
        var h = hex[1];
        var r, g, b;
        if (h.length === 3 || h.length === 4) {
          r = parseInt(h[0] + h[0], 16); g = parseInt(h[1] + h[1], 16); b = parseInt(h[2] + h[2], 16);
        } else if (h.length === 6 || h.length === 8) {
          r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
        }
        if (r === r && g === g && b === b) return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
      }
      return v;
    }

    // 解析颜色：hex / rgb()/rgba() 直接用；var(--static-…) / color-mix 之类交给浏览器
    // 在一个离屏探针元素上算出 resolved color（不读 body，避免读到我们自己写的 override）。
    function resolveColor(value) {
      var v = String(value || '').trim();
      if (!v) return '';
      if (/^rgba?\(/i.test(v) || /^#/.test(v)) return v;
      try {
        var el = document.createElement('span');
        el.style.position = 'absolute';
        el.style.left = '-9999px';
        el.style.top = '0';
        el.style.color = v;
        document.body.appendChild(el);
        var c = getComputedStyle(el).color;
        document.body.removeChild(el);
        return c || '';
      } catch (e) { return ''; }
    }

    // 从基础调色板 CSS 读 token 声明值：亮色在 `body{}`，暗色在 `body[data-ds-dark-theme]{}`。
    // 关键：不读 getComputedStyle(body)——那会把我们上一轮写的 override 读回来（自污染，
    // 0.5.2 在暗色下卡成白色 0.6 就是这个原因）。
    function paletteToken(name, dark) {
      var want = dark ? 'body[data-ds-dark-theme]' : 'body';
      var base = '';
      var sheets = document.styleSheets;
      for (var i = 0; i < sheets.length; i++) {
        var rules;
        try { rules = sheets[i].cssRules; } catch (e) { continue; }
        if (!rules) continue;
        for (var j = 0; j < rules.length; j++) {
          var rule = rules[j];
          if (!rule.style) continue;
          var sel = String(rule.selectorText || '').replace(/\s+/g, '');
          if (sel !== want && sel !== 'body') continue;
          var v = rule.style.getPropertyValue(name);
          if (!v) continue;
          if (sel === want) return v;
          if (!base) base = v;
        }
      }
      return base;
    }

    // 同时算亮/暗两套半透明值，交给 theme.overrideTokens 的 {light, dark} 结构，
    // 由主题服务按当前 colorScheme 自己挑——这样不依赖「apply 时 body 上有没有 dark 属性」，
    // 也不会因为监听顺序先算到亮色而在暗色下留一层白（0.5.2/0.5.3 都栽在时序上）。
    function computeTranslucentLayer(snapshot) {
      var tokens = snapshot && snapshot.active && snapshot.active.tokens ? snapshot.active.tokens : null;
      var layer = {};
      WALLPAPER_TOKENS.forEach(function (name) {
        var custom = tokens && typeof tokens[name] === 'string' ? tokens[name].trim() : '';
        var lightRaw = paletteToken(name, false) || custom;
        var darkRaw = paletteToken(name, true) || custom;
        var light = toTranslucent(resolveColor(lightRaw), WALLPAPER_BG_ALPHA);
        var dark = toTranslucent(resolveColor(darkRaw), WALLPAPER_BG_ALPHA);
        if (!light && !dark) return;
        layer[name] = { light: light || dark, dark: dark || light };
      });
      return layer;
    }

    function disposeWallpaperOverride() {
      if (wallpaperOverrideDisposer) {
        try { wallpaperOverrideDisposer(); } catch (e) {}
        wallpaperOverrideDisposer = null;
      }
    }

    // snapshot：可选的 theme 快照（theme/change 直接给）；没给就现取 theme.getTheme()。
    // 取色走调色板 CSS + 快照，不依赖 body 上 DOM 变量是否已写入，也不受自身 override 影响。
    function syncWallpaperOverride(ctx, value, defer, snapshot) {
      disposeWallpaperOverride();
      if (!value || value === 'off') return;
      function apply() {
        var theme = ctx.get('theme');
        if (theme === undefined) return;
        var snap = snapshot;
        if (!snap && typeof theme.getTheme === 'function') {
          try { snap = theme.getTheme(); } catch (e) { snap = null; }
        }
        try {
          wallpaperOverrideDisposer = theme.overrideTokens('liya-wallpaper', computeTranslucentLayer(snap));
        } catch (e) {
          console.warn('[dsh-liya-skin] wallpaper override failed: ' + (e && e.message));
        }
      }
      if (defer) { try { window.requestAnimationFrame(apply); } catch (e) { apply(); } } else { apply(); }
    }

    // 旧版本（渐变时代）可能残留 gradient-* 值——已废弃，一律按 off 处理并迁移。
    // 教训（2026-08-15）：产品形态变更必须处理 localStorage 旧值，否则出现「半透明+无图」的坏样。
    function sanitizeWallpaperValue(value) {
      if (!value || value === 'off') return 'off';
      if (/^gradient-/.test(value)) return 'off';
      return value;
    }

    function currentWallpaper() {
      try {
        var v = localStorage.getItem(WALLPAPER_KEY) || 'off';
        var s = sanitizeWallpaperValue(v);
        if (s !== v) { try { localStorage.setItem(WALLPAPER_KEY, s); } catch (e) {} }
        return s;
      } catch (e) { return 'off'; }
    }

    // 纯应用（不写 host）：启动恢复用。用户主动操作才走 setWallpaper / setWallpaperOpacity（会 POST）。
    function applyWallpaperState(ctx, image, opacity) {
      var safe = sanitizeWallpaperValue(image);
      try {
        localStorage.setItem(WALLPAPER_KEY, safe);
        localStorage.setItem(WALLPAPER_OPACITY_KEY, String(opacity));
      } catch (e) {}
      applyWallpaperToBody(safe);
      syncWallpaperOverride(ctx, safe);
    }

    function setWallpaper(ctx, value) {
      var safe = sanitizeWallpaperValue(value);
      try { localStorage.setItem(WALLPAPER_KEY, safe); } catch (e) {}
      applyWallpaperToBody(safe);
      syncWallpaperOverride(ctx, safe);
      saveStateToHost(safe, currentOpacity());
    }

    // 图片透明度滑条：0-100 持久化 + 即时更新 body::before 的 opacity（不动底层背景）
    function setWallpaperOpacity(ctx, value) {
      try { localStorage.setItem(WALLPAPER_OPACITY_KEY, String(value)); } catch (e) {}
      applyWallpaperToBody(currentWallpaper());
      saveStateToHost(currentWallpaper(), value);
    }

    // ── host 侧持久化（$DSH_HOME/liya-wallpaper-state.json）：让壁纸像原生主题一样跨浏览器/重启恢复
    function saveStateToHost(image, opacity) {
      try {
        fetch('/liya-wallpaper/state', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ image: image, opacity: opacity })
        }).catch(function () {});
      } catch (e) {}
    }

    // 启动时从 host 恢复（host 无状态时保持 localStorage 兜底结果）
    function restoreFromHost(ctx) {
      fetch('/liya-wallpaper/state')
        .then(function (r) { return r.ok ? r.json() : {}; })
        .then(function (state) {
          if (!state || typeof state !== 'object') return;
          var hasState = typeof state.image === 'string' || typeof state.opacity === 'number';
          if (!hasState) return;
          var image = sanitizeWallpaperValue(typeof state.image === 'string' ? state.image : 'off');
          var opacity = (typeof state.opacity === 'number' && !isNaN(state.opacity))
            ? Math.max(0, Math.min(100, Math.round(state.opacity)))
            : currentOpacity();
          try {
            localStorage.setItem(WALLPAPER_KEY, image);
            localStorage.setItem(WALLPAPER_OPACITY_KEY, String(opacity));
          } catch (e) {}
          applyWallpaperToBody(image);
          syncWallpaperOverride(ctx, image);
        })
        .catch(function () {});
    }

    // ══════════════════════════════════════════════════════════════════
    // 莉娅星月皮肤层（v0.3.0）—— 架构抄 dsh-deep-whale/maid-atelier
    //   · 皮肤作用域：body[data-dsh-liya-skin]，CSS 全挂作用域下
    //   · 装饰：顶部星带 + 底部星轨 + 标题栏弯月徽标（自绘 SVG，与壁纸正交）
    //   · 状态投影：body[data-liya-*] 属性（对话中/设置开），CSS 响应
    //   · 卸载：effect 销毁器完整还原（attr/style/DOM/observers）
    // ══════════════════════════════════════════════════════════════════
    var SKIN_OWNER = 'dsh-liya-skin';
    var SIDEBAR_COLUMN_SELECTOR = ":is([data-pane='sidebar'], [class*='sidebarCol'])";
    var ACTIVE_CHAT_SELECTOR = "[data-phase='active'] [data-chat-flow]";
    var SETTINGS_TRIGGER_SELECTOR = "[data-slot='sidebar.settings'] > :is(button, [role='button'])";
    var PROJECTED_STATE_ATTRIBUTES = {
      chatActive: 'data-liya-chat-active',
      settingsOpen: 'data-liya-settings-open'
    };
    var BACKDROP_PROPERTIES = ['--liya-star-tile', '--liya-moon-badge', '--liya-orbit-tile'];

    // 自绘星月素材（SVG data URI，运行时 URL 编码；颜色与明暗正交，不写死遮罩色）
    var LIYA_ART = {
      starTile: "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"56\" height=\"24\" viewBox=\"0 0 56 24\"><path d=\"M12 3 L13.6 8.6 L19.2 10.2 L13.6 11.8 L12 17.4 L10.4 11.8 L4.8 10.2 L10.4 8.6 Z\" fill=\"#c5a468\" opacity=\"0.5\"/><circle cx=\"30\" cy=\"15\" r=\"1.2\" fill=\"#e2cfaa\" opacity=\"0.55\"/><circle cx=\"42\" cy=\"6\" r=\"0.9\" fill=\"#c5a468\" opacity=\"0.45\"/><circle cx=\"50\" cy=\"18\" r=\"0.7\" fill=\"#e2cfaa\" opacity=\"0.4\"/></svg>",
      moonBadge: "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"46\" height=\"40\" viewBox=\"0 0 46 40\"><circle cx=\"23\" cy=\"20\" r=\"16\" fill=\"none\" stroke=\"#c5a468\" stroke-width=\"0.8\" opacity=\"0.35\" stroke-dasharray=\"2 4\"/><path d=\"M28 8 A 12.5 12.5 0 1 0 28 32 A 10 10 0 0 1 28 8 Z\" fill=\"#e2cfaa\"/><path d=\"M8 6 L9.2 10.8 L14 12 L9.2 13.2 L8 18 L6.8 13.2 L2 12 L6.8 10.8 Z\" fill=\"#c5a468\"/></svg>",
      orbitTile: "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"120\" height=\"36\" viewBox=\"0 0 120 36\"><path d=\"M0 30 Q 28 8 58 18 T 120 12\" fill=\"none\" stroke=\"#c5a468\" stroke-width=\"1.1\" opacity=\"0.4\"/><path d=\"M10 6 L11 8.8 L13.8 9.8 L11 10.8 L10 13.6 L9 10.8 L6.2 9.8 L9 8.8 Z\" fill=\"#c5a468\" opacity=\"0.55\"/><circle cx=\"78\" cy=\"24\" r=\"1.3\" fill=\"#e2cfaa\" opacity=\"0.6\"/><circle cx=\"104\" cy=\"8\" r=\"1\" fill=\"#c5a468\" opacity=\"0.5\"/></svg>",
      // 标题栏品牌：弯月 + 星 + 「莉娅」字（内联 SVG，currentColor 走皮肤色）
      titlebarBrand: "<svg viewBox=\"0 0 24 24\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M16 3 A 9 9 0 1 0 16 21 A 7 7 0 0 1 16 3 Z\" fill=\"currentColor\"/><path d=\"M4 4 L5 6.4 L7.5 7.4 L5 8.4 L4 10.8 L3 8.4 L0.5 7.4 L3 6.4 Z\" fill=\"currentColor\" opacity=\"0.85\"/></svg><span>莉娅</span>"
    };

    // 皮肤层 CSS：全挂 body[data-dsh-liya-skin] 作用域（星带/星轨/徽标，pointer-events none）
    var SKIN_CSS = "body[data-dsh-liya-skin]{--liya-sidebar-width:0px}"
      + "body[data-dsh-liya-skin] [data-skin-chrome='liya-top-trim']{position:fixed;inset:0 0 auto 0;z-index:20;height:44px;translate:var(--liya-sidebar-width) 0;pointer-events:none;overflow:hidden;contain:paint}"
      + "body[data-dsh-liya-skin] [data-skin-chrome='liya-top-trim']::before{content:'';position:absolute;inset:0;background:var(--liya-star-tile,none) repeat-x top/auto 24px;opacity:.85}"
      + "body[data-dsh-liya-skin] [data-skin-chrome='liya-top-trim']::after{content:'';position:absolute;top:-3px;left:calc((100% - var(--liya-sidebar-width) - 8px)/2);width:46px;height:40px;transform:translateX(-50%);background:var(--liya-moon-badge,none) center/contain no-repeat;filter:drop-shadow(0 2px 5px rgba(60,80,140,.25))}"
      + "body[data-dsh-liya-skin] [data-skin-chrome='liya-bottom-trim']{position:fixed;inset:auto 0 0 0;z-index:19;height:46px;translate:var(--liya-sidebar-width) 0;pointer-events:none;contain:paint;background:var(--liya-orbit-tile,none) repeat-x bottom/auto 36px;transition:transform 420ms cubic-bezier(.22,.78,.2,1)}"
      + "body[data-dsh-liya-skin][data-liya-conversation-active] [data-skin-chrome='liya-bottom-trim']{transform:translateY(100%)}"
      + "body[data-dsh-liya-skin] [data-skin-chrome='liya-titlebar-brand']{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:inline-flex;align-items:center;gap:6px;color:#e2cfaa;pointer-events:none;white-space:nowrap}"
      + "body[data-dsh-liya-skin][data-ds-dark-theme] [data-skin-chrome='liya-titlebar-brand']{color:#e8d9b0}"
      + "body[data-dsh-liya-skin] [data-skin-chrome='liya-titlebar-brand'] svg{display:block;height:16px;width:auto;filter:drop-shadow(0 1px 2px rgba(30,45,90,.35))}"
      + "body[data-dsh-liya-skin] [data-skin-chrome='liya-titlebar-brand'] span{font-size:13px;letter-spacing:2px}"
      + "body[data-dsh-liya-skin] [class*='titlebar']{position:relative}"
      + "@media (prefers-reduced-motion:reduce){body[data-dsh-liya-skin] [data-skin-chrome='liya-bottom-trim']{transition:none}}";

    function liyaDataUri(svg) {
      return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    }

    // rc.2 设置接入：客户端服务由 settingsScope 改为 configForms（官方 ui-settings 的 client 半提供），
    // namespace 用 profile entry id（插件 cordis.patch.yml 里的 id，本插件 = dsh-liya-skin）。
    // ⚠️ 不写进 inject：万一服务缺席，条目只是拿不到配置，绝不让整个 web boot 卡在 pending（2026-10-02 实锤）。
    function liyaConfigForm(ctx, entryId) {
      try {
        var cf = ctx.get('configForms');
        if (cf === undefined || cf === null || typeof cf.get !== 'function') return null;
        return cf.get(entryId);
      } catch (e) { return null; }
    }

    // 读皮肤层配置（configForms 可用时 host 持久化；否则默认全开）
    // 教训（2026-08-17 实锤）：scope 必须 apply 期 bind 一次复用——bind() 每次调用都新建
    // controller（初始 status='loading'、load 异步），重复 bind 永远读不到 'ready'，配置永不生效。
    function readSkinConfig(bound) {
      var cfg = { skin: true, topTrim: true, bottomTrim: true, titlebarBrand: true };
      try {
        if (bound !== null) {
          var snap = bound.getSnapshot();
          if (snap && snap.status === 'ready' && snap.value) {
            if (typeof snap.value.skin === 'boolean') cfg.skin = snap.value.skin;
            if (typeof snap.value.topTrim === 'boolean') cfg.topTrim = snap.value.topTrim;
            if (typeof snap.value.bottomTrim === 'boolean') cfg.bottomTrim = snap.value.bottomTrim;
            if (typeof snap.value.titlebarBrand === 'boolean') cfg.titlebarBrand = snap.value.titlebarBrand;
          }
        }
      } catch (e) {}
      return cfg;
    }

    // 皮肤层启动：返回 effect 销毁器（完整还原一切皮肤写入）
    function startLiyaSkin(ctx, bound) {
      var cfg = readSkinConfig(bound);
      if (!cfg.skin) return function () {}; // 总开关关闭：不注入作用域/装饰（壁纸不受影响）
      var body = document.body;
      var previousAttrs = {};
      for (var key in PROJECTED_STATE_ATTRIBUTES) {
        if (Object.prototype.hasOwnProperty.call(PROJECTED_STATE_ATTRIBUTES, key)) {
          previousAttrs[PROJECTED_STATE_ATTRIBUTES[key]] = body.getAttribute(PROJECTED_STATE_ATTRIBUTES[key]);
        }
      }
      var previousArt = {};
      for (var i = 0; i < BACKDROP_PROPERTIES.length; i++) {
        previousArt[BACKDROP_PROPERTIES[i]] = body.style.getPropertyValue(BACKDROP_PROPERTIES[i]);
      }

      var ownedNodes = [];
      var observer = null;
      var resizeObserver = null;
      var widthRule = null;
      var observedSidebar = null;

      var clean = function () {
        delete body.dataset.dshLiyaSkin;
        delete body.dataset.liyaChatActive;
        delete body.dataset.liyaSettingsOpen;
        for (var a in previousAttrs) {
          if (Object.prototype.hasOwnProperty.call(previousAttrs, a)) {
            if (previousAttrs[a] === null) body.removeAttribute(a);
            else body.setAttribute(a, previousAttrs[a]);
          }
        }
        for (var p in previousArt) {
          if (Object.prototype.hasOwnProperty.call(previousArt, p)) body.style.setProperty(p, previousArt[p]);
        }
        if (observer !== null) observer.disconnect();
        if (resizeObserver !== null) resizeObserver.disconnect();
        for (var n = 0; n < ownedNodes.length; n++) ownedNodes[n].remove();
      };

      body.dataset.dshLiyaSkin = '';
      body.style.setProperty('--liya-star-tile', 'url("' + liyaDataUri(LIYA_ART.starTile) + '")');
      body.style.setProperty('--liya-moon-badge', 'url("' + liyaDataUri(LIYA_ART.moonBadge) + '")');
      body.style.setProperty('--liya-orbit-tile', 'url("' + liyaDataUri(LIYA_ART.orbitTile) + '")');

      // CSS 注入（data-plugin 标记，卸载即删）
      var styleTag = document.createElement('style');
      styleTag.dataset.plugin = 'dsh-liya-skin-plugin';
      styleTag.dataset.pluginCss = 'dsh-liya-skin/starlight.css';
      styleTag.textContent = SKIN_CSS;
      ownedNodes.push(styleTag);
      document.head.appendChild(styleTag);

      // 顶部星带 + 底部星轨（fixed 装饰层，按配置开关创建）
      function makeTrim(chrome) {
        var el = document.createElement('div');
        el.dataset.skinChrome = chrome;
        el.dataset.skinOwner = SKIN_OWNER;
        el.setAttribute('aria-hidden', 'true');
        return el;
      }
      if (cfg.topTrim) {
        var topTrim = makeTrim('liya-top-trim');
        ownedNodes.push(topTrim);
        document.body.appendChild(topTrim);
      }
      if (cfg.bottomTrim) {
        var bottomTrim = makeTrim('liya-bottom-trim');
        ownedNodes.push(bottomTrim);
        document.body.appendChild(bottomTrim);
      }

      // 标题栏品牌（存在 titlebar 才装饰；幂等；配置关闭则跳过）
      function decorateTitlebarBrand() {
        if (!cfg.titlebarBrand) return;
        var titlebar = document.querySelector("[class*='titlebar']");
        if (titlebar === null) return;
        if (titlebar.querySelector("[data-skin-chrome='liya-titlebar-brand']") !== null) return;
        var brand = document.createElement('span');
        brand.dataset.skinChrome = 'liya-titlebar-brand';
        brand.dataset.skinOwner = SKIN_OWNER;
        brand.setAttribute('aria-hidden', 'true');
        brand.innerHTML = LIYA_ART.titlebarBrand;
        ownedNodes.push(brand);
        titlebar.prepend(brand);
      }

      // 状态投影：对话中 / 设置打开 → body[data-liya-*]
      function syncProjectedState() {
        body.toggleAttribute(PROJECTED_STATE_ATTRIBUTES.chatActive, document.querySelector(ACTIVE_CHAT_SELECTOR) !== null);
        body.toggleAttribute(PROJECTED_STATE_ATTRIBUTES.settingsOpen, document.querySelector(SETTINGS_TRIGGER_SELECTOR + "[aria-expanded='true']") !== null);
      }

      // 侧栏宽度联动：ResizeObserver 写 CSSOM（不产生 attribute mutation，避免观察死循环）
      if (typeof ResizeObserver !== 'undefined') {
        var widthSheet = document.createElement('style');
        widthSheet.dataset.skinChrome = 'liya-sidebar-rule';
        widthSheet.dataset.skinOwner = SKIN_OWNER;
        ownedNodes.push(widthSheet);
        document.head.appendChild(widthSheet);
        widthSheet.sheet.insertRule('body[data-dsh-liya-skin] { --liya-sidebar-width: 0px; }');
        widthRule = widthSheet.sheet.cssRules[0];
        resizeObserver = new ResizeObserver(function (entries) {
          var entry = entries[entries.length - 1];
          if (entry !== undefined) {
            widthRule.style.setProperty('--liya-sidebar-width', String(Math.round(entry.contentRect.width * 100) / 100) + 'px');
          }
        });
        function watchSidebar() {
          var sidebar = document.querySelector(SIDEBAR_COLUMN_SELECTOR);
          if (sidebar === null || sidebar === observedSidebar) return;
          if (observedSidebar !== null) resizeObserver.unobserve(observedSidebar);
          observedSidebar = sidebar;
          resizeObserver.observe(sidebar);
        }
        watchSidebar();
      }

      // MutationObserver：状态/结构变化 → 重投影 + 补装饰（皮肤自身节点跳过）
      function isSkinChrome(node) {
        return node instanceof Element && node.getAttribute('data-skin-owner') === SKIN_OWNER;
      }
      function touches(node, selector) {
        return node instanceof Element && (node.matches(selector) || node.querySelector(selector) !== null);
      }
      observer = new MutationObserver(function (records) {
        var projected = false;
        var structure = false;
        for (var r = 0; r < records.length; r++) {
          var record = records[r];
          if (record.type === 'attributes') {
            var name = record.attributeName;
            if (name === 'aria-expanded' || name === 'data-chat-flow' || name === 'data-phase' || name === 'data-slot' || name === 'role') {
              projected = true;
            }
            if (name === 'data-chat-flow' || name === 'data-phase') structure = true;
            continue;
          }
          var nodes = [];
          if (record.addedNodes) for (var k = 0; k < record.addedNodes.length; k++) nodes.push(record.addedNodes[k]);
          if (record.removedNodes) for (var m = 0; m < record.removedNodes.length; m++) nodes.push(record.removedNodes[m]);
          for (var j = 0; j < nodes.length; j++) {
            if (isSkinChrome(nodes[j])) continue;
            if (touches(nodes[j], "[class*='titlebar']")) structure = true;
            if (touches(nodes[j], "[data-phase='hero'], [data-phase='active']")) projected = true;
          }
        }
        if (projected) syncProjectedState();
        if (structure) decorateTitlebarBrand();
      });
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ['aria-expanded', 'data-chat-flow', 'data-phase', 'data-slot', 'role'],
        childList: true,
        subtree: true
      });

      // 初始应用
      decorateTitlebarBrand();
      syncProjectedState();

      return clean;
    }

    // ── 「壁纸」设置小节
    function WallpaperBlock(props) {
      var ctx = props.ctx;
      var files = react.useState([]);
      var list = files[0];
      var setList = files[1];
      var cur = react.useState(currentWallpaper());
      var value = cur[0];
      var setValue = cur[1];
      var opacityState = react.useState(currentOpacity());
      var opacity = opacityState[0];
      var setOpacity = opacityState[1];
      var tick = react.useState(0);
      var refreshTick = tick[0];
      var setRefreshTick = tick[1];

      react.useEffect(function () {
        var cancelled = false;
        fetch('/liya-wallpaper/list')
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
          })
          .then(function (json) {
            if (!cancelled) {
              var arr = Array.isArray(json) ? json : [];
              setList(arr);
              // 当前选中的文件已被删除/失效 → 自动回退关闭，避免半透明无图
              var cur = currentWallpaper();
              if (cur !== 'off' && !arr.some(function (f) { return f.name === cur; })) {
                pick('off');
              }
            }
          })
          .catch(function () { if (!cancelled) setList([]); });
        return function () { cancelled = true; };
      }, [refreshTick]);

      function pick(v) {
        setValue(v);
        setWallpaper(ctx, v);
      }

      function onOpacityChange(e) {
        var v = parseInt(e.target.value, 10);
        if (isNaN(v)) return;
        setOpacity(v);
        setWallpaperOpacity(ctx, v);
      }

      function chip(label, id, desc, active, onClick) {
        var style = {
          display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
          background: active ? 'var(--dsw-alias-bg-layer-3)' : 'var(--dsw-alias-bg-layer-1)',
          border: '1px solid ' + (active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-border-l2)'),
          borderRadius: 12, padding: '9px 14px', marginBottom: 8,
          font: 'inherit', color: 'var(--dsw-alias-label-primary)'
        };
        return react.createElement(
          'button', { style: style, onClick: function () { onClick(id); } },
          react.createElement('div', { style: { fontSize: 14, fontWeight: 500 } }, label),
          react.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', marginTop: 2 } }, desc)
        );
      }

      var toolBtnStyle = {
        cursor: 'pointer', font: 'inherit', fontSize: 13,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-3)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8, padding: '5px 10px'
      };

      var nodes = [
        react.createElement('h2', { key: 'head', style: { margin: '0 0 8px', fontSize: 16, fontWeight: 600 } }, '壁纸'),
        react.createElement('p', { key: 'tip', style: { margin: '0 0 10px', fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-secondary)' } },
          '以图片为主、无预设。图片丢进插件目录 wallpapers/ 后点刷新；点缩略图即动态切换，颜色自动跟随当前皮肤。'),
        react.createElement('div', { key: 'opacity', style: { margin: '0 0 12px' } },
          react.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 } },
            react.createElement('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, '图片透明度'),
            react.createElement('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, opacity + '%')
          ),
          react.createElement('input', {
            type: 'range', min: 0, max: 100, step: 1, value: opacity,
            onChange: onOpacityChange,
            style: { width: '100%' }
          }),
          react.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginTop: 2 } },
            '0 = 图片不可见｜100 = 图片全显示（只影响壁纸图片本身）')
        ),
        react.createElement('div', { key: 'toolbar', style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
          react.createElement('button', { style: toolBtnStyle, onClick: function () { setRefreshTick(function (t) { return t + 1; }); } }, '🔃 刷新图片'),
          react.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } },
            list.length + ' 张图')
        ),
        chip('🚫 关闭壁纸', 'off', '恢复纯色背景', value === 'off', pick)
      ];

      if (list.length === 0) {
        nodes.push(react.createElement('div', {
          key: 'empty',
          style: { padding: 12, borderRadius: 12, border: '1px dashed var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, lineHeight: '20px' }
        }, 'wallpapers/ 里还没有图片。把 png/jpg/webp/gif/svg 丢进 workspace/dsh-plugins/dsh-liya-skin/wallpapers/ 后点刷新。'));
      } else {
        nodes.push(react.createElement('div', { key: 'grid', style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 } },
          list.map(function (f) {
            var active = value === f.name;
            return react.createElement('button', {
              key: f.name,
              title: f.name,
              onClick: function () { pick(f.name); },
              style: {
                width: 120, padding: 3, cursor: 'pointer',
                background: 'var(--dsw-alias-bg-layer-1)',
                border: '1px solid ' + (active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-border-l2)'),
                borderRadius: 10, overflow: 'hidden'
              }
            },
              react.createElement('img', {
                src: f.url,
                alt: f.name,
                style: { display: 'block', width: '100%', height: 70, objectFit: 'cover', borderRadius: 7 }
              }),
              react.createElement('div', {
                style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', padding: '4px 2px 0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
              }, f.name)
            );
          })
        ));
      }

      return react.createElement('div', { key: 'wallpaper', style: { padding: '4px 0', color: 'var(--dsw-alias-label-primary)' } }, nodes);
    }

    // ── 插件配置卡（设置 → 插件 → 插件配置，id: dsh-liya-skin）
    // 原生风格：可展开 + 可编辑配置（皮肤层开关）+ 保存/撤销，走 configForms（host 持久化，即时生效）。
    // 视觉对齐官方 PluginCard：header 展开按钮 + dirty「未保存」标记 + body 字段 + footer 撤销/保存。
    var LIYA_SKIN_FIELDS = [
      { field: 'skin', label: '皮肤层总开关', hint: '关闭后星月装饰与作用域全部不注入（壁纸不受影响）' },
      { field: 'topTrim', label: '顶部星带', hint: '页面顶部的星星饰带' },
      { field: 'bottomTrim', label: '底部星轨', hint: '页面底部的星轨饰带，对话中自动退下' },
      { field: 'titlebarBrand', label: '标题栏「莉娅」徽标', hint: 'frameless 标题栏居中的弯月徽标（普通标签页无标题栏则不显示）' }
    ];
    var LIYA_CARD_BTN = {
      font: 'inherit', fontSize: 13, borderRadius: 8, padding: '5px 12px', cursor: 'pointer',
      border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)'
    };

    function LiyaSkinCard(props) {
      var ctx = props.ctx;
      // 绑定 settings scope：优先用 apply 期绑定的 props.bound（不在 React 渲染期 bind）；
      // 回退渲染期 bind（settings 服务缺失则卡退化为只读展示）
      var bound = props.bound !== undefined ? props.bound : null;
      if (bound === null) {
        bound = liyaConfigForm(ctx, 'dsh-liya-skin');
      }

      var openState = react.useState(false);
      var open = openState[0];
      var setOpen = openState[1];
      var stagedState = react.useState({});
      var staged = stagedState[0];
      var setStaged = stagedState[1];
      var clearedState = react.useState({});
      var cleared = clearedState[0];
      var setCleared = clearedState[1];
      var savingState = react.useState(false);
      var saving = savingState[0];
      var setSaving = savingState[1];
      var failedState = react.useState(false);
      var failed = failedState[0];
      var setFailed = failedState[1];

      var snap = null;
      var syncError = null;
      if (bound !== null) {
        // ⚠️ 方法必须包函数绑定 this：React 裸调 subscribe/getSnapshot 时 this 丢失，
        // controller 里 this.store 会抛 "Cannot read properties of undefined (reading 'store')"（2026-08-16 实战）
        try {
          snap = react.useSyncExternalStore(
            function (listener) { return bound.subscribe(listener); },
            function () { return bound.getSnapshot(); }
          );
        } catch (e) { syncError = e && e.message; snap = null; }
      }
      var available = bound !== null && snap !== null && snap.status === 'ready';
      var loading = bound !== null && snap !== null && snap.status === 'loading';
      var writable = bound !== null && snap !== null && !!snap.writable;
      var value = (snap && snap.value && typeof snap.value === 'object') ? snap.value : {};
      var user = (snap && snap.user && typeof snap.user === 'object') ? snap.user : {};
      // 诊断：为何配置不可用（configForms 服务/控制器 status/订阅异常）
      var diag = {
        hasConfigForms: ctx.get('configForms') !== undefined,
        bound: bound !== null,
        status: snap === null ? 'no-snap' : snap.status,
        syncError: syncError,
      };

      var dirty = Object.keys(staged).length > 0 || Object.keys(cleared).length > 0;
      var blocked = !dirty || saving;

      function toggleField(f) {
        var shown = (staged[f] !== undefined) ? staged[f] : (value[f] !== false);
        var ns = {};
        for (var k in staged) if (Object.prototype.hasOwnProperty.call(staged, k)) ns[k] = staged[k];
        ns[f] = !shown;
        setStaged(ns);
        var nc = {};
        for (var c in cleared) if (Object.prototype.hasOwnProperty.call(cleared, c)) nc[c] = cleared[c];
        delete nc[f];
        setCleared(nc);
        setFailed(false);
      }
      function resetField(f) {
        var ns = {};
        for (var k in staged) if (Object.prototype.hasOwnProperty.call(staged, k)) ns[k] = staged[k];
        delete ns[f];
        setStaged(ns);
        var nc = {};
        for (var c in cleared) if (Object.prototype.hasOwnProperty.call(cleared, c)) nc[c] = cleared[c];
        nc[f] = true;
        setCleared(nc);
        setFailed(false);
      }
      function onSave() {
        if (bound === null || !dirty) return;
        setSaving(true);
        setFailed(false);
        var ops = [];
        for (var k in staged) if (Object.prototype.hasOwnProperty.call(staged, k)) ops.push(bound.set(k, staged[k] === true));
        for (var c in cleared) if (Object.prototype.hasOwnProperty.call(cleared, c)) ops.push(bound.unset(c));
        Promise.all(ops).then(function () {
          setSaving(false);
          setStaged({});
          setCleared({});
        }).catch(function () {
          setSaving(false);
          setFailed(true);
        });
      }
      function onDiscard() {
        setStaged({});
        setCleared({});
        setFailed(false);
      }

      function toggleRow(field) {
        var f = field.field;
        var shown = (staged[f] !== undefined) ? staged[f] : (value[f] !== false);
        var overridden = Object.prototype.hasOwnProperty.call(user, f);
        var stagedPending = staged[f] !== undefined;
        var id = 'liya-skin-cfg-' + f;
        return react.createElement(
          'div',
          { key: f, style: { padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l2)' } },
          react.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            react.createElement('input', {
              id: id, type: 'checkbox', checked: shown, disabled: !writable,
              onChange: function () { toggleField(f); },
              style: { accentColor: 'var(--dsw-alias-brand-primary)', width: 15, height: 15, cursor: 'pointer', flex: 'none' }
            }),
            react.createElement('label', { htmlFor: id, style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', flex: '1 1 auto' } }, field.label),
            overridden ? react.createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', flex: 'none' } }, '已覆盖') : null,
            stagedPending ? react.createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', flex: 'none' } }, '未保存') : null
          ),
          react.createElement(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 4, paddingLeft: 25 } },
            react.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', lineHeight: '18px' } }, field.hint),
            (overridden || stagedPending) ? react.createElement('button', {
              type: 'button', onClick: function () { resetField(f); }, disabled: !writable,
              style: { fontSize: 11, background: 'none', border: 'none', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', padding: 0, flex: 'none' }
            }, '重置') : null
          )
        );
      }

      var titleRow = react.createElement(
        'button',
        {
          type: 'button',
          'aria-expanded': open,
          onClick: function () { setOpen(!open); },
          style: {
            display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between',
            gap: 10, padding: '10px 12px', border: 0, background: 'transparent',
            color: 'var(--dsw-alias-label-primary)', font: 'inherit', cursor: 'pointer', textAlign: 'left'
          }
        },
        react.createElement(
          'span',
          { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
          react.createElement('strong', { style: { fontSize: 13, fontWeight: 600 } }, 'dsh-liya-skin-plugin'),
          react.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '壁纸 + 星月皮肤层，配置皮肤装饰开关')
        ),
        react.createElement(
          'span',
          { style: { display: 'flex', alignItems: 'center', gap: 6, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, flex: 'none' } },
          dirty ? react.createElement('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, '未保存') : react.createElement('span', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            react.createElement('span', { style: { width: 8, height: 8, borderRadius: '50%', background: 'var(--dsw-alias-state-success-primary)', display: 'inline-block' } }),
            '运行中'
          ),
          react.createElement('span', { 'aria-hidden': 'true', style: { transition: 'transform .15s', transform: open ? 'rotate(180deg)' : 'none', fontSize: 10 } }, '▾')
        )
      );

      var body = null;
      if (open) {
        var content;
        if (loading) {
          content = react.createElement('p', { key: 'loading', style: { margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' } }, '配置加载中…');
        } else if (!available) {
          content = react.createElement(
            'div',
            { key: 'unavailable' },
            react.createElement('p', { style: { margin: '0 0 8px', fontSize: 13, color: 'var(--dsw-alias-label-secondary)', lineHeight: '20px' } },
              '莉娅 DSH 皮肤插件：壁纸 + 莉娅星月皮肤层。壁纸走 tapIndex 注入（wallpapers/ 目录图 + 透明度滑条 + host 持久化）；皮肤层为纯客户端装饰（自绘星月 SVG，作用域 body[data-dsh-liya-skin]，卸载全还原）。配置暂不可用。'
            ),
            react.createElement('p', { style: { margin: '0 0 8px', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', lineHeight: '18px' } },
              '换壁纸：把图片丢进 workspace/dsh-plugins/dsh-liya-skin/wallpapers/ 后到 设置 → 壁纸 点 🔃 刷新。'
            ),
            react.createElement('p', { style: { margin: 0, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', lineHeight: '16px', fontFamily: 'monospace' } },
              'debug: ' + JSON.stringify(diag)
            )
          );
        } else {
          content = [
            react.createElement('p', { key: 'desc', style: { margin: '0 0 4px', fontSize: 13, color: 'var(--dsw-alias-label-secondary)', lineHeight: '20px' } },
              '皮肤层开关（改完点保存即时生效；壁纸功能不受这些开关影响）：'),
            LIYA_SKIN_FIELDS.map(toggleRow),
            react.createElement('div', { key: 'footer', style: { display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 10, alignItems: 'center' } },
              failed ? react.createElement('p', { key: 'failed', role: 'status', style: { margin: '0 auto 0 0', fontSize: 12, color: 'var(--dsw-alias-state-danger-primary)' } }, '保存失败，请重试') : null,
              react.createElement('button', { type: 'button', onClick: onDiscard, disabled: !dirty || saving, style: LIYA_CARD_BTN }, '撤销'),
              react.createElement('button', { type: 'button', onClick: onSave, disabled: blocked, style: Object.assign({}, LIYA_CARD_BTN, { background: 'var(--dsw-alias-button-info-fill)', color: '#fff', borderColor: 'transparent' }) }, saving ? '保存中…' : '保存')
            )
          ];
        }
        body = react.createElement('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l2)', padding: '10px 12px' } }, content);
      }

      return react.createElement(
        'li',
        { style: { listStyle: 'none' } },
        react.createElement(
          'div',
          { style: { border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-3)', borderRadius: 10, overflow: 'hidden', minWidth: 0 } },
          titleRow,
          body
        )
      );
    }

    exports.inject = ['theme', 'slots'];
    exports.apply = function (ctx) {
      // 壁纸启动恢复：只应用、绝不写回 host（setWallpaper 会 POST，会把 host 状态冲成 off——
      // 2026-08-15 修复：启动时用 applyWallpaperState 纯应用，host 有状态再覆盖）
      applyWallpaperState(ctx, currentWallpaper(), currentOpacity());
      restoreFromHost(ctx);
      ctx.on('theme/change', function (snapshot) {
        var v = currentWallpaper();
        if (v && v !== 'off') syncWallpaperOverride(ctx, v, false, snapshot);
      });
      ctx.effect(function () {
        function onStorage(e) {
          if (e.key === WALLPAPER_KEY || e.key === WALLPAPER_OPACITY_KEY) {
            applyWallpaperToBody(currentWallpaper());
            syncWallpaperOverride(ctx, currentWallpaper());
          }
        }
        window.addEventListener('storage', onStorage);
        return function () {
          window.removeEventListener('storage', onStorage);
          disposeWallpaperOverride();
        };
      });

      // 莉娅星月皮肤层（v0.3.0+）：作用域 + 星月装饰 + 状态投影，effect 销毁器全还原。
      // 配置（settings 卡里改）变更 → 订阅重建皮肤层，即时生效。
      // 皮肤层配置 scope 在 apply 期绑定一次（卡与订阅共用，不在 React 渲染期 bind；
      // bind 每次都是新 controller，重复 bind 永远读 'loading'——2026-08-17 教训）
      var skinScopeBound = liyaConfigForm(ctx, 'dsh-liya-skin');
      var skinDisposer = null;
      function mountSkin() {
        if (skinDisposer) { try { skinDisposer(); } catch (e) {} skinDisposer = null; }
        try { skinDisposer = startLiyaSkin(ctx, skinScopeBound); } catch (e) { console.warn('[dsh-liya-skin] skin layer failed: ' + (e && e.message)); }
      }
      mountSkin();
      ctx.effect(function () {
        var off = null;
        var timer = null;
        var tries = 0;
        // configForms 由官方 ui-settings 的 client 半提供：apply 期没就绪就短轮询补挂，
        // 拿到真实配置后重挂一次（可能从默认值切到用户值）；全程不写 inject，避免 boot 卡 pending。
        function attach() {
          if (skinScopeBound === null) skinScopeBound = liyaConfigForm(ctx, 'dsh-liya-skin');
          if (skinScopeBound === null) {
            if (tries++ < 20) timer = setTimeout(attach, 250);
            return;
          }
          try { off = skinScopeBound.subscribe(function () { mountSkin(); }); } catch (e) { off = null; }
          mountSkin();
        }
        attach();
        return function () {
          if (off !== null) { try { off(); } catch (e) {} }
          if (timer !== null) clearTimeout(timer);
          if (skinDisposer) { try { skinDisposer(); } catch (e) {} skinDisposer = null; }
        };
      }, 'dsh-liya-skin: skin config subscription');

      var slots = ctx.get('slots');
      if (slots === undefined) return;
      slots.inject('settings.section', function () {
        return slots.register(
          {
            name: 'settings.section',
            id: 'liya-skin',
            order: 110,
            label: function () { return '壁纸'; }
          },
          function (props) { return WallpaperBlock(Object.assign({}, props, { ctx: ctx })); }
        );
      });
      // rc.2：`settings.plugin.item` 插槽已被官方移除（客户端插槽表里没有这个 key，
      // 注册会抛错并连累整个 client 条目激活）。配置卡改由官方「设置 → 插件」页从
      // 插件导出的 Config（volatile 字段）+ entry id 自动生成——不再注册自定义卡。
      // LiyaSkinCard 组件保留在本文件里（未注册），万一原生页不显示该条目时可改挂
      // `plugins.row.config`（keyed：`<包名>#<row id>`）复活。
    };

    module.exports = exports;
    return module.exports;
  }
});
