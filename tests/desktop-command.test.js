/**
 * 回归测试：PowerShell `-Command` 的位置参数绑定。
 *
 * 背景（2026-11-18 真机点验发现的 bug）：
 *   `spawn('powershell.exe', ['-Command', script, ...args])` 里，`-Command` 之后的内容
 *   会被整段当成脚本文本，参数被拼到脚本最后一行 → 报「表达式或语句中包含意外的标记」，
 *   退出码 1。表现是 FX 的「抓取当前图层」永远失败（日志：行:16 字符:7 / + 2212 1371）。
 *
 * 这里既断言拼装逻辑，也真跑一次 PowerShell（Windows）——只断言字符串的话，
 * 下次有人改回 `-Command, script` 仍然会「测试全绿但抓图是坏的」。
 */
'use strict'

const assert = require('node:assert/strict')
const desktop = require('../core/desktop.js')

const SCRIPT = String.raw`
param([int]$X,[int]$Y)
Write-Output ("got " + $X + "," + $Y)
`

function checkBuildCommand() {
  assert.equal(desktop.buildCommand(SCRIPT, ['1', '2']).startsWith('& {'), true, '有参数时必须用 & { } 包起来')
  assert.equal(desktop.buildCommand(SCRIPT, ['1', '2']).endsWith('}'), true, '花括号要闭合，参数跟在后面')
  assert.equal(desktop.buildCommand(SCRIPT, []), SCRIPT, '没有参数时保持原样，别动已知能跑的那条路')
  assert.equal(desktop.buildCommand(SCRIPT), SCRIPT, 'args 缺省也不能崩')
}

async function checkRealBinding() {
  if (process.platform !== 'win32') {
    console.log('  · 非 Windows，跳过真实 PowerShell 绑定测试')
    return
  }
  const out = await desktop.run(SCRIPT, ['2212', '1371'])
  assert.match(out, /got 2212,1371/, `参数没绑定到 param()，实际输出：${JSON.stringify(out)}`)
}

async function main() {
  checkBuildCommand()
  console.log('  ✓ buildCommand 拼装行为')
  await checkRealBinding()
  console.log('  ✓ 真实 PowerShell 位置参数绑定')
  console.log('desktop-command.test.js 全部通过')
}

main().catch((err) => {
  console.error('desktop-command.test.js 失败：', err.message)
  process.exit(1)
})
