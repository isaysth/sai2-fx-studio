/**
 * SAI2 特效工坊（SAI2 FX Studio）—— sai2工作台官方功能插件入口。
 *
 * 装配：命名管道 agent + 核心引擎 + 移植算法 + 剪贴板/桌面桥 + 浮窗。
 * 全部逻辑在主进程（CJS），浮窗只发消息，不碰 Node。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const agent = require('./core/agent.js')
const { ImageBuffer } = require('./core/image.js')
const { Session } = require('./core/session.js')
const blur = require('./algorithms/blur.js')
const adjust = require('./algorithms/adjust.js')
const filters = require('./algorithms/filters.js')
const { LiquifySession } = require('./algorithms/liquify.js')
const clip = require('./core/clipboard.js')
const clipWin = require('./core/clipboard-win.js')
const desktop = require('./core/desktop.js')
const suite = require('./core/suite.js')
const { Selection } = require('./core/selection.js')
const color = require('./core/color.js')
const { History } = require('./core/history.js')
const { ActionRecorder } = require('./core/actions.js')
const { FILTER_LIST } = require('./algorithms/filters.js')

const PLUGIN_ID = 'sai2-fx-studio'
const PREVIEW_MAX_DIM = 900

// 面板上展示的版本号：apply 的 config 里没有 version，优先读清单
let PLUGIN_VERSION = '0.0.0'
try { PLUGIN_VERSION = require('./plugin.json').version || PLUGIN_VERSION } catch { /* 清单缺失时退回首版号 */ }

function apply(ctx, config) {
  const log = ctx.log
  const session = new Session({ previewMaxDim: PREVIEW_MAX_DIM })
  let liquify = null // 当前液化会话（全分辨率位移场）
  let lastPreview = null // 上一次预览结果（应用时用）
  let windowOpen = false
  let selection = null // 当前选区掩码（core/selection.js）
  let selectionSize = null
  const history = new History(50) // UI 可见历史（Session 自身另有撤销栈）
  let actions = new ActionRecorder()
  const stats = { ops: 0, strokes: 0, undos: 0 }
  let recording = false
  const appearance = { accent: '#7aa2ff', fontScale: 1, hotkeys: 'Ctrl+Alt' }

  // ---- 配置：默认使用随包附带的上游套件，也允许换成自定义目录 ----
  const BUNDLED_SUITE = path.join(__dirname, 'vendor', 'sai2-plugin-suite')
  let injecting = null

  function suiteDir() {
    const configured = String(config.suiteDir || '').trim()
    if (!configured) return BUNDLED_SUITE
    return path.isAbsolute(configured) ? configured : path.resolve(__dirname, configured)
  }
  function isBundled() {
    return path.resolve(suiteDir()) === path.resolve(BUNDLED_SUITE)
  }
  function injectorExe() {
    return path.join(suiteDir(), 'sai2_injector.exe')
  }
  function whitelistBat() {
    return path.join(suiteDir(), '添加白名单.bat')
  }
  function checkSuite() {
    const dir = suiteDir()
    const exe = injectorExe()
    const dll = path.join(dir, 'sai2_agent.dll')
    if (!fs.existsSync(exe) || !fs.existsSync(dll)) {
      ctx.setStatus(isBundled() ? '内置套件文件缺失，请重新安装插件' : '套件目录缺少注入器，请重新选择', 'error')
      return false
    }
    ctx.setStatus(suiteStatusLabel(), 'ok')
    return true
  }

  /**
   * 确保注入器在线：先 ping；离线则运行随包注入器，再短轮询等待管道。
   * 并发调用共用同一个 Promise，避免连点「连接注入」启动多个注入器。
   */
  function ensureInjected(force = false) {
    if (injecting) return injecting
    injecting = (async () => {
      if (!force) {
        try {
          const p = await agent.ping({ budgetMs: 400 })
          if (p.ok) return { ok: true, already: true }
        } catch { /* 离线，继续注入 */ }
      }
      if (!checkSuite()) return { ok: false, error: '套件不可用' }
      const r = await desktop.runInjector(injectorExe(), 'inject')
      if (!r.ok) {
        ctx.setStatus('自动注入失败：' + r.error, 'warn')
        return r
      }
      for (let i = 0; i < 16; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        try {
          const p = await agent.ping({ budgetMs: 300 })
          if (p.ok) {
            ctx.setStatus('已自动连接注入器', 'ok')
            return { ok: true }
          }
        } catch { /* 管道还没起来 */ }
      }
      ctx.setStatus('注入器已启动但未连接，请检查白名单与权限', 'warn')
      return { ok: true, pending: true }
    })().finally(() => { injecting = null })
    return injecting
  }

  async function addWhitelist() {
    if (!checkSuite()) return false
    const bat = whitelistBat()
    if (!fs.existsSync(bat)) {
      ctx.setStatus('随包未找到「添加白名单.bat」', 'warn')
      return false
    }
    try {
      const ok = await desktop.runElevated(bat, suiteDir())
      ctx.setStatus(ok ? '白名单脚本已运行（请重新注入）' : '白名单脚本未确认完成', ok ? 'ok' : 'warn')
      return ok
    } catch (err) {
      ctx.setStatus('运行白名单脚本取消或失败：' + err.message, 'warn')
      return false
    }
  }

  /**
   * 打开随包的完整工具面板（上游 sai2_bridge.exe）。
   * 截图里的「工具 ▾」全部条目都在这里：笔刷导入、画布盖印、穿透橡皮、
   * 历史记录、统计、黑白监看、Lab 取色器、三角色盘、动作、外观与快捷键、
   * 缩时摄影等。上游二进制原样分发，本插件只负责启动与注入准备。
   */
  async function openSuitePanel(tool) {
    if (!checkSuite()) return false
    const dir = suiteDir()
    const exe = suite.bridgeExe(dir)
    if (!fs.existsSync(exe)) {
      ctx.setStatus('套件缺少 sai2_bridge.exe，请重新安装插件', 'error')
      return false
    }
    if (config.autoInject !== false) await ensureInjected()
    const r = await suite.openPanel(dir, { elevated: config.fullPanelElevated === true })
    if (r.ok) {
      const hint = tool ? `「${tool}」请在面板右下角「工具 ▾」中打开` : '工具 ▾ 里可用全部功能'
      ctx.setStatus('完整工具面板已启动 · ' + hint, 'ok')
      toast('完整工具面板已启动：' + hint)
    } else {
      ctx.setStatus('打开完整工具面板失败：' + r.error, 'warn')
      toast('打开失败：' + r.error)
    }
    return r.ok
  }

  // ---- agent 通信 ----
  function agentOpts(budget = 1500) {
    return { budgetMs: budget }
  }
  async function refreshLayers() {
    try {
      const r = await agent.queryLayers(agentOpts(1200))
      const layers = r.ok ? r.rows : []
      post({ type: 'layers', ok: r.ok, layers })
      if (!r.ok) ctx.setStatus('未连接注入器（点「连接注入」或检查白名单）', 'warn')
      else ctx.setStatus('SAI2 特效工坊就绪', 'ok')
      return layers
    } catch (err) {
      post({ type: 'layers', ok: false, layers: [] })
      ctx.setStatus('注入器离线：' + err.message, 'warn')
      return []
    }
  }

  // ---- 浮窗消息通道 ----
  function post(message) {
    if (ctx.windows) ctx.windows.post(message)
  }
  function toast(text) {
    post({ type: 'status', text })
  }

  // ---- 选区 / 历史 / 统计 / 色彩工具（原创引擎） ----
  function resolveMask(params) {
    if (!params || params.mask !== true) return params
    const out = Object.assign({}, params)
    if (selection && session.hasImage()) {
      const w = session.fullBase().width
      const h = session.fullBase().height
      if (!selectionSize || selectionSize.w !== w || selectionSize.h !== h) {
        selection = new Selection(w, h)
        selectionSize = { w, h }
      }
      out.mask = selection.mask()
    } else {
      out.mask = null
    }
    return out
  }
  function postMask() {
    if (!selection || !selectionSize || !session.hasImage()) { post({ type: 'mask', dataUrl: null }); return }
    const w = selectionSize.w
    const h = selectionSize.h
    const img = new (require('./core/image.js').ImageBuffer)(w, h)
    const m = selection.mask()
    for (let i = 0; i < w * h; i += 1) {
      img.data[i * 4] = 255; img.data[i * 4 + 1] = 255; img.data[i * 4 + 2] = 255
      img.data[i * 4 + 3] = m[i]
    }
    post({ type: 'mask', dataUrl: 'data:image/png;base64,' + Buffer.from(encodePNG(img)).toString('base64') })
  }
  function postHistory() { post({ type: 'history', list: history.list() }) }
  function postStats() { post({ type: 'stats', stats }) }
  function postActions() { post({ type: 'actions', list: actions.steps().map((s) => s.label || ((s.page || s.tab || '效果') + ' · ' + s.effect)) }) }

  function sampleImage(size = 64) {
    const { ImageBuffer } = require('./core/image.js')
    const img = new ImageBuffer(size, size)
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = (y * size + x) * 4
        const stripe = Math.sin((x + y) / 5) * 0.5 + 0.5
        const circle = Math.hypot(x - size / 2, y - size / 2) < size / 4 ? 1 : 0
        img.data[i] = Math.min(255, x / size * 200 + stripe * 55 + circle * 40)
        img.data[i + 1] = Math.min(255, y / size * 180 + stripe * 60 + circle * 30)
        img.data[i + 2] = Math.min(255, 120 + stripe * 100 + circle * 20)
        img.data[i + 3] = 255
      }
    }
    return img
  }
  function filterThumb(id) {
    const meta = FILTER_LIST.find((f) => f.id === id)
    const src = sampleImage(64)
    const out = filters.apply(src, id, meta ? (meta.defaultParams || {}) : {})
    return 'data:image/png;base64,' + Buffer.from(encodePNG(out)).toString('base64')
  }
  function labPlane(L, w, h) {
    const { ImageBuffer } = require('./core/image.js')
    const img = new ImageBuffer(w, h)
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const rgb = color.labToRgb([L, (x / w - 0.5) * 200, (y / h - 0.5) * 200])
        const i = (y * w + x) * 4
        img.data[i] = Math.max(0, Math.min(255, rgb[0]))
        img.data[i + 1] = Math.max(0, Math.min(255, rgb[1]))
        img.data[i + 2] = Math.max(0, Math.min(255, rgb[2]))
        img.data[i + 3] = 255
      }
    }
    return 'data:image/png;base64,' + Buffer.from(encodePNG(img)).toString('base64')
  }

  // 选中图层：记录行信息（真正的抓取在 grab 里按屏幕坐标点选）
  async function selectLayer(payload) {
    const row = payload && payload.row
    if (!row) return
    state.selectedRow = row
    toast('已选图层：' + row.text + '（点「抓取当前图层」获取内容）')
  }
  const state = { selectedRow: null }

  // ---- 抓图：聚焦 SAI2 → 点图层行 → Ctrl+A/C → 读 DIBV5 ----
  async function grab() {
    try {
      // 若选了图层行，先按屏幕坐标点一下选中它（上游：点行 = 选中该层）
      if (state.selectedRow && typeof state.selectedRow.screenX === 'number') {
        await desktop.clickAt(state.selectedRow.screenX, state.selectedRow.screenY)
      }
      await desktop.grabLayer()
      const dib = await clipWin.readDIBV5()
      if (!dib) {
        toast('剪贴板里没有位图，请确认 SAI2 已复制图层')
        return
      }
      const image = clip.decodeDIBV5(dib)
      if (!image) {
        toast('剪贴板位图格式无法识别')
        return
      }
      session.setImage(image)
      history.clear()
      selection = null
      selectionSize = null
      postHistory(); postMask()
      // 液化位移场按全分辨率重建
      liquify = new LiquifySession(image.width, image.height)
      lastPreview = null
      post({ type: 'image', dataUrl: imageToDataUrl(image) })
      post({ type: 'grabbed', width: image.width, height: image.height })
      toast(`已抓取 ${image.width}×${image.height}`)
    } catch (err) {
      log.error(`${PLUGIN_ID} 抓图失败：${err.message}`)
      toast('抓图失败：' + err.message)
    }
  }

  // ---- 预览：在降采样图上跑当前效果 ----
  async function preview(message) {
    if (!session.hasImage()) { toast('请先抓取图层'); return }
    try {
      const tab = message.page || message.tab
      const effect = message.effect
      const params = resolveMask(message.params || {})
      let result
      if (tab === 'liquify') {
        // 液化：位移场是全分辨率，render 会按比例采样降采样基准
        result = liquify ? liquify.render(session.previewBase()) : session.previewBase().clone()
      } else if (tab === 'blur') {
        result = blur.blur(session.previewBase(), effect, params)
      } else if (tab === 'adjust') {
        result = adjust.apply(session.previewBase(), effect, params)
      } else if (tab === 'filter') {
        result = filters.apply(session.previewBase(), effect, params)
      } else {
        result = session.previewBase().clone()
      }
      lastPreview = { tab, effect, params, image: result }
      post({ type: 'image', dataUrl: imageToDataUrl(result) })
    } catch (err) {
      log.error(`${PLUGIN_ID} 预览失败：${err.message}`)
      toast('预览失败：' + err.message)
    }
  }

  // ---- 应用：把预览效果按全分辨率重算 → 写剪贴板 → 贴回 ----
  async function applyEffect(message) {
    if (!session.hasImage()) { toast('请先抓取图层'); return }
    try {
      const tab = message.page || message.tab
      const effect = message.effect
      const params = resolveMask(message.params || {})
      const full = session.fullBase()
      let result
      if (tab === 'liquify') {
        // 液化位移场已在全分辨率累积，直接渲染全图
        result = liquify ? liquify.render(full) : full.clone()
      } else if (tab === 'blur') {
        result = blur.blur(full, effect, params)
      } else if (tab === 'adjust') {
        result = adjust.apply(full, effect, params)
      } else if (tab === 'filter') {
        result = filters.apply(full, effect, params)
      } else {
        result = full.clone()
      }

      // 画布补边：抓到的是图层包围盒，需补到 .sai2 精确画布尺寸并放回原偏移。
      // 目前用「抓到多大贴多大」的保守策略（包围盒直接回贴），
      // 精确补边需要 agent 的 canvas.arm/state/save 协议，列为后续增强。
      const dib = clip.encodeDIBV5(result)
      await clipWin.writeDIBV5(dib)
      session.apply(result, effect)
      history.push({ label: (tab || '效果') + ' · ' + effect, image: result })
      stats.ops += 1
      postHistory(); postStats()
      if (recording) {
        actions.record((tab || '效果') + ' · ' + effect, { page: tab, effect, params: params })
        postActions()
      }
      if (tab === 'liquify') liquify = new LiquifySession(full.width, full.height)
      // 「应用 → 剪贴板」只写剪贴板；「应用并贴回」才切回 SAI2 粘贴。
      const shouldPaste = message && Object.prototype.hasOwnProperty.call(message, 'paste')
        ? !!message.paste
        : config.autoPaste !== false
      if (shouldPaste) await desktop.pasteBack()
      post({ type: 'image', dataUrl: imageToDataUrl(result) })
      toast(shouldPaste ? '已应用并贴回 SAI2' : '已写入剪贴板（未贴回 SAI2）')
    } catch (err) {
      log.error(`${PLUGIN_ID} 应用失败：${err.message}`)
      toast('应用失败：' + err.message)
    }
  }

  function undo() {
    if (session.undo()) {
      history.undo()
      stats.undos += 1
      post({ type: 'image', dataUrl: imageToDataUrl(session.applied) })
      postHistory(); postStats()
      toast('已撤销')
    } else toast('没有可撤销的操作')
  }
  function redo() {
    const entry = history.redo()
    if (!entry || !entry.image) { toast('没有可重做的操作'); return }
    session.setImage(entry.image)
    post({ type: 'image', dataUrl: imageToDataUrl(session.applied) })
    postHistory()
    toast('已重做')
  }
  function revertTo(index) {
    const entry = history.revertTo(index)
    if (!entry || !entry.image) { toast('该历史步骤不可用'); return }
    session.setImage(entry.image)
    liquify = new LiquifySession(session.applied.width, session.applied.height)
    post({ type: 'image', dataUrl: imageToDataUrl(session.applied) })
    postHistory()
    toast('已回到：' + entry.label)
  }
  function reset() {
    if (!session.hasImage()) return
    session.reset()
    liquify = new LiquifySession(session.applied.width, session.applied.height)
    history.clear()
    post({ type: 'image', dataUrl: imageToDataUrl(session.applied) })
    postHistory()
    toast('已复位到抓取时的原图')
  }

  // ---- 位图 → data URL（浮窗 canvas 显示） ----
  function imageToDataUrl(image) {
    // 缩到预览尺寸以内再编码，避免大 base64 经 IPC 拖慢
    const view = image.downsample(1200)
    const png = encodePNG(view)
    return 'data:image/png;base64,' + Buffer.from(png).toString('base64')
  }

  /** 极简 PNG 编码（无依赖）：用 zlib 压缩 raw scanline */
  function encodePNG(image) {
    const zlib = require('node:zlib')
    const { width, height } = image
    const raw = Buffer.alloc((width * 4 + 1) * height)
    for (let y = 0; y < height; y += 1) {
      const rowStart = y * (width * 4 + 1)
      raw[rowStart] = 0 // filter none
      for (let x = 0; x < width; x += 1) {
        const si = (y * width + x) * 4
        const di = rowStart + 1 + x * 4
        raw[di] = image.data[si]
        raw[di + 1] = image.data[si + 1]
        raw[di + 2] = image.data[si + 2]
        raw[di + 3] = image.data[si + 3]
      }
    }
    const idat = zlib.deflateSync(raw)
    const chunks = []
    function chunk(type, data) {
      const len = Buffer.alloc(4)
      len.writeUInt32BE(data.length, 0)
      const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
      const crc = Buffer.alloc(4)
      crc.writeUInt32BE(crc32(body) >>> 0, 0)
      chunks.push(len, body, crc)
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(width, 0)
    ihdr.writeUInt32BE(height, 4)
    ihdr[8] = 8 // bit depth
    ihdr[9] = 6 // RGBA
    chunk('IHDR', ihdr)
    chunk('IDAT', idat)
    chunk('IEND', Buffer.alloc(0))
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks])
  }

  let crcTable = null
  function crc32(buf) {
    if (!crcTable) {
      crcTable = []
      for (let n = 0; n < 256; n += 1) {
        let c = n
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        crcTable[n] = c >>> 0
      }
    }
    let c = 0xffffffff
    for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return c ^ 0xffffffff
  }

  // ---- 浮窗打开 / 消息路由 ----
  function openWindow(file) {
    if (!ctx.windows) { ctx.dialog.error('当前工作台版本不支持插件浮窗，请升级 sai2工作台'); return }
    const entry = path.join(__dirname, 'ui', 'panel.html')
    if (!fs.existsSync(entry)) { ctx.dialog.error('找不到浮窗界面文件：' + entry); return }
    const r = ctx.windows.open({
      entry: 'ui/panel.html',
      title: 'SAI2 特效工坊',
      width: 1000,
      height: 680,
      onMessage: handleWindowMessage
    })
    if (!r.ok) { ctx.dialog.error('打开浮窗失败：' + r.error); return }
    windowOpen = true
    checkSuite()
    if (config.autoInject !== false) {
      void ensureInjected().then(() => refreshLayers())
    } else {
      void refreshLayers()
    }
    if (file) toast('已选择文件：' + file + '（请在 SAI2 中打开后抓取）')
  }

  // ---- 管理面板：启动 SAI2 / 一键联动（页面动作桥，见工作台 D-012）----
  const MANAGE_PAGE_ID = 'manage'
  const PAIR_DELAY_MS = 1500 // SAI2 启动需要时间，太早开浮窗注入会打空

  function suiteStatusLabel() {
    return isBundled() ? '内置套件就绪（v1.64.0）' : '自定义套件就绪'
  }

  /** 面板「套件状态」卡片的初值：只读文件，不重复上报状态 */
  function panelStatusText() {
    try {
      return fs.existsSync(injectorExe()) ? suiteStatusLabel() : '套件文件缺失'
    } catch { return '未知' }
  }

  /**
   * 侧栏单工具页：直接复用浮窗 UI，只在 <head> 后注入一段启动脚本，
   * 让页面一打开就停在对应页签，并隐藏左侧 92px 导航。不改 HTML 结构。
   */
  const TOOL_PAGES = [
    { id: 'fx-blur', page: 'blur', title: '模糊' },
    { id: 'fx-adjust', page: 'adjust', title: '调整' },
    { id: 'fx-filter', page: 'filter', title: '滤镜' },
    { id: 'fx-liquify', page: 'liquify', title: '液化' },
    { id: 'fx-selection', page: 'selection', title: '选区' }
  ]

  /** 浮窗 UI 源码：apply 时读一次，5 个工具页共用（读不到返回 null） */
  function readPanelSource() {
    try {
      return fs.readFileSync(path.join(__dirname, 'ui', 'panel.html'), 'utf8')
    } catch (err) {
      log.warn(`${PLUGIN_ID} 读取浮窗界面失败：${err.message}`)
      return null
    }
  }

  /** 生成单工具页：注入 __FX_INITIAL_PAGE / __FX_SOLO，页面自己读取这两个全局量 */
  function panelHtml(pageKey) {
    if (!panelSource) return null
    const boot = `<script>window.__FX_INITIAL_PAGE='${pageKey}';window.__FX_SOLO=1</script>`
    return panelSource.replace('<head>', '<head>\n' + boot)
  }

  /** 读面板 HTML 并替换占位符；读不到返回 null（apply 时只读这一次） */
  function manageHtml() {
    const file = path.join(__dirname, 'ui', 'manage.html')
    try {
      return fs.readFileSync(file, 'utf8')
        .replace(/\{\{VERSION\}\}/g, String(config.version || PLUGIN_VERSION))
        .replace(/\{\{STATUS\}\}/g, panelStatusText())
    } catch (err) {
      ctx.setStatus('面板文件缺失', 'error')
      log.warn(`${PLUGIN_ID} 读取管理面板失败：${err.message}`)
      return null
    }
  }

  /** 只启动 SAI2。失败抛中文原因——工作台 runAction 会把抛出的 message 回执给面板 */
  async function launchSai2() {
    if (typeof ctx.get !== 'function') throw new Error('当前工作台版本不支持启动外部程序，请升级 sai2工作台')
    let openers
    try {
      openers = ctx.get('openers')
    } catch {
      // openers 插件被禁用时 ctx.get 会抛 MissingServiceError
      const text = '启动 SAI2 失败：打开器服务不可用，请在插件中心启用内置的 openers 插件'
      ctx.setStatus(text, 'warn')
      throw new Error(text)
    }
    let r
    try {
      r = await openers.launch(undefined, 'opener-sai2')
    } catch (err) {
      const text = '启动 SAI2 失败：' + err.message
      ctx.setStatus(text, 'warn')
      throw new Error(text)
    }
    if (!r || r.ok !== true) {
      const text = '启动 SAI2 失败：' + ((r && r.error) || '未知原因')
      ctx.setStatus(text, 'warn')
      throw new Error(text)
    }
    ctx.setStatus('已启动 SAI2', 'ok')
    return r
  }

  /** 一键联动：SAI2 起好之后再开浮窗（浮窗内部会自动注入） */
  async function launchPair() {
    await launchSai2()
    ctx.setStatus('已启动 SAI2，等待就绪…', 'ok')
    await new Promise((resolve) => setTimeout(resolve, PAIR_DELAY_MS))
    openWindow()
  }

  /** 面板上的「连接注入器」 */
  async function connectInjector() {
    const r = await ensureInjected()
    if (!r || !r.ok) throw new Error('连接注入器失败：' + ((r && r.error) || '套件不可用'))
    if (r.pending) throw new Error('注入器已启动但未连接，请检查白名单与管理员权限')
    ctx.setStatus(r.already ? '注入器已在线' : '已连接注入器', 'ok')
    return r
  }

  function openPluginDir() {
    if (!ctx.shell || typeof ctx.shell.openFolder !== 'function') {
      const text = '当前工作台版本不支持打开目录，请升级 sai2工作台'
      ctx.setStatus(text, 'warn')
      throw new Error(text)
    }
    return ctx.shell.openFolder(__dirname)
  }

  function handleWindowMessage(message) {
    if (!message || !message.type) return
    switch (message.type) {
      case 'close':
        if (ctx.windows) ctx.windows.close()
        windowOpen = false
        break
      case 'refreshLayers': void refreshLayers(); break
      case 'inject': void ensureInjected(true).then(() => refreshLayers()); break
      case 'whitelist': void addWhitelist(); break
      case 'grab': void grab(); break
      case 'selectLayer': void selectLayer(message); break
      case 'preview': void preview(message); break
      case 'apply': void applyEffect(message); break
      case 'undo': undo(); break
      case 'redo': redo(); break
      case 'historyRevert': revertTo(Number(message.index)); break
      case 'reset': reset(); break
      case 'openSuitePanel': void openSuitePanel(message.tool); break
      case 'param': break // 参数已随 preview/apply 消息带来
      case 'filterList':
        post({
          type: 'filterList',
          list: FILTER_LIST.map((f) => ({ id: f.id, name: f.name, group: f.group, defaultParams: f.defaultParams || {} }))
        })
        break
      case 'thumb': post({ type: 'thumb', id: message.id, dataUrl: filterThumb(message.id) }); break
      case 'color': {
        const v = message.value || []
        const rgb = message.from === 'lab' ? color.labToRgb(v)
          : message.from === 'hsv' ? color.hsvToRgb(v) : v
        post({ type: 'color', requestId: message.requestId, rgb, hex: color.rgbToHex(rgb) })
        break
      }
      case 'colorPlane':
        post({ type: 'colorPlane', requestId: message.requestId,
          dataUrl: labPlane(Number(message.L) || 60, Number(message.w) || 128, Number(message.h) || 128) })
        break
      case 'stats':
        if (message.reset) { stats.ops = 0; stats.strokes = 0; stats.undos = 0 }
        postStats()
        break
      case 'actionRecord': recording = !!message.on; toast(recording ? '动作录制已开始' : '动作录制已停止'); break
      case 'actionReplay':
        void (async () => {
          const steps = actions.steps()
          for (const item of steps) {
            const step = item.step || item
            await applyEffect({ page: step.page, effect: step.effect, params: step.params, paste: false })
          }
          toast(`已回放 ${steps.length} 步动作`)
        })()
        break
      case 'actionSave': {
        const file = path.join(ctx.dataDir || __dirname, 'actions.sai2act')
        try {
          fs.writeFileSync(file, JSON.stringify(actions.serialize(), null, 2))
          toast('动作已保存：' + file)
        } catch (err) { toast('保存失败：' + err.message) }
        break
      }
      case 'actionLoad': {
        const file = path.join(ctx.dataDir || __dirname, 'actions.sai2act')
        try {
          const loaded = ActionRecorder.load(JSON.parse(fs.readFileSync(file, 'utf8')))
          actions = loaded
          postActions()
          toast('动作已加载')
        } catch (err) { toast('加载失败：' + err.message) }
        break
      }
      case 'appearance':
        Object.assign(appearance, { accent: message.accent, fontScale: message.fontScale, hotkeys: message.hotkeys })
        break
      case 'liquifyStroke': {
        if (!session.hasImage() || !liquify) break
        const w = session.fullBase().width
        const h = session.fullBase().height
        const a = message.from || { x: 0, y: 0 }
        const b = message.to || a
        try {
          liquify.stroke(message.tool || 'forward',
            a.x * w, a.y * h, b.x * w, b.y * h,
            Number(message.radius) || 24, Number(message.amount) || 1, message.params || {})
          post({ type: 'image', dataUrl: imageToDataUrl(liquify.render(session.previewBase())) })
        } catch (err) { log.warn(`liquifyStroke: ${err.message}`) }
        break
      }
      case 'selection': {
        if (!session.hasImage()) break
        const w = session.fullBase().width
        const h = session.fullBase().height
        if (!selectionSize || selectionSize.w !== w || selectionSize.h !== h) {
          selection = new Selection(w, h); selectionSize = { w, h }
        }
        const pt = (p) => [p.x * w, p.y * h]
        const pts = (message.points || []).map(pt)
        try {
          switch (message.op) {
            case 'rect': {
              const a = pt(message.from || { x: 0, y: 0 })
              const b = pt(message.to || { x: 1, y: 1 })
              selection.rect(a[0], a[1], b[0] - a[0], b[1] - a[1]); break
            }
            case 'ellipse': {
              const a = pt(message.from || { x: 0, y: 0 })
              const b = pt(message.to || { x: 1, y: 1 })
              selection.ellipse((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.abs(b[0] - a[0]) / 2, Math.abs(b[1] - a[1]) / 2); break
            }
            case 'lasso': selection.lasso(pts); break
            case 'pen': selection.pen(pts); break
            case 'magicWand': {
              const p = pts[0] || pt({ x: 0, y: 0 })
              selection.magicWand(session.fullBase(), p[0], p[1], Number(message.tolerance) || 32); break
            }
            case 'feather': selection.feather(Number(message.radius) || 4); break
            case 'invert': selection.invert(); break
            case 'clear': selection.clear(); break
            default: break
          }
          postMask()
        } catch (err) { toast('选区操作失败：' + err.message) }
        break
      }
      default: break
    }
  }

  // ---- 注册贡献点 ----
  // 管理面板 + 5 个工具页：html 在此处读一次并注入版本/状态，之后不再读盘
  const managePage = manageHtml()
  const panelSource = readPanelSource()
  if (typeof ctx.addPage === 'function') {
    if (managePage) ctx.addPage({ id: MANAGE_PAGE_ID, title: '特效工坊', html: managePage })
    for (const tool of TOOL_PAGES) {
      const html = panelHtml(tool.page)
      if (html) ctx.addPage({ id: tool.id, title: tool.title, html })
      else log.warn(`${PLUGIN_ID} 生成工具页失败：${tool.id}`)
    }
  } else {
    ctx.setStatus('当前工作台版本不支持插件页面，请升级 sai2工作台', 'warn')
  }

  // 主操作只留 3 条：一键开始 / 完整工具面板 / 打开浮窗（D-020）。
  // 注意：工作台的插件页面按钮只能触发 addToolbarAction 注册过的 id
  // （渲染端 runAction('toolbar', id)），所以下面 3 条「管理页后端」仍须注册，
  // 否则 ui/manage.html 的按钮会回「动作不存在」。当前工作台不渲染工具栏动作列表，
  // 这些注册项不会出现在任何可见工具栏上。
  ctx.addToolbarAction({
    id: 'fx-launch-pair',
    label: '一键开始',
    run: () => launchPair()
  })
  ctx.addToolbarAction({
    id: 'suite-open',
    label: 'SAI2 工具面板',
    run: () => { void openSuitePanel() }
  })
  ctx.addToolbarAction({
    id: 'fx-open-panel',
    label: '打开浮窗',
    run: () => { openWindow() }
  })
  // 管理页后端动作：面板按钮发的 id 必须与这里完全一致（tests/manage-panel.test.js 校验）
  // run 返回 Promise，失败时抛错，工作台才能把 error 回执给面板
  ctx.addToolbarAction({
    id: 'fx-launch-sai2',
    label: 'FX：启动 SAI2',
    run: () => launchSai2()
  })
  ctx.addToolbarAction({
    id: 'fx-open-dir',
    label: 'FX：打开插件目录',
    run: () => openPluginDir()
  })
  ctx.addToolbarAction({
    id: 'fx-connect',
    label: 'FX：连接注入器',
    run: () => connectInjector()
  })
  ctx.addFileAction({
    id: 'fx-open-file',
    label: '用特效工坊处理',
    exts: ['.sai2', '.psd', '.png', '.jpg', '.jpeg', '.webp'],
    run: (payload) => {
      const file = typeof payload === 'string' ? payload : (payload && payload.path)
      openWindow(file)
    }
  })

  // 套件路径校验结果上报
  checkSuite()

  // 退出清理
  ctx.effect(() => {
    windowOpen = false
    liquify = null
    lastPreview = null
  })

  log.info(`${PLUGIN_ID} 已加载（v${config.version || '0.1.0'}）`)
}

module.exports = { apply, configSchema: require('./config-schema.js') }
