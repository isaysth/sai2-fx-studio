/**
 * 管理面板静态一致性检查（纯 node，不 require index.js——它会加载 electron 相关模块）：
 * node tests/manage-panel.test.js
 *
 * 面板按钮只发动作 id，拼错了工作台会回「动作不存在」，界面看着正常却点了没反应。
 * 这里把 index.js 的注册表和 ui/manage.html 里引用的 id 对齐，防止两边漂移。
 */
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const indexSrc = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8')
const htmlPath = path.join(ROOT, 'ui', 'manage.html')

// 1) 面板文件必须存在且接了页面动作桥
assert.ok(fs.existsSync(htmlPath), '缺少 ui/manage.html')
const html = fs.readFileSync(htmlPath, 'utf8')
assert.ok(html.includes('__sai2Page'), '面板没有使用 __sai2Page 动作桥')
assert.ok(html.includes('{{VERSION}}'), '面板缺少版本占位符 {{VERSION}}')
assert.ok(html.includes('{{STATUS}}'), '面板缺少状态占位符 {{STATUS}}')

// 2) index.js 注册的工具栏动作 id
const registered = new Set()
for (const m of indexSrc.matchAll(/addToolbarAction\(\s*\{\s*id:\s*'([^']+)'/g)) registered.add(m[1])

// 3) 面板里按钮要发的动作 id（ACTIONS 表的 id 字段）
const panelIds = []
for (const m of html.matchAll(/\bid:\s*'([^']+)'/g)) panelIds.push(m[1])

// 4) 面板引用的每个 id 都必须已注册
for (const id of panelIds) {
  assert.ok(registered.has(id), `面板引用了未注册的动作 id：${id}`)
}

// 版本号替换后会变成形如 0.3.0，面板里不该留下绝对路径或外部资源
assert.ok(!hasDrivePath(html), '面板里出现了本机绝对路径')
assert.ok(!/<script\s[^>]*\bsrc\s*=/i.test(html), '面板不能外链脚本')
assert.ok(!/<link\s[^>]*\bhref\s*=/i.test(html), '面板不能外链样式')
assert.ok(!/https?:\/\//i.test(html), '面板不能引 CDN 或远程资源')

// 5) 数量与内容一致：面板按钮覆盖的 id 集合 = 这里登记的预期集合
const required = ['fx-launch-pair', 'fx-launch-sai2', 'fx-open-panel', 'fx-open-dir']
for (const id of required) {
  assert.ok(registered.has(id), `index.js 缺少动作注册：${id}`)
}
for (const id of [...required, 'fx-connect', 'suite-open']) {
  assert.ok(panelIds.includes(id), `面板缺少按钮：${id}`)
}

const unique = new Set(panelIds)
assert.equal(unique.size, panelIds.length, '面板动作 id 有重复')
assert.equal(unique.size, required.length + 2, '面板按钮数量应为 4 个必需动作 + 连接注入器 + 完整工具面板')
assert.deepEqual(
  [...unique].sort(),
  [...required, 'fx-connect', 'suite-open'].sort(),
  '面板动作 id 与预期集合不一致'
)

// 动作 id 还要满足工作台的字符集与长度限制（plugin-page-bridge.ts）
for (const id of panelIds) {
  assert.ok(/^[A-Za-z0-9_.:-]+$/.test(id), `动作 id 含非法字符：${id}`)
  assert.ok(id.length <= 200, `动作 id 过长：${id}`)
}

// 一键联动必须等 SAI2 起来再开浮窗（否则注入打空）
assert.ok(/PAIR_DELAY_MS\s*=\s*1500/.test(indexSrc), '一键联动缺少 1500ms 等待')
assert.ok(indexSrc.includes("ctx.get('openers')"), '启动 SAI2 应复用 openers 服务')
assert.ok(indexSrc.includes("'opener-sai2'"), '启动 SAI2 应使用 opener-sai2 打开器')

function hasDrivePath(text) {
  return /[A-Za-z]:[\\/]/.test(text)
}

console.log('manage-panel: 6 组断言通过')
