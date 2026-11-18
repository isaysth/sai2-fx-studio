/**
 * 滤镜库（JS 移植，来源：上游 plugins/filter-gallery/src/Filters.h 等）。
 * 60 个不同 id 的滤镜：保留原有 10 个，并扩展颜色/色调/风格化/卷积等分组。
 * 全部基于 RGBA8 点运算或小邻域卷积，支持 mask 线性混合。
 *
 * FILTER_LIST 提供 UI 缩略图墙所需元数据：
 *   [{id, name, group, params:[{key,label,min,max,default}], defaultParams}]
 */
'use strict'

const { ImageBuffer, clamp8 } = require('../core/image.js')

/** 按 mask 线性混合 orig 与 result，a = mask[i]/255 */
function blendMask(orig, result, mask) {
  if (!mask) return result
  const n = orig.width * orig.height
  const out = new ImageBuffer(orig.width, orig.height)
  for (let p = 0; p < n; p += 1) {
    const a = Math.max(0, Math.min(1, (mask[p] | 0) / 255))
    const i = p * 4
    out.data[i] = orig.data[i] * (1 - a) + result.data[i] * a
    out.data[i + 1] = orig.data[i + 1] * (1 - a) + result.data[i + 1] * a
    out.data[i + 2] = orig.data[i + 2] * (1 - a) + result.data[i + 2] * a
    out.data[i + 3] = orig.data[i + 3] * (1 - a) + result.data[i + 3] * a
  }
  return out
}

function luma(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b }

/** 参数元数据 + 默认参数对象 */
function meta(list) {
  const defaultParams = {}
  for (const p of list) defaultParams[p.key] = p.default
  return { params: list, defaultParams }
}

/** 通用逐像素变换：transform(r,g,b,x,y) -> [r,g,b] */
function mapPixels(src, transform, mask) {
  const { width: w, height: h } = src
  const out = new ImageBuffer(w, h)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4
      const c = transform(src.data[i], src.data[i + 1], src.data[i + 2], x, y)
      out.data[i] = c[0]; out.data[i + 1] = c[1]; out.data[i + 2] = c[2]
      out.data[i + 3] = src.data[i + 3]
    }
  }
  return blendMask(src, out, mask)
}

const px = (s, p, transform) => mapPixels(s, transform, p.mask)
const GAUSS3 = [1, 2, 1, 2, 4, 2, 1, 2, 1]
const convMasked = (s, p, k, d = 1, bias = 0) => blendMask(s, convolve3(s, k, d, bias), p.mask)
const blurred = (s) => convolve3(s, GAUSS3, 16)

/** 卷积（3x3，alpha 不变） */
function convolve3(src, kernel, divisor = 1, bias = 0) {
  const { width: w, height: h, data } = src
  const out = new ImageBuffer(w, h)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      for (let c = 0; c < 3; c += 1) {
        let acc = 0
        for (let ky = -1; ky <= 1; ky += 1) {
          for (let kx = -1; kx <= 1; kx += 1) {
            const sx = Math.min(w - 1, Math.max(0, x + kx))
            const sy = Math.min(h - 1, Math.max(0, y + ky))
            acc += data[(sy * w + sx) * 4 + c] * kernel[(ky + 1) * 3 + (kx + 1)]
          }
        }
        out.data[(y * w + x) * 4 + c] = acc / divisor + bias
      }
      out.data[(y * w + x) * 4 + 3] = data[(y * w + x) * 4 + 3]
    }
  }
  return out
}

function sharpen(src, amount = 1) {
  const base = [0, -1, 0, -1, 5, -1, 0, -1, 0]
  const k = base.map((v, i) => (i === 4 ? 1 + 4 * (amount - 1) : v * amount))
  return convolve3(src, k, 1, 0)
}
function emboss(src) { return convolve3(src, [-2, -1, 0, -1, 1, 1, 0, 1, 2], 1, 128) }
function edge(src) { return convolve3(src, [-1, -1, -1, -1, 8, -1, -1, -1, -1], 1, 0) }

function sepia(src) {
  return mapPixels(src, (r, g, b) => [
    0.393 * r + 0.769 * g + 0.189 * b,
    0.349 * r + 0.686 * g + 0.168 * b,
    0.272 * r + 0.534 * g + 0.131 * b
  ])
}
function tint(src, kr, kg, kb) {
  return mapPixels(src, (r, g, b) => [r * kr, g * kg, b * kb])
}
function highContrastBW(src, threshold = 128) {
  return mapPixels(src, (r, g, b) => {
    const v = luma(r, g, b) >= threshold ? 255 : 0
    return [v, v, v]
  })
}
function soften(src, amount = 0.5) {
  const b = blurred(src)
  return mapPixels(src, (r, g, bl, x, y) => {
    const i = (y * src.width + x) * 4
    return [r * (1 - amount) + b.data[i] * amount,
      g * (1 - amount) + b.data[i + 1] * amount,
      bl * (1 - amount) + b.data[i + 2] * amount]
  })
}
/** 像素化：每块取中心色 */
function pixelate(src, block = 8) {
  const { width: w, height: h } = src
  const out = new ImageBuffer(w, h)
  const b = Math.max(1, Math.round(block))
  for (let by = 0; by < h; by += b) {
    for (let bx = 0; bx < w; bx += b) {
      const color = src.pixel(Math.min(w - 1, bx + (b >> 1)), Math.min(h - 1, by + (b >> 1)))
      for (let y = by; y < Math.min(h, by + b); y += 1) {
        for (let x = bx; x < Math.min(w, bx + b); x += 1) out.setPixel(x, y, color[0], color[1], color[2], color[3])
      }
    }
  }
  return out
}
/** 马赛克：每块取平均色 */
function mosaic(src, block = 8) {
  const { width: w, height: h } = src
  const out = new ImageBuffer(w, h)
  const b = Math.max(1, Math.round(block))
  for (let by = 0; by < h; by += b) {
    for (let bx = 0; bx < w; bx += b) {
      let r = 0, g = 0, bl = 0, a = 0, n = 0
      for (let y = by; y < Math.min(h, by + b); y += 1) {
        for (let x = bx; x < Math.min(w, bx + b); x += 1) {
          const p = src.pixel(x, y); r += p[0]; g += p[1]; bl += p[2]; a += p[3]; n += 1
        }
      }
      r /= n; g /= n; bl /= n; a /= n
      for (let y = by; y < Math.min(h, by + b); y += 1) {
        for (let x = bx; x < Math.min(w, bx + b); x += 1) out.setPixel(x, y, r, g, bl, a)
      }
    }
  }
  return out
}

/** 双色映射：t=亮度/255 时在 a→b 间插值 */
function duotone(src, a, b, mask) {
  return mapPixels(src, (r, g, bl) => {
    const t = luma(r, g, bl) / 255
    return [a[0] * (1 - t) + b[0] * t, a[1] * (1 - t) + b[1] * t, a[2] * (1 - t) + b[2] * t]
  }, mask)
}
/** 三色映射 */
function tritone(src, a, m, b, mask) {
  return mapPixels(src, (r, g, bl) => {
    const t = luma(r, g, bl) / 255
    const c = t < 0.5 ? [a[0] * (1 - t * 2) + m[0] * t * 2, a[1] * (1 - t * 2) + m[1] * t * 2, a[2] * (1 - t * 2) + m[2] * t * 2]
      : [m[0] * (1 - (t - 0.5) * 2) + b[0] * (t - 0.5) * 2, m[1] * (1 - (t - 0.5) * 2) + b[1] * (t - 0.5) * 2, m[2] * (1 - (t - 0.5) * 2) + b[2] * (t - 0.5) * 2]
    return c
  }, mask)
}

function equalizeEffect(s, p) {
  const out = new ImageBuffer(s.width, s.height)
  const hist = new Uint32Array(256)
  for (let i = 0; i < s.data.length; i += 4) hist[clamp8(luma(s.data[i], s.data[i + 1], s.data[i + 2]))] += 1
  const cdf = new Uint32Array(256)
  let acc = 0
  for (let v = 0; v < 256; v += 1) { acc += hist[v]; cdf[v] = acc }
  const total = s.width * s.height
  const lut = new Uint8ClampedArray(256)
  for (let v = 0; v < 256; v += 1) lut[v] = Math.round((cdf[v] / total) * 255)
  for (let i = 0; i < s.data.length; i += 4) {
    const v = lut[clamp8(luma(s.data[i], s.data[i + 1], s.data[i + 2]))]
    out.data[i] = v; out.data[i + 1] = v; out.data[i + 2] = v; out.data[i + 3] = s.data[i + 3]
  }
  return blendMask(s, out, p.mask)
}

function autoContrastEffect(s, p) {
  const lo = [255, 255, 255], hi = [0, 0, 0]
  for (let i = 0; i < s.data.length; i += 4) {
    for (let k = 0; k < 3; k += 1) {
      const v = s.data[i + k]
      if (v < lo[k]) lo[k] = v
      if (v > hi[k]) hi[k] = v
    }
  }
  const out = new ImageBuffer(s.width, s.height)
  for (let i = 0; i < s.data.length; i += 4) {
    for (let k = 0; k < 3; k += 1) {
      const span = hi[k] - lo[k]
      out.data[i + k] = span > 0 ? clamp8(((s.data[i + k] - lo[k]) / span) * 255) : s.data[i + k]
    }
    out.data[i + 3] = s.data[i + 3]
  }
  return blendMask(s, out, p.mask)
}

function unsharpEffect(s, p) {
  const amount = p.amount ?? 1
  const b = blurred(s)
  const out = new ImageBuffer(s.width, s.height)
  for (let i = 0; i < s.data.length; i += 4) {
    for (let k = 0; k < 3; k += 1) out.data[i + k] = clamp8(s.data[i + k] + (s.data[i + k] - b.data[i + k]) * amount)
    out.data[i + 3] = s.data[i + 3]
  }
  return blendMask(s, out, p.mask)
}

function glowEffect(s, p) {
  const amount = p.amount ?? 0.8
  const threshold = p.threshold ?? 150
  const b = blurred(s)
  const out = new ImageBuffer(s.width, s.height)
  for (let i = 0; i < s.data.length; i += 4) {
    for (let k = 0; k < 3; k += 1) {
      const bright = Math.max(0, s.data[i + k] - threshold) / 255
      out.data[i + k] = clamp8(s.data[i + k] + b.data[i + k] * amount * bright)
    }
    out.data[i + 3] = s.data[i + 3]
  }
  return blendMask(s, out, p.mask)
}

function quantizeEffect(s, levels, useBlur, mask) {
  const n = Math.max(2, Math.min(16, Math.round(levels)))
  const scale = 255 / (n - 1)
  const src = useBlur ? blurred(s) : s
  return mapPixels(src, (r, g, b) => [
    clamp8(Math.round(r / scale) * scale),
    clamp8(Math.round(g / scale) * scale),
    clamp8(Math.round(b / scale) * scale)
  ], mask)
}

function watercolorEffect(s, p) {
  const levels = p.levels ?? 8
  const b = blurred(s)
  const out = new ImageBuffer(s.width, s.height)
  const scale = 255 / (Math.max(2, Math.round(levels)) - 1)
  for (let i = 0; i < s.data.length; i += 4) {
    const g = luma(b.data[i], b.data[i + 1], b.data[i + 2])
    for (let k = 0; k < 3; k += 1) {
      const sat = g + (b.data[i + k] - g) * 1.4
      out.data[i + k] = clamp8(Math.round(sat / scale) * scale)
    }
    out.data[i + 3] = s.data[i + 3]
  }
  return blendMask(s, out, p.mask)
}

function sketchEffect(s, p) {
  const gray = new ImageBuffer(s.width, s.height)
  for (let i = 0; i < s.data.length; i += 4) {
    const v = luma(s.data[i], s.data[i + 1], s.data[i + 2])
    gray.data[i] = gray.data[i + 1] = gray.data[i + 2] = 255 - v
    gray.data[i + 3] = 255
  }
  const b = blurred(gray)
  const out = new ImageBuffer(s.width, s.height)
  for (let i = 0; i < s.data.length; i += 4) {
    const grayVal = luma(s.data[i], s.data[i + 1], s.data[i + 2])
    const denom = 255 - b.data[i]
    const v = denom < 1 ? 255 : clamp8((grayVal * 256) / denom)
    out.data[i] = out.data[i + 1] = out.data[i + 2] = v
    out.data[i + 3] = s.data[i + 3]
  }
  return blendMask(s, out, p.mask)
}

function charcoalEffect(s, p) {
  const b = blurred(s)
  const out = new ImageBuffer(s.width, s.height)
  for (let y = 0; y < s.height; y += 1) {
    for (let x = 0; x < s.width; x += 1) {
      const i = (y * s.width + x) * 4
      const grayVal = luma(s.data[i], s.data[i + 1], s.data[i + 2])
      const bg = luma(b.data[i], b.data[i + 1], b.data[i + 2])
      const noise = (hash2(x, y, 7) - 0.5) * 16
      const v = clamp8(grayVal * 1.4 + (grayVal - bg) * 2 - 40 + noise)
      out.data[i] = out.data[i + 1] = out.data[i + 2] = v
      out.data[i + 3] = s.data[i + 3]
    }
  }
  return blendMask(s, out, p.mask)
}

function halftoneEffect(s, p) {
  const cell = Math.max(2, Math.round(p.size ?? 6))
  const out = new ImageBuffer(s.width, s.height)
  for (let y = 0; y < s.height; y += 1) {
    for (let x = 0; x < s.width; x += 1) {
      const i = (y * s.width + x) * 4
      const v = luma(s.data[i], s.data[i + 1], s.data[i + 2]) / 255
      const cx = (x % cell) - cell / 2
      const cy = (y % cell) - cell / 2
      const dot = Math.hypot(cx, cy) <= v * (cell / 2) * 1.4 ? 255 : 0
      out.data[i] = out.data[i + 1] = out.data[i + 2] = dot
      out.data[i + 3] = s.data[i + 3]
    }
  }
  return blendMask(s, out, p.mask)
}

function crystallizeEffect(s, p) {
  const size = Math.max(2, Math.round(p.size ?? 8))
  const { width: w, height: h } = s
  const out = new ImageBuffer(w, h)
  for (let by = 0; by < h; by += size) {
    for (let bx = 0; bx < w; bx += size) {
      const ox = (Math.floor(by / size) % 2) ? (size >> 1) : 0
      const sx = Math.min(w - 1, bx + ox + (size >> 1))
      const sy = Math.min(h - 1, by + (size >> 1))
      const color = s.pixel(sx, sy)
      for (let y = by; y < Math.min(h, by + size); y += 1) {
        for (let x = bx; x < Math.min(w, bx + size); x += 1) out.setPixel(x, y, color[0], color[1], color[2], color[3])
      }
    }
  }
  return blendMask(s, out, p.mask)
}

function diffuseEffect(s, p) {
  const radius = Math.max(0, Math.round(p.radius ?? 3))
  const { width: w, height: h } = s
  const out = new ImageBuffer(w, h)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const ox = Math.round((hash2(x, y, 11) - 0.5) * 2 * radius)
      const oy = Math.round((hash2(x, y, 23) - 0.5) * 2 * radius)
      const sx = Math.min(w - 1, Math.max(0, x + ox))
      const sy = Math.min(h - 1, Math.max(0, y + oy))
      const si = (sy * w + sx) * 4
      const di = (y * w + x) * 4
      out.data[di] = s.data[si]; out.data[di + 1] = s.data[si + 1]
      out.data[di + 2] = s.data[si + 2]; out.data[di + 3] = s.data[si + 3]
    }
  }
  return blendMask(s, out, p.mask)
}

function traceContourEffect(s, p) {
  const threshold = p.threshold ?? 40
  const e = edge(s)
  const out = new ImageBuffer(s.width, s.height)
  for (let i = 0; i < s.data.length; i += 4) {
    const v = e.data[i] >= threshold ? 0 : 255
    out.data[i] = out.data[i + 1] = out.data[i + 2] = v
    out.data[i + 3] = s.data[i + 3]
  }
  return blendMask(s, out, p.mask)
}

function hash2(x, y, seed) {
  let h = Math.imul(x + 1, 374761393) + Math.imul(y + 1, 668265263) + Math.imul(seed + 1, 2246822519)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

const EFFECTS = [
  // —— 原有 10 个（id 保持不变）——
  { id: 'sharpen', name: '锐化', group: '卷积', ...meta([{ key: 'amount', label: '强度', min: 0, max: 5, default: 1 }]),
    fn: (s, p) => blendMask(s, sharpen(s, p.amount ?? 1), p.mask) },
  { id: 'emboss', name: '浮雕', group: '卷积', ...meta([]), fn: (s, p) => convMasked(s, p, [-2, -1, 0, -1, 1, 1, 0, 1, 2], 1, 128) },
  { id: 'edge', name: '边缘', group: '卷积', ...meta([]), fn: (s, p) => convMasked(s, p, [-1, -1, -1, -1, 8, -1, -1, -1, -1]) },
  { id: 'sepia', name: '怀旧', group: '颜色', ...meta([]), fn: (s, p) => px(s, p, (r, g, b) => [0.393 * r + 0.769 * g + 0.189 * b, 0.349 * r + 0.686 * g + 0.168 * b, 0.272 * r + 0.534 * g + 0.131 * b]) },
  { id: 'cool', name: '冷色', group: '颜色', ...meta([]), fn: (s, p) => px(s, p, (r, g, b) => [r * 0.85, g * 0.95, b * 1.15]) },
  { id: 'warm', name: '暖色', group: '颜色', ...meta([]), fn: (s, p) => px(s, p, (r, g, b) => [r * 1.15, g * 0.98, b * 0.8]) },
  { id: 'bw', name: '高对比黑白', group: '灰度', ...meta([{ key: 'threshold', label: '阈值', min: 0, max: 255, default: 128 }]),
    fn: (s, p) => px(s, p, (r, g, b) => { const v = luma(r, g, b) >= (p.threshold ?? 128) ? 255 : 0; return [v, v, v] }) },
  { id: 'soften', name: '柔光', group: '卷积', ...meta([{ key: 'amount', label: '柔化量', min: 0, max: 1, default: 0.5 }]),
    fn: (s, p) => blendMask(s, soften(s, p.amount ?? 0.5), p.mask) },
  { id: 'pixelate', name: '像素化', group: '风格化', ...meta([{ key: 'block', label: '块大小', min: 1, max: 64, default: 8 }]),
    fn: (s, p) => blendMask(s, pixelate(s, p.block ?? 8), p.mask) },
  { id: 'mosaic', name: '马赛克', group: '风格化', ...meta([{ key: 'block', label: '块大小', min: 1, max: 64, default: 8 }]),
    fn: (s, p) => blendMask(s, mosaic(s, p.block ?? 8), p.mask) },

  // —— 颜色 ——
  { id: 'invert', name: '反相', group: '颜色', ...meta([]), fn: (s, p) => px(s, p, (r, g, b) => [255 - r, 255 - g, 255 - b]) },
  { id: 'grayscale', name: '灰度', group: '灰度', ...meta([]), fn: (s, p) => px(s, p, (r, g, b) => { const v = luma(r, g, b); return [v, v, v] }) },
  { id: 'vivid', name: '鲜艳', group: '颜色', ...meta([{ key: 'amount', label: '饱和度', min: 0, max: 4, default: 1.8 }]),
    fn: (s, p) => { const a = p.amount ?? 1.8; return px(s, p, (r, g, b) => { const y = luma(r, g, b); return [y + (r - y) * a, y + (g - y) * a, y + (b - y) * a] }) } },
  { id: 'pastel', name: '粉彩', group: '颜色', ...meta([{ key: 'amount', label: '粉彩量', min: 0, max: 1, default: 0.55 }]),
    fn: (s, p) => { const a = p.amount ?? 0.55; return px(s, p, (r, g, b) => [r * (1 - a) + 255 * a, g * (1 - a) + 255 * a, b * (1 - a) + 255 * a]) } },
  { id: 'neon', name: '霓虹', group: '颜色', ...meta([{ key: 'amount', label: '强度', min: 0, max: 5, default: 2.5 }]),
    fn: (s, p) => { const a = p.amount ?? 2.5; return px(s, p, (r, g, b) => { const y = luma(r, g, b); return [y + (r - y) * a + 12, y + (g - y) * a + 12, y + (b - y) * a + 12] }) } },
  { id: 'vintage', name: '复古', group: '颜色', ...meta([]),
    fn: (s, p) => px(s, p, (r, g, b) => [(0.393 * r + 0.769 * g + 0.189 * b) * 0.88 + 12, (0.349 * r + 0.686 * g + 0.168 * b) * 0.88 + 8, (0.272 * r + 0.534 * g + 0.131 * b) * 0.88 + 4]) },
  { id: 'fade', name: '褪色', group: '颜色', ...meta([{ key: 'amount', label: '褪色量', min: 0, max: 100, default: 50 }]),
    fn: (s, p) => { const a = p.amount ?? 50; return px(s, p, (r, g, b) => [r * (1 - a / 100) + a * 0.8, g * (1 - a / 100) + a * 0.8, b * (1 - a / 100) + a * 0.8]) } },
  { id: 'duotone', name: '双色调', group: '颜色', ...meta([
    { key: 'colorA', label: '暗部色', min: 0, max: 255, default: [20, 10, 60], type: 'color' },
    { key: 'colorB', label: '亮部色', min: 0, max: 255, default: [255, 220, 120], type: 'color' }
  ]), fn: (s, p) => duotone(s, p.colorA ?? [20, 10, 60], p.colorB ?? [255, 220, 120], p.mask) },
  { id: 'tritone', name: '三色调', group: '颜色', ...meta([
    { key: 'colorA', label: '暗部色', min: 0, max: 255, default: [10, 20, 60], type: 'color' },
    { key: 'colorB', label: '中间色', min: 0, max: 255, default: [190, 60, 90], type: 'color' },
    { key: 'colorC', label: '亮部色', min: 0, max: 255, default: [255, 230, 180], type: 'color' }
  ]), fn: (s, p) => tritone(s, p.colorA ?? [10, 20, 60], p.colorB ?? [190, 60, 90], p.colorC ?? [255, 230, 180], p.mask) },
  { id: 'colorize', name: '着色', group: '颜色', ...meta([{ key: 'color', label: '着色色', min: 0, max: 255, default: [200, 120, 40], type: 'color' }]),
    fn: (s, p) => { const c = p.color ?? [200, 120, 40]; return px(s, p, (r, g, b) => { const t = luma(r, g, b) / 255; return [t * c[0], t * c[1], t * c[2]] }) } },
  { id: 'channelSwap', name: '通道交换', group: '颜色', ...meta([]), fn: (s, p) => px(s, p, (r, g, b) => [b, r, g]) },
  { id: 'redBoost', name: '红通道增强', group: '颜色', ...meta([{ key: 'gain', label: '增益', min: 0.2, max: 3, default: 1.6 }]),
    fn: (s, p) => { const g = p.gain ?? 1.6; return px(s, p, (r, gr, b) => [r * g, gr * 0.95, b * 0.85]) } },
  { id: 'greenBoost', name: '绿通道增强', group: '颜色', ...meta([{ key: 'gain', label: '增益', min: 0.2, max: 3, default: 1.6 }]),
    fn: (s, p) => { const g = p.gain ?? 1.6; return px(s, p, (r, gr, b) => [r * 0.85, gr * g, b * 0.9]) } },
  { id: 'blueBoost', name: '蓝通道增强', group: '颜色', ...meta([{ key: 'gain', label: '增益', min: 0.2, max: 3, default: 1.6 }]),
    fn: (s, p) => { const g = p.gain ?? 1.6; return px(s, p, (r, gr, b) => [r * 0.85, gr * 0.9, b * g]) } },
  { id: 'cyanotype', name: '蓝图', group: '颜色', ...meta([]), fn: (s, p) => duotone(s, [8, 20, 60], [210, 235, 255], p.mask) },
  { id: 'infrared', name: '红外', group: '颜色', ...meta([]), fn: (s, p) => px(s, p, (r, g, b) => [g * 1.2, b * 1.1, r * 1.15]) },
  { id: 'sepiaLight', name: '浅怀旧', group: '颜色', ...meta([]),
    fn: (s, p) => px(s, p, (r, g, b) => [r * 0.5 + (0.393 * r + 0.769 * g + 0.189 * b) * 0.5, g * 0.5 + (0.349 * r + 0.686 * g + 0.168 * b) * 0.5, b * 0.5 + (0.272 * r + 0.534 * g + 0.131 * b) * 0.5]) },
  { id: 'crossProcess', name: '交叉冲洗', group: '颜色', ...meta([]),
    fn: (s, p) => px(s, p, (r, g, b) => [r * 1.1 + 12, g * 0.95 + 4, b * 1.15 + 20 - r * 0.05]) },
  { id: 'tealOrange', name: '青橙电影', group: '颜色', ...meta([]),
    fn: (s, p) => px(s, p, (r, g, b) => { const t = luma(r, g, b) / 255; return [r * 0.6 + t * 90, g * 0.8 + (1 - t) * 40, b * 1.1 + (1 - t) * 80 - t * 40] }) },
  { id: 'bleach', name: '漂白', group: '颜色', ...meta([]),
    fn: (s, p) => px(s, p, (r, g, b) => { const y = luma(r, g, b); return [y + (r - y) * 0.25 + 25, y + (g - y) * 0.25 + 25, y + (b - y) * 0.25 + 25] }) },

  // —— 色调 ——
  { id: 'brighten', name: '提亮', group: '色调', ...meta([{ key: 'amount', label: '增亮', min: 0, max: 150, default: 45 }]),
    fn: (s, p) => { const a = p.amount ?? 45; return px(s, p, (r, g, b) => [r + a, g + a, b + a]) } },
  { id: 'darken', name: '压暗', group: '色调', ...meta([{ key: 'amount', label: '减暗', min: 0, max: 150, default: 45 }]),
    fn: (s, p) => { const a = p.amount ?? 45; return px(s, p, (r, g, b) => [r - a, g - a, b - a]) } },
  { id: 'highContrast', name: '高对比', group: '色调', ...meta([{ key: 'amount', label: '对比度', min: 0, max: 100, default: 60 }]),
    fn: (s, p) => { const c = (259 * ((p.amount ?? 60) + 255)) / (255 * (259 - (p.amount ?? 60))); return px(s, p, (r, g, b) => [c * (r - 128) + 128, c * (g - 128) + 128, c * (b - 128) + 128]) } },
  { id: 'lowContrast', name: '低对比', group: '色调', ...meta([{ key: 'amount', label: '对比度', min: -100, max: 0, default: -45 }]),
    fn: (s, p) => { const c = (259 * ((p.amount ?? -45) + 255)) / (255 * (259 - (p.amount ?? -45))); return px(s, p, (r, g, b) => [c * (r - 128) + 128, c * (g - 128) + 128, c * (b - 128) + 128]) } },
  { id: 'gamma', name: '伽马校正', group: '色调', ...meta([{ key: 'gamma', label: '伽马', min: 0.2, max: 4, default: 1.8 }]),
    fn: (s, p) => { const g = p.gamma ?? 1.8; return px(s, p, (r, gr, b) => [255 * (r / 255) ** (1 / g), 255 * (gr / 255) ** (1 / g), 255 * (b / 255) ** (1 / g)]) } },
  { id: 'solarize', name: '曝光过度', group: '色调', ...meta([{ key: 'threshold', label: '阈值', min: 0, max: 255, default: 128 }]),
    fn: (s, p) => { const t = p.threshold ?? 128; return px(s, p, (r, g, b) => [r >= t ? 255 - r : r, g >= t ? 255 - g : g, b >= t ? 255 - b : b]) } },
  { id: 'posterize', name: '色调分离', group: '色调', ...meta([{ key: 'levels', label: '级数', min: 2, max: 16, default: 5 }]),
    fn: (s, p) => quantizeEffect(s, p.levels ?? 5, false, p.mask) },
  { id: 'threshold', name: '阈值', group: '色调', ...meta([{ key: 'threshold', label: '阈值', min: 0, max: 255, default: 128 }]),
    fn: (s, p) => px(s, p, (r, g, b) => { const v = luma(r, g, b) >= (p.threshold ?? 128) ? 255 : 0; return [v, v, v] }) },
  { id: 'equalize', name: '直方图均衡', group: '色调', ...meta([]), fn: equalizeEffect },
  { id: 'autoContrast', name: '自动对比', group: '色调', ...meta([]), fn: autoContrastEffect },

  // —— 风格化 ——
  { id: 'embossColor', name: '彩色浮雕', group: '风格化', ...meta([]),
    fn: (s, p) => { const e = emboss(s); const out = new ImageBuffer(s.width, s.height); for (let i = 0; i < s.data.length; i += 4) { out.data[i] = clamp8(e.data[i] + 20); out.data[i + 1] = e.data[i + 1]; out.data[i + 2] = clamp8(e.data[i + 2] - 20); out.data[i + 3] = s.data[i + 3] } return blendMask(s, out, p.mask) } },
  { id: 'edgeColor', name: '彩色边缘', group: '风格化', ...meta([]),
    fn: (s, p) => { const e = edge(s); const out = new ImageBuffer(s.width, s.height); for (let i = 0; i < s.data.length; i += 4) { const v = e.data[i] / 255; out.data[i] = clamp8(s.data[i] * v * 2.2); out.data[i + 1] = clamp8(s.data[i + 1] * v * 2.2); out.data[i + 2] = clamp8(s.data[i + 2] * v * 2.2); out.data[i + 3] = s.data[i + 3] } return blendMask(s, out, p.mask) } },
  { id: 'outline', name: '描边', group: '风格化', ...meta([]),
    fn: (s, p) => { const e = edge(s); const out = new ImageBuffer(s.width, s.height); for (let i = 0; i < s.data.length; i += 4) { const v = 255 - clamp8(e.data[i]); out.data[i] = out.data[i + 1] = out.data[i + 2] = v; out.data[i + 3] = s.data[i + 3] } return blendMask(s, out, p.mask) } },
  { id: 'sharpenStrong', name: '强锐化', group: '风格化', ...meta([]), fn: (s, p) => blendMask(s, sharpen(s, 3), p.mask) },
  { id: 'unsharp', name: '反锐化蒙版', group: '风格化', ...meta([{ key: 'amount', label: '强度', min: 0, max: 5, default: 1.2 }]), fn: unsharpEffect },
  { id: 'softenStrong', name: '强柔光', group: '风格化', ...meta([]), fn: (s, p) => blendMask(s, soften(s, 1), p.mask) },
  { id: 'plastic', name: '塑料效果', group: '风格化', ...meta([]),
    fn: (s, p) => { const q = quantizeEffect(s, 4, false, null); const e = edge(s); const out = new ImageBuffer(s.width, s.height); for (let i = 0; i < s.data.length; i += 4) { const v = 1 - clamp8(e.data[i]) / 255 * 0.6; out.data[i] = q.data[i] * v; out.data[i + 1] = q.data[i + 1] * v; out.data[i + 2] = q.data[i + 2] * v; out.data[i + 3] = s.data[i + 3] } return blendMask(s, out, p.mask) } },
  { id: 'glow', name: '辉光', group: '风格化', ...meta([
    { key: 'amount', label: '光晕', min: 0, max: 3, default: 0.8 },
    { key: 'threshold', label: '阈值', min: 0, max: 255, default: 150 }
  ]), fn: glowEffect },
  { id: 'noise', name: '噪点', group: '风格化', ...meta([{ key: 'amount', label: '噪点强度', min: 0, max: 100, default: 30 }]),
    fn: (s, p) => { const a = p.amount ?? 30; return px(s, p, (r, g, b, x, y) => { const n = (hash2(x, y, 3) - 0.5) * a; return [r + n, g + n, b + n] }) } },
  { id: 'oilPaint', name: '油画', group: '风格化', ...meta([{ key: 'levels', label: '色阶', min: 2, max: 16, default: 6 }]),
    fn: (s, p) => quantizeEffect(s, p.levels ?? 6, true, p.mask) },
  { id: 'watercolor', name: '水彩', group: '风格化', ...meta([{ key: 'levels', label: '色阶', min: 2, max: 16, default: 8 }]), fn: watercolorEffect },
  { id: 'sketch', name: '素描', group: '风格化', ...meta([]), fn: sketchEffect },
  { id: 'pencil', name: '铅笔', group: '风格化', ...meta([]),
    fn: (s, p) => { const e = edge(s); const out = new ImageBuffer(s.width, s.height); for (let i = 0; i < s.data.length; i += 4) { const v = clamp8(235 - e.data[i] * 0.9); out.data[i] = out.data[i + 1] = out.data[i + 2] = v; out.data[i + 3] = s.data[i + 3] } return blendMask(s, out, p.mask) } },
  { id: 'charcoal', name: '炭笔', group: '风格化', ...meta([]), fn: charcoalEffect },
  { id: 'halftone', name: '半色调', group: '风格化', ...meta([{ key: 'size', label: '网点尺寸', min: 2, max: 24, default: 6 }]), fn: halftoneEffect },
  { id: 'crystallize', name: '晶格', group: '风格化', ...meta([{ key: 'size', label: '晶格尺寸', min: 2, max: 40, default: 8 }]), fn: crystallizeEffect },
  { id: 'traceContour', name: '轮廓追踪', group: '风格化', ...meta([{ key: 'threshold', label: '阈值', min: 1, max: 128, default: 40 }]), fn: traceContourEffect },
  { id: 'diffuse', name: '扩散', group: '风格化', ...meta([{ key: 'radius', label: '扩散半径', min: 0, max: 16, default: 3 }]), fn: diffuseEffect },
  { id: 'embossSoft', name: '柔和浮雕', group: '风格化', ...meta([]),
    fn: (s, p) => { const e = convolve3(s, [-1, -1, 0, -1, 1, 0, 0, 0, 1], 1, 128); const out = new ImageBuffer(s.width, s.height); for (let i = 0; i < s.data.length; i += 4) { for (let k = 0; k < 3; k += 1) out.data[i + k] = s.data[i + k] * 0.5 + e.data[i + k] * 0.5; out.data[i + 3] = s.data[i + 3] } return blendMask(s, out, p.mask) } },
  { id: 'relief', name: '凸起', group: '风格化', ...meta([]),
    fn: (s, p) => { const e = convolve3(s, [1, 0, -1, 0, 0, 0, -1, 0, 1], 1, 128); const out = new ImageBuffer(s.width, s.height); for (let i = 0; i < s.data.length; i += 4) { out.data[i] = clamp8(e.data[i] + 30); out.data[i + 1] = e.data[i + 1]; out.data[i + 2] = clamp8(e.data[i + 2] - 30); out.data[i + 3] = s.data[i + 3] } return blendMask(s, out, p.mask) } }
]

const FILTER_LIST = EFFECTS.map(({ id, name, group, params, defaultParams }) => ({ id, name, group, params, defaultParams }))

function apply(src, id, params = {}) {
  const effect = EFFECTS.find((e) => e.id === id)
  return effect ? effect.fn(src, params) : src.clone()
}

module.exports = {
  EFFECTS, FILTER_LIST, apply, sharpen, emboss, edge, sepia, tint, highContrastBW,
  soften, pixelate, mosaic, convolve3, blendMask, mapPixels
}
