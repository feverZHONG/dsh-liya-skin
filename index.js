// 莉娅 DSH 皮肤插件 —— Host 半（ESM，函数形式）
// 功能：
//   1. webServer.tapIndex 向 index.html 注入壁纸层（body 背景 + 暗化层 + 启动脚本）
//   2. 路由 /liya-wallpaper/list —— 扫描 wallpapers/ 目录返回图片清单
//   3. 路由 /liya-wallpaper/file/<name> —— 按名返回图片文件（带路径穿越防护）
//   4. 路由 /liya-wallpaper/state —— 壁纸状态持久化（GET 读 / POST 写 $DSH_HOME/liya-wallpaper-state.json），
//      让壁纸选择像原生主题一样由 host 记住，换浏览器/重启都恢复（不依赖浏览器 localStorage）。
//   5. 设置 namespace `liya-skin` 注册（settings 服务 + schemastery schema）——皮肤层开关持久化，
//      client 半经 ctx.get('configForms') 读写（rc.2：配置页由官方插件页按 Config 自动生成）。
// 壁纸图源：本插件目录下的 wallpapers/（把自己的图丢进去即出现在设置里）。
// schemastery：junction 链接自资源目录 node_modules（workspace/dsh-plugins/node_modules/@deepseek-ai/schemastery），
// 解决 bundle 插件 link 目录向上解析不到依赖的问题（2026-08-16）。
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'

const PLUGIN_ROOT = fileURLToPath(new URL('.', import.meta.url))
const WALLPAPER_DIR = join(PLUGIN_ROOT, 'wallpapers')
const DSH_HOME = (typeof process !== 'undefined' && process.env && process.env.DSH_HOME) || join(homedir(), '.dsh')
const STATE_FILE = join(DSH_HOME, 'liya-wallpaper-state.json')

export const name = 'dsh-liya-skin'
export const inject = ['webServer', 'settings']

// ── 皮肤层配置（DSH 0.2.0-rc.2 原生姿势）
// rc.2 的 settings 服务不再有 register()：配置卡片 = 「插件导出的 Config」+「profile entry id 当
// namespace」（本插件 = dsh-liya-skin），由原生设置页自动生成；可写字段必须 .volatile()，
// 否则 describe() 里根本不出现该条目（客户端 configForms.get() 也拿不到表单）。
export const Config = Schema.object({
  skin: Schema.boolean().default(true).description('莉娅星月皮肤层总开关').volatile(),
  topTrim: Schema.boolean().default(true).description('顶部星带').volatile(),
  bottomTrim: Schema.boolean().default(true).description('底部星轨').volatile(),
  titlebarBrand: Schema.boolean().default(true).description('标题栏「莉娅」徽标').volatile(),
})

// volatile 配置值是 cosmokit 引用（.get() 取快照）；Symbol 判定跨 ESM/CJS 副本安全
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
function cfgValue(value, fallback) {
  if (value !== null && typeof value === 'object' && VOLATILE_WRITE in value) {
    try {
      const snap = value.get()
      return snap === undefined ? fallback : snap
    } catch {
      return fallback
    }
  }
  return value === undefined ? fallback : value
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'])
const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
}

// ── 壁纸启动脚本 + 样式（tapIndex 注入到 <body> 之后，仿 ui-theme 的 bootTheme 做法）
// 壁纸以图片为主、无预设：localStorage 里的值就是 wallpapers/ 下的文件名。
// 图片在 body::before 独立层，opacity 只作用于图片本身（滑条控制）；
// 暗化层在 body::after 固定，保证文字可读。
function wallpaperBootstrap() {
  return `<style>body::before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;background-image:var(--dsh-wallpaper,none);background-size:cover;background-position:center;background-attachment:fixed;opacity:var(--dsh-wallpaper-opacity,1)}body::after{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;background:var(--dsh-wallpaper-dim,rgba(0,0,0,0.35))}body:not([data-ds-dark-theme]){--dsh-wallpaper-dim:rgba(255,255,255,0.25)}<\/style><script>(()=>{
var OPACITY_KEY="dsh-liya-wallpaper-opacity";
function css(v){if(!v||v==="off"||/^gradient-/.test(v))return"none";return"url('/liya-wallpaper/file/"+encodeURIComponent(v)+"')"}
function opacity(){var o=100;try{o=parseInt(localStorage.getItem(OPACITY_KEY),10)}catch(e){}if(isNaN(o))o=100;return Math.max(0,Math.min(100,o))/100}
function apply(v){try{document.body.style.setProperty("--dsh-wallpaper",css(v));document.body.style.setProperty("--dsh-wallpaper-opacity",String(opacity()))}catch(e){}}
try{var _w=localStorage.getItem("dsh-liya-wallpaper")||"off";if(/^gradient-/.test(_w)){_w="off";localStorage.setItem("dsh-liya-wallpaper","off")}apply(_w)}catch(e){}
window.addEventListener("storage",function(e){if(e.key==="dsh-liya-wallpaper"||e.key===OPACITY_KEY){var v="off";try{v=localStorage.getItem("dsh-liya-wallpaper")||"off"}catch(e2){}apply(v)}});
})()<\/script>`
}

function injectAfterBody(html) {
  const body = /<body(?:\s[^>]*)?>/i.exec(html)
  const script = wallpaperBootstrap()
  if (body === null) return `${html}${script}`
  const at = body.index + body[0].length
  return `${html.slice(0, at)}${script}${html.slice(at)}`
}

// ── 壁纸清单：扫描 wallpapers/ 目录
function listWallpapers() {
  try {
    return readdirSync(WALLPAPER_DIR)
      .filter((n) => IMAGE_EXT.has(n.slice(n.lastIndexOf('.')).toLowerCase()))
      .map((n) => ({ name: n, url: `/liya-wallpaper/file/${encodeURIComponent(n)}` }))
  } catch {
    return []
  }
}

function serveWallpaper(rawName, res) {
  const name = decodeURIComponent(rawName)
  const safe = basename(name)
  if (safe !== name) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'invalid name' }))
    return
  }
  const file = join(WALLPAPER_DIR, safe)
  if (!file.startsWith(WALLPAPER_DIR)) {
    res.writeHead(403)
    res.end('forbidden')
    return
  }
  const ext = safe.slice(safe.lastIndexOf('.')).toLowerCase()
  if (!MIME[ext]) {
    res.writeHead(415)
    res.end('unsupported type')
    return
  }
  try {
    const data = readFileSync(file)
    res.writeHead(200, { 'content-type': MIME[ext], 'cache-control': 'public, max-age=3600' })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
}

// ── 壁纸状态持久化：$DSH_HOME/liya-wallpaper-state.json
function readState() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeState(state) {
  try {
    mkdirSync(DSH_HOME, { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8')
    return true
  } catch (e) {
    console.warn('[dsh-liya-skin] state write failed: ' + e.message)
    return false
  }
}

// 校验 + 归一：image 只能是 off 或 wallpapers/ 里的合法文件名；opacity 钳制 0-100
function sanitizeState(body) {
  const image = typeof body.image === 'string'
    ? (body.image === 'off' ? 'off' : basename(decodeURIComponent(body.image)))
    : 'off'
  const opacity = typeof body.opacity === 'number' && !Number.isNaN(body.opacity)
    ? Math.max(0, Math.min(100, Math.round(body.opacity)))
    : 100
  return { image, opacity }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

export function apply(ctx, config) {
  console.log('[dsh-liya-skin] plugin loaded (host half)')

  // 配置由 loader 注入（JSON 层 bootstrap-config + 用户改动合并）；每次读都取 volatile 快照
  const liveConfig = () => ({
    skin: cfgValue(config && config.skin, true),
    topTrim: cfgValue(config && config.topTrim, true),
    bottomTrim: cfgValue(config && config.bottomTrim, true),
    titlebarBrand: cfgValue(config && config.titlebarBrand, true),
  })
  console.log('[dsh-liya-skin] config: ' + JSON.stringify(liveConfig()))

  // 诊断路由（排障用）：当前配置 + settings.describe 里本插件条目是否可见。
  // 访问 http://127.0.0.1:<WebUI端口>/liya-skin-debug
  ctx.webServer.register({
    kind: 'prefix',
    path: '/liya-skin-debug',
    handler: async (req, res) => {
      const out = { config: liveConfig(), namespaces: [], entryServed: false }
      try {
        const desc = ctx.settings.describe({ redactSecrets: true })
        out.namespaces = (desc || []).map((d) => d.ns)
        out.entryServed = out.namespaces.includes('dsh-liya-skin')
      } catch (e) {
        out.describeError = String((e && e.message) || e)
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(out, null, 2))
    },
  })

  ctx.effect(
    () => ctx.webServer.tapIndex((html) => injectAfterBody(html)),
    'dsh-liya-skin: wallpaper bootstrap',
  )

  ctx.webServer.register({
    kind: 'prefix',
    path: '/liya-wallpaper',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      if (url.pathname === '/liya-wallpaper/list') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(listWallpapers()))
        return
      }
      if (url.pathname.startsWith('/liya-wallpaper/file/')) {
        const rawName = url.pathname.slice('/liya-wallpaper/file/'.length)
        serveWallpaper(rawName, res)
        return
      }
      if (url.pathname === '/liya-wallpaper/state') {
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(readState()))
          return
        }
        if (req.method === 'POST') {
          let body
          try {
            body = JSON.parse(await readBody(req))
          } catch {
            body = {}
          }
          const state = sanitizeState(body || {})
          writeState(state)
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, state }))
          return
        }
      }
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'not found' }))
    },
  })
  console.log('[dsh-liya-skin] wallpaper routes + tapIndex registered')
}
