# dsh-liya-skin-plugin · 莉娅 DSH 皮肤插件

本地自建 DSH WebUI 皮肤插件，两块功能：
1. **壁纸**：以图片为主、无预设。`wallpapers/` 目录放图即用（缩略图选择、动态切换），
   图片透明度滑条（只作用于图片本身），半透明层颜色自动跟随当前皮肤（皮肤/壁纸正交）。
2. **莉娅星月皮肤层（v0.3.0）**：自绘星月 SVG 装饰——顶部星带 + 底部星轨 + 标题栏弯月徽标「莉娅」，
   与壁纸正交叠加，跟随侧栏宽度与对话状态响应式移动，卸载即完整还原。

> **v0.5.0（2026-10-02）适配 DSH 0.2.0-rc.2**：rc.2 移除了客户端 `settingsScope` 服务与 host 的
> `ctx.settings.register()`。配置改为「插件导出 `Config`（字段需 `.volatile()`）+ profile entry id 作
> namespace」+ 客户端 `ctx.get('configForms')`，配置项由原生「设置 → 插件」页自动生成；旧的自定义
> `settings.plugin.item` 卡随之退役。本版本起仅适配 rc.2 及以后。
>
> 皮肤说明：曾内置 Catppuccin 主题（Mocha/Latte），2026-08-15 起移除，只用 DSH 原生浅/深皮肤。

## 功能

| 功能 | 说明 |
|:-----|:-----|
| 壁纸图片 | `wallpapers/` 目录（png/jpg/webp/gif/svg），缩略图网格点选即动态切换 |
| 图片透明度 | 滑条 0-100（默认 100），置顶，**只作用于壁纸图片本身**（`body::before` opacity） |
| 刷新按钮 | 🔃 重拉 `/liya-wallpaper/list`，放新图不用重启 WebUI |
| 状态持久化 | 图片选择 + 透明度由 **host 记住**（`$DSH_HOME/liya-wallpaper-state.json`），换浏览器/重启都恢复 |
| 星月装饰 | 顶部星带（`liya-top-trim`）+ 底部星轨（`liya-bottom-trim`）+ 标题栏弯月徽标「莉娅」，自绘 SVG 无版权负担 |
| 状态投影 | `body[data-liya-chat-active]`（对话中，底部星轨退下）/ `body[data-liya-settings-open]`，CSS 响应 |
| 卸载还原 | effect 销毁器删除作用域属性、还原 style、移除装饰 DOM 与注入 CSS，外来节点一律不碰 |
| 配置项 | 设置 → 插件 → 本插件：皮肤层总开关 + 星带/星轨/徽标各自开关，保存即时生效（host 持久化；0.2.0-rc.2 起由原生插件页按插件 `Config` 自动生成） |

入口：设置 → 壁纸。

## 原理

### 壁纸（抄的官方 seam）

- **注入**：host 半 `webServer.tapIndex()` 往 index.html 的 `<body>` 后注入 `<style>` + `<script>`（官方 ui-theme 的 bootTheme 同款做法）。壁纸图放 `body::before`（`--dsh-wallpaper` + `--dsh-wallpaper-opacity`），暗化层放 `body::after`（`--dsh-wallpaper-dim`），都 `z-index:-1` 垫底
- **透出（皮肤/壁纸正交）**：壁纸开启时 client 半调 `theme.overrideTokens('liya-wallpaper', {...})` 给 `bg-base`/`bg-layer-1`/`bg-layer-2`/`sidebar-fill` 叠半透明层（固定 alpha 0.6）。**半透明色不写死**——运行时 `getComputedStyle` 读当前皮肤 token 值转 rgba，`theme/change`（换皮肤）时重算
- **持久化（v0.2.0 起 host 权威）**：client 每次切换/调滑条 `POST /liya-wallpaper/state` 写 `$DSH_HOME/liya-wallpaper-state.json`（host 侧 sanitize：文件名 basename 防穿越、opacity 钳制 0-100）；启动时 client `GET` 恢复并覆盖本地。localStorage 降级为瞬时缓存/无 host 兜底

### 莉娅星月皮肤层（抄 dsh-deep-whale/maid-atelier 架构，2026-08-16）

- **作用域**：`body[data-dsh-liya-skin]`，全部 CSS 挂作用域下（注入 `<style data-plugin-css='dsh-liya-skin/starlight.css'>`），卸载即删
- **装饰层**：`position:fixed` 星带/星轨，`translate: var(--liya-sidebar-width)` 跟随侧栏（ResizeObserver 写 CSSOM 规则，**不产生 attribute mutation** 避免观察死循环——抄作业的教训）；`pointer-events:none` + `aria-hidden` 完全不挡交互
- **标题栏品牌**：`[class*='titlebar']` 存在才装饰（普通标签页无 titlebar 时安全跳过），幂等 + 懒装饰（MutationObserver 发现 titlebar 出现再补）
- **状态投影**：`[data-phase='active'] [data-chat-flow]` → `data-liya-chat-active`（对话中底部星轨退下）；`[data-slot='sidebar.settings']` 展开 → `data-liya-settings-open`
- **卸载还原**：effect 销毁器删除作用域/投影属性、还原 `--liya-*` style 变量、移除 ownedNodes（装饰 DOM + CSS 标签 + 宽度规则）、disconnect 全部 observer——外来 DOM 一律不动
- **素材**：星/月/星轨 SVG 内嵌 client.js（data URI），与壁纸/皮肤色正交，明暗主题都可见
- **配置（v0.5.0，rc.2 原生姿势）**：host 半 `export const Config = Schema.object({skin/topTrim/bottomTrim/titlebarBrand})`（各字段 `.volatile()`）；
  client 半 `ctx.get('configForms').get('dsh-liya-skin')` 订阅，配置变更**重建皮肤层**（dispose 旧 → startLiyaSkin 重读配置）即时生效；总开关关闭时作用域/CSS/装饰全不注入（壁纸不受影响）

## 安装 / 打包

```powershell
# 安装（<dsh> 请替换为你安装的 DSH CLI 调用方式；装完重启才生效）
<dsh> plugin --profile <profile> add <本插件目录>

# 打包归档（npm 标准 tarball，可分发）
pnpm pack --pack-destination <产物目录>

# 卸载
<dsh> plugin --profile <profile> remove dsh-liya-skin-plugin
```

已安装后改源码**不用重装**（link 依赖，重启生效）。

> **壁纸素材自备**：仓库不含任何图片（`wallpapers/` 下的图不进版本库）。把自己的图
> （png/jpg/webp/gif/svg）丢进 `wallpapers/`，再在设置 → 壁纸里点 🔃 即可出现；
> 没有图时星月皮肤层照常工作。


## 已知边界

- 半透明层只改 4 个背景 token（固定 alpha 0.6），某些深层面板可能不透——想更透就把对应 token 加进 `WALLPAPER_TOKENS`（颜色自动跟随皮肤）
- 图片透明度滑条只作用于壁纸图片，不碰界面；暗化层固定保证文字可读
- 图片服务 `/liya-wallpaper/file/<name>` 有 basename + startsWith 双重防路径穿越
- 皮肤层装饰元素不遮挡交互（pointer-events none），但 z-index 20 层在少数全屏浮层下可能被盖住——不影响功能

## 姊妹仓库

同族的其它 DSH 插件（各一个独立仓库）：

- [dsh-liya-ui](https://github.com/feverZHONG/dsh-liya-ui) —— UI 润色：统一加大圆角，radius 可在原生设置页调（4–48）
- [dsh-character-emote](https://github.com/feverZHONG/dsh-character-emote) —— 角色立绘表情：多角色 + 流式情绪自动判定 + 拖拽缩放，素材自备
- [dsh-liya-workspace](https://github.com/feverZHONG/dsh-liya-workspace) —— 工作区档案速览：FILE-MAP 摘要 / memory·records·diary 统计 / 最近日记
- [dsh-liya-archives](https://github.com/feverZHONG/dsh-liya-archives) —— 归档会话抽屉：侧边栏「已归档 (n)」入口，一键恢复 / 复制为新会话 / 移回侧边栏
- [dsh-puzzle](https://github.com/feverZHONG/dsh-puzzle) —— 莉娅拼图：滑块拼图小游戏，agent 可发话 / 换图 / 看进度
- [dsh-chess-xq](https://github.com/feverZHONG/dsh-chess-xq) —— 天界象棋：中国象棋人机对战，可悔棋 / 存档 / 调难度
- [dsh-dist-manager](https://github.com/feverZHONG/dsh-dist-manager) —— 插件分发目录（dist/）管理：自动归档旧版本 + WebUI 管理页

## 许可

**双许可**——文档与代码分开：

- **代码**（`index.js`、`client.js` 与其它源文件）：**MIT** —— 拿去用、改、再发，保留版权声明即可。
- **文档**（本 README 的正文）：**[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)** —— 可以自由使用、改编、连商用都行，**但要署名**（莉娅 / [@feverZHONG](https://github.com/feverZHONG)）并注明来源。

两份许可的全文：`LICENSE`（MIT）／`LICENSE-DOCS`（CC BY 4.0）。

---

*莉娅（[@feverZHONG](https://github.com/feverZHONG)）· 宇宙美好记录官*
