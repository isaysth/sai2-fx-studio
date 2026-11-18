/**
 * 独立插件冒烟测试（无第三方依赖）：node tests/smoke.js
 * 覆盖：清单/配置、工具面板装配、消息路由、UI 工具入口、缺失套件保护。
 */
'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const calls = []

// 用假模块替换启动桥，避免测试真的拉起 sai2_bridge.exe
const suitePath = require.resolve('../core/suite.js')
require.cache[suitePath] = {
  id: suitePath,
  filename: suitePath,
  loaded: true,
  exports: {
    bridgeExe: (dir) => path.join(dir, 'sai2_bridge.exe'),
    openPanel: async (dir, opts) => { calls.push({ dir, opts }); return { ok: true } }
  }
}

const plugin = require('../index.js')
const manifest = require('../plugin.json')
const fs = require('node:fs')

async function main() {
  // 版本号每升一次都改断言太容易漏，直接跟 package.json 对齐（两边同步 bump）
  assert.equal(manifest.version, require('../package.json').version, '清单版本应与 package.json 一致')
  for (const key of ['autoPaste', 'fullPanelElevated', 'autoInject']) {
    assert.ok(plugin.configSchema[key], `配置缺少 ${key}`)
  }

  const toolbar = []
  const files = []
  const pages = []
  const statuses = []
  let onMessage = null
  const ctx = {
    log: { info() {}, warn() {}, error() {} },
    setStatus: (text) => statuses.push(text),
    dialog: { error() {} },
    addToolbarAction: (a) => toolbar.push(a),
    addFileAction: (a) => files.push(a),
    addPage: (p) => pages.push(p),
    windows: {
      open: (opts) => { onMessage = opts.onMessage; return { ok: true } },
      post() {},
      close() {}
    },
    effect() {}
  }
  plugin.apply(ctx, { version: manifest.version, autoInject: false })

  const suiteAction = toolbar.find((a) => a.id === 'suite-open')
  const windowAction = toolbar.find((a) => a.id === 'fx-open-panel')
  assert.ok(suiteAction, '缺少工具栏动作：SAI2 工具面板')
  assert.ok(windowAction, '缺少工具栏动作：打开浮窗')
  assert.equal(suiteAction.label, 'SAI2 工具面板')

  // 主操作只剩三条（其余入口在侧栏页面 / 管理页）
  for (const id of ['fx-launch-pair', 'suite-open', 'fx-open-panel']) {
    assert.ok(toolbar.some((a) => a.id === id), `缺少主工具栏动作：${id}`)
  }
  assert.ok(!toolbar.some((a) => a.id === 'fx-open'), '旧的重名浮窗动作 fx-open 应已移除')

  // 侧栏工具页：5 个独立入口 + 管理页，共 6 个 addPage（D-020 / N-029）
  const expectedPages = [
    ['fx-blur', '模糊'], ['fx-adjust', '调整'], ['fx-filter', '滤镜'],
    ['fx-liquify', '液化'], ['fx-selection', '选区']
  ]
  for (const [id, title] of expectedPages) {
    const page = pages.find((p) => p.id === id)
    assert.ok(page, `缺少侧栏工具页：${id}`)
    assert.equal(page.title, title, `${id} 的标题应为 ${title}`)
    assert.ok(page.html.includes("window.__FX_INITIAL_PAGE='" + id.replace('fx-', '') + "'"),
      `${id} 的页面应注入对应的 __FX_INITIAL_PAGE`)
    assert.ok(page.html.includes('window.__FX_SOLO=1'), `${id} 应注入 __FX_SOLO`)
  }
  assert.ok(pages.some((p) => p.id === 'manage'), '缺少管理页 manage')
  assert.equal(pages.length, 6, '共应有 6 个页面（管理页 + 5 工具页）')

  windowAction.run()
  assert.equal(typeof onMessage, 'function', '轻量浮窗应注册消息处理器')

  await suiteAction.run()
  assert.equal(calls.length, 1, '点击工具面板应启动一次上游面板')
  assert.ok(fs.existsSync(calls[0].dir), '应使用随包套件目录')

  onMessage({ type: 'openSuitePanel', tool: 'Lab 取色器' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 2, '浮窗工具菜单应能启动完整面板')
  assert.ok(statuses.some((s) => s.includes('Lab 取色器')), '状态应回显所点工具')

  const html = fs.readFileSync(path.join(ROOT, 'ui', 'panel.html'), 'utf8')
  for (const tool of ['笔刷导入', '画布盖印', '穿透橡皮', '历史记录', '统计',
    'Lab 取色器', '三角色盘', '渐变换色', '动作', '外观与快捷键', '缩时摄影']) {
    assert.ok(html.includes(tool), `浮窗工具菜单缺少 ${tool}`)
  }
  for (const id of ['status-image', 'status-agent', 'zoom', 'btn-fit', 'btn-apply-clip', 'auto-paste',
    'curve', 'gradient', 'lab-plane', 'triad', 'history-list', 'action-list', 'filter-grid', 'overlay']) {
    assert.ok(html.includes(`id="${id}"`), `浮窗缺少控件或工具 ${id}`)
  }
  for (const page of ['liquify', 'blur', 'filter', 'adjust', 'selection', 'tools']) {
    assert.ok(html.includes(`data-page="${page}"`), `缺少功能页 ${page}`)
  }

  // 滤镜列表应来自我们自己的算法引擎
  const filters = require('../algorithms/filters.js')
  assert.ok(filters.FILTER_LIST && filters.FILTER_LIST.length >= 53, 'FILTER_LIST 至少 53 项')
  const indexSrc = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8')
  for (const msg of ['liquifyStroke', 'selection', 'colorPlane', 'actionReplay', 'historyRevert']) {
    assert.ok(indexSrc.includes(`'${msg}'`), `消息路由缺少 ${msg}`)
  }

  // 缺失套件时不能崩溃，也不能启动进程（重新加载真实模块）
  const realPath = require.resolve(path.join(ROOT, 'core', 'suite.js'))
  delete require.cache[realPath]
  const realSuite = require(realPath)
  const missing = await realSuite.openPanel(path.join(ROOT, '__not_exist__'))
  assert.equal(missing.ok, false)

  console.log('smoke: 8 组断言通过')
}

main().catch((err) => { console.error(err); process.exitCode = 1 })
