/**
 * 浮窗 UI 静态回归（纯 node / 只做文本断言）。
 *
 * 起因：真机点验「抓到了图但应用并贴回点不动」，根因是 state.hasImage 从没被置 true，
 * 而按钮一直 disabled；纯算法与冒烟测试都发现不了，因为那是渲染层状态。
 * 这里把「抓图 → 有图 → 按钮可用」这条链路的关键文本固化住。
 */
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const html = fs.readFileSync(path.join(ROOT, 'ui', 'panel.html'), 'utf8')

// 1) 关键 DOM id 一个都不能少（渲染层所有行为靠它们取元素）
const REQUIRED_IDS = [
  'side', 'params', 'canvas-area', 'preview', 'overlay', 'empty',
  'btn-refresh', 'btn-inject', 'btn-whitelist', 'btn-grab', 'layer-list',
  'status-image', 'status-agent', 'zoom', 'zoom-label', 'btn-fit', 'toast',
  'btn-apply'
]
for (const id of REQUIRED_IDS) {
  assert.equal((html.match(new RegExp('id="' + id + '"', 'g')) || []).length, 1, `id="${id}" 应恰好出现 1 次`)
}

// 2) hasImage 链路：收到 image 必须置 true，清空必须置 false，且不能有任何地方裸写 disabled=false
assert.match(html, /case 'image':[^\n]*state\.hasImage=!!msg\.dataUrl/,
  "收到 image 消息时没有把 hasImage 置为 true，『应用并贴回』会永远禁用")
assert.match(html, /case 'cleared':[^\n]*state\.hasImage=false/,
  '清空画布时没有重置 hasImage')
assert.ok(!/btn-apply'\)\.disabled\s*=\s*false/.test(html),
  '发现裸写 btn-apply.disabled=false，会在没图时也放开按钮')
assert.match(html, /function syncApply\(\)/, '缺少 syncApply 统一同步按钮状态')

// 3) UI 方案 B 的自包含约束：无外链、蓝色已让位、最小字号达标
assert.ok(!/https?:\/\//.test(html), '浮窗 HTML 不应有外链资源')
assert.ok(!html.includes('#7aa2ff'), '强调色必须换掉旧的 #7aa2ff')
assert.ok(!/\bfont-size:\s*1[01]px/.test(html), '字号不应低于 11.5px')
assert.ok(html.includes('@media (prefers-color-scheme: light)'), '缺少系统浅色兜底')
assert.ok(html.includes('--accent: var(--fx-accent, #ff9a3c)'), '强调色应为橙子色 #ff9a3c')

// 4) 与 D-020 的 SOLO 分支兼容：单工具页仍隐藏图标栏
assert.ok(html.includes('__FX_SOLO') && html.includes('__FX_INITIAL_PAGE'), '单工具页钩子丢失')
assert.ok(html.includes("-webkit-app-region: drag"), '顶栏必须可拖拽（浮窗）')

console.log('panel-ui: 4 组断言通过')
