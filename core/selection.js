/**
 * 选区模型：基于 Uint8Array 的 8bit 灰度蒙版。
 *
 * 值域 0..255，0 表示不选中，255 表示完全选中。蒙版与 ImageBuffer 同尺寸，
 * 逐像素对应（mask[y*width + x]）。可与 algorithms/ 里的 ceil/mask 参数直接对接。
 *
 * 几何类 set 操作（rect/ellipse/lasso/pen/magicWand）都基于新建的 Uint8Array，
 * 不会意外叠加；变换类操作（feather/invert/translate）在当前蒙版上进行。
 */
'use strict'

function clampIdx(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/** 可分离盒式模糊，重复两次近似高斯羽化；边缘采用钳制补边 */
function boxBlur(src, w, h, r) {
  const tmp = new Uint8Array(w * h)
  const out = new Uint8Array(w * h)
  const win = 2 * r + 1

  for (let y = 0; y < h; y += 1) {
    let sum = 0
    for (let k = -r; k <= r; k += 1) sum += src[y * w + clampIdx(k, 0, w - 1)]
    for (let x = 0; x < w; x += 1) {
      tmp[y * w + x] = sum / win
      sum += src[y * w + clampIdx(x + r + 1, 0, w - 1)] - src[y * w + clampIdx(x - r, 0, w - 1)]
    }
  }

  for (let x = 0; x < w; x += 1) {
    let sum = 0
    for (let k = -r; k <= r; k += 1) sum += tmp[clampIdx(k, 0, h - 1) * w + x]
    for (let y = 0; y < h; y += 1) {
      out[y * w + x] = sum / win
      sum += tmp[clampIdx(y + r + 1, 0, h - 1) * w + x] - tmp[clampIdx(y - r, 0, h - 1) * w + x]
    }
  }
  return out
}

class Selection {
  constructor(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new Error(`非法选区尺寸：${width}x${height}`)
    }
    this.width = width
    this.height = height
    this._mask = new Uint8Array(width * height)
    this.active = false
  }

  /** 返回当前蒙版（直接引用，不拷贝） */
  mask() {
    return this._mask
  }

  _blank() {
    return new Uint8Array(this.width * this.height)
  }

  _commit(mask, feather) {
    this._mask = mask
    if (feather > 0) this.feather(feather)
    this._updateActive()
    return this
  }

  _updateActive() {
    const m = this._mask
    for (let i = 0; i < m.length; i += 1) {
      if (m[i] !== 0) {
        this.active = true
        return
      }
    }
    this.active = false
  }

  /** 矩形（左上角 x,y；宽高 w,h），支持小数/负向坐标 */
  rect(x, y, w, h, feather = 0) {
    const mask = this._blank()
    for (let py = 0; py < this.height; py += 1) {
      for (let px = 0; px < this.width; px += 1) {
        if (px >= x && px < x + w && py >= y && py < y + h) {
          mask[py * this.width + px] = 255
        }
      }
    }
    return this._commit(mask, feather)
  }

  /** 椭圆（中心 cx,cy；半径 rx,ry） */
  ellipse(cx, cy, rx, ry, feather = 0) {
    const mask = this._blank()
    if (rx > 0 && ry > 0) {
      for (let py = 0; py < this.height; py += 1) {
        for (let px = 0; px < this.width; px += 1) {
          const dx = (px - cx) / rx
          const dy = (py - cy) / ry
          if (dx * dx + dy * dy <= 1) mask[py * this.width + px] = 255
        }
      }
    }
    return this._commit(mask, feather)
  }

  /** 多边形填充（射线法）。lasso 与 pen 均按点集填充闭合区域。 */
  _fillPolygon(points, feather) {
    const mask = this._blank()
    const n = Array.isArray(points) ? points.length : 0
    if (n >= 3) {
      for (let py = 0; py < this.height; py += 1) {
        for (let px = 0; px < this.width; px += 1) {
          let inside = false
          for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
            const xi = points[i][0]
            const yi = points[i][1]
            const xj = points[j][0]
            const yj = points[j][1]
            if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
              inside = !inside
            }
          }
          if (inside) mask[py * this.width + px] = 255
        }
      }
    }
    return this._commit(mask, feather)
  }

  lasso(points, feather = 0) {
    return this._fillPolygon(points, feather)
  }

  pen(points, feather = 0) {
    return this._fillPolygon(points, feather)
  }

  /**
   * 魔棒：从 (x,y) 洪泛，选中与种子 RGBA 颜色距离 <= tolerance 的连通区域。
   * 距离采用 RGBA 四通道欧氏距离。
   */
  magicWand(src, x, y, tolerance = 32, feather = 0) {
    const mask = this._blank()
    const w = this.width
    const h = this.height
    const sw = src ? src.width : 0
    const sh = src ? src.height : 0
    const sx = Math.floor(x)
    const sy = Math.floor(y)

    if (!src || sx < 0 || sy < 0 || sx >= w || sy >= h || sx >= sw || sy >= sh) {
      return this._commit(mask, feather)
    }

    const data = src.data
    const si = (sy * sw + sx) * 4
    const sr = data[si]
    const sg = data[si + 1]
    const sb = data[si + 2]
    const sa = data[si + 3]
    const tol = tolerance < 0 ? 0 : tolerance
    const tol2 = tol * tol

    const visited = new Uint8Array(w * h)
    const start = sy * w + sx
    const stack = [start]
    visited[start] = 1

    while (stack.length) {
      const idx = stack.pop()
      const px = idx % w
      const py = (idx / w) | 0
      // 超出源图范围的像素直接判为不接受
      if (px >= sw || py >= sh) continue

      const i = (py * sw + px) * 4
      const dr = data[i] - sr
      const dg = data[i + 1] - sg
      const db = data[i + 2] - sb
      const da = data[i + 3] - sa
      if (dr * dr + dg * dg + db * db + da * da <= tol2) {
        mask[idx] = 255
        if (px > 0) {
          const ni = idx - 1
          if (!visited[ni]) { visited[ni] = 1; stack.push(ni) }
        }
        if (px < w - 1) {
          const ni = idx + 1
          if (!visited[ni]) { visited[ni] = 1; stack.push(ni) }
        }
        if (py > 0) {
          const ni = idx - w
          if (!visited[ni]) { visited[ni] = 1; stack.push(ni) }
        }
        if (py < h - 1) {
          const ni = idx + w
          if (!visited[ni]) { visited[ni] = 1; stack.push(ni) }
        }
      }
    }
    return this._commit(mask, feather)
  }

  /** 对当前蒙版做羽化（两遍盒式模糊近似高斯），原地更新 */
  feather(radius) {
    const r = Number.isFinite(radius) ? Math.floor(radius) : 0
    if (r <= 0) return this
    let m = this._mask
    for (let pass = 0; pass < 2; pass += 1) m = boxBlur(m, this.width, this.height, r)
    this._mask = m
    this._updateActive()
    return this
  }

  invert() {
    const m = this._mask
    for (let i = 0; i < m.length; i += 1) m[i] = 255 - m[i]
    this._updateActive()
    return this
  }

  /** 平移蒙版（移出的区域丢弃，新进入的区域填 0） */
  translate(dx, dy) {
    const out = this._blank()
    const ox = Number.isFinite(dx) ? Math.round(dx) : 0
    const oy = Number.isFinite(dy) ? Math.round(dy) : 0
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        const nx = x + ox
        const ny = y + oy
        if (nx >= 0 && nx < this.width && ny >= 0 && ny < this.height) {
          out[ny * this.width + nx] = this._mask[y * this.width + x]
        }
      }
    }
    this._mask = out
    this._updateActive()
    return this
  }

  clear() {
    this._mask = this._blank()
    this.active = false
    return this
  }
}

module.exports = { Selection }
