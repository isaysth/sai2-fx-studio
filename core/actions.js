/**
 * 动作录制器：把一串 {tab, effect, params} 步骤录成可序列化、可回放的宏。
 *
 * 全部为内存结构，不依赖 DOM / 剪贴板 / 网络。
 */
'use strict'

class ActionRecorder {
  constructor(label = '') {
    this.label = label || ''
    this._steps = []
  }

  /** 录入一步；同时更新录制器 label */
  record(label, step) {
    if (label != null) this.label = String(label)
    const src = step && typeof step === 'object' ? step : {}
    this._steps.push(Object.assign({ params: {} }, src))
    return this._steps.length
  }

  /** 步骤数组快照（浅拷贝，含 params 的浅拷贝） */
  steps() {
    return this._steps.map((s) => Object.assign({}, s, {
      params: s.params && typeof s.params === 'object' ? Object.assign({}, s.params) : s.params
    }))
  }

  clear() {
    this._steps = []
    this.label = ''
    return this
  }

  /** 可 JSON 化的快照 */
  serialize() {
    return { version: 1, label: this.label, steps: this.steps() }
  }

  /** 从 serialize() 的结果恢复；version/steps 非法时抛错 */
  static load(obj) {
    if (!obj || typeof obj !== 'object') throw new Error('ActionRecorder.load 需要对象')
    if (obj.version !== 1) throw new Error(`不支持的录制版本：${obj.version}`)
    if (!Array.isArray(obj.steps)) throw new Error('录制数据缺少 steps 数组')

    const recorder = new ActionRecorder(obj.label || '')
    recorder._steps = obj.steps.map((s) => Object.assign({ params: {} }, s && typeof s === 'object' ? s : {}))
    return recorder
  }

  /** 依次 await runner(step)，返回成功执行的步数 */
  async replay(runner) {
    if (typeof runner !== 'function') throw new Error('replay 需要 runner 函数')
    const snapshot = this.steps()
    let count = 0
    for (const step of snapshot) {
      await runner(step)
      count += 1
    }
    return count
  }
}

module.exports = { ActionRecorder }
