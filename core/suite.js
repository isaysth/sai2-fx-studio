/**
 * 完整工具面板启动桥。
 *
 * 插件包里随附的上游套件 sai2_bridge.exe 就是截图里那套「SAI2 插件面板」：
 * 四个功能窗口 + 工具 ▾（笔刷导入 / 画布盖印 / 穿透橡皮 / 历史记录 /
 * 统计 / 黑白监看 / Lab 取色器 / 三角色盘 / 渐变换色 / 动作 /
 * 外观与快捷键 / 缩时摄影）。本模块只负责把它作为插件的一部分启动，
 * 不改动任何上游二进制。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

function bridgeExe(suiteDir) {
  return path.join(suiteDir, 'sai2_bridge.exe')
}

function runDetached(exe, cwd) {
  return new Promise((resolve) => {
    if (!fs.existsSync(exe)) {
      resolve({ ok: false, error: `找不到 ${exe}` })
      return
    }
    try {
      const child = spawn(exe, [], { cwd, detached: true, stdio: 'ignore', windowsHide: false })
      child.once('error', (err) => resolve({ ok: false, error: err.message }))
      child.once('spawn', () => {
        child.unref()
        resolve({ ok: true })
      })
    } catch (err) {
      resolve({ ok: false, error: err.message })
    }
  })
}

const ELEVATE_PS = String.raw`
param([string]$Exe,[string]$WorkDir)
$ErrorActionPreference='Stop'
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $Exe
$psi.WorkingDirectory = $WorkDir
$psi.UseShellExecute = $true
$psi.Verb = 'RunAs'
[void][System.Diagnostics.Process]::Start($psi)
Write-Output 'OK'
`

function runElevated(exe, cwd) {
  return new Promise((resolve) => {
    if (!fs.existsSync(exe)) {
      resolve({ ok: false, error: `找不到 ${exe}` })
      return
    }
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', ELEVATE_PS, exe, cwd
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    ps.stderr.on('data', (c) => { err += c.toString() })
    ps.once('error', (e) => resolve({ ok: false, error: e.message }))
    ps.once('close', (code) => {
      resolve(code === 0 ? { ok: true } : { ok: false, error: err.trim() || `PowerShell 退出码 ${code}` })
    })
  })
}

/** 启动随包完整工具面板；elevated 用于 SAI2 以管理员运行时保持权限一致 */
function openPanel(suiteDir, opts = {}) {
  const exe = bridgeExe(suiteDir)
  if (!fs.existsSync(exe)) {
    return Promise.resolve({ ok: false, error: `套件缺少 sai2_bridge.exe：${exe}` })
  }
  return opts.elevated ? runElevated(exe, suiteDir) : runDetached(exe, suiteDir)
}

module.exports = { bridgeExe, openPanel }
