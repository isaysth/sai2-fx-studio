/**
 * 线性历史记录（带撤销/重做游标）。
 *
 * entry 形如 {label, image, ...}，其中 image 保留引用、不做深拷贝。
 * push 使用自增 index；游标之后的步骤在再次 push 时被丢弃（标准 redo 分支处理）。
 */
'use strict'

class History {
  constructor(limit = 50) {
    this.limit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 50
    this._entries = []
    this._cursor = -1
    this._nextIndex = 0
  }

  get length() {
    return this._entries.length
  }

  get canUndo() {
    return this._cursor > 0
  }

  get canRedo() {
    return this._cursor < this._entries.length - 1
  }

  /** 压入一步，返回自增 index */
  push(entry) {
    if (entry == null || typeof entry !== 'object') throw new Error('push 需要 entry 对象')

    // 游标不在末尾时，丢弃其后的重做分支
    if (this._cursor < this._entries.length - 1) {
      this._entries.length = this._cursor + 1
    }

    const record = Object.assign({}, entry, {
      index: this._nextIndex++,
      time: Date.now()
    })
    this._entries.push(record)
    this._cursor = this._entries.length - 1

    while (this._entries.length > this.limit) {
      this._entries.shift()
      this._cursor -= 1
    }
    if (this._cursor < 0) this._cursor = 0
    return record.index
  }

  /** 回退一步，返回回退后所在的 entry；没有则 null */
  undo() {
    if (!this.canUndo) return null
    this._cursor -= 1
    return this._entries[this._cursor]
  }

  /** 前进一步，返回前进后所在的 entry；没有则 null */
  redo() {
    if (!this.canRedo) return null
    this._cursor += 1
    return this._entries[this._cursor]
  }

  /** 快照列表 [{index,label,time}] */
  list() {
    return this._entries.map((e) => ({ index: e.index, label: e.label, time: e.time }))
  }

  /** 回到指定 index（丢弃其后的步骤），返回该 entry；不存在返回 null */
  revertTo(index) {
    const pos = this._entries.findIndex((e) => e.index === index)
    if (pos < 0) return null
    this._entries.length = pos + 1
    this._cursor = pos
    // 之后新增的 index 仍要大于历史里出现过的最大值
    for (const e of this._entries) {
      if (e.index >= this._nextIndex) this._nextIndex = e.index + 1
    }
    return this._entries[pos]
  }

  clear() {
    this._entries = []
    this._cursor = -1
    this._nextIndex = 0
  }
}

module.exports = { History }
