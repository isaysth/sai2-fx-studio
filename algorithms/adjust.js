/**
 * 调整算法（JS 移植，来源：上游 plugins/adjust/src/AdjustKernels.h）。
 * 反相 / 去色 / 亮度对比度 / 色相饱和度 / 色阶 /
 * 阈值 / 色调分离 / 色彩平衡 / 渐变映射 / 曲线。
 * 全部是逐像素点运算，支持选区（mask 可选）。
 *
 * mask 语义：Uint8Array，长度 w*h，取值 0..255。
 *   out = orig*(1-a) + result*a,  a = mask[i]/255
 * 即对 mask 做线性混合：0 完全保留原图，255 完全生效。
 */
'use strict'

const { ImageBuffer, clamp8 } = require('../core/image.js')

/** 按 mask 线性混合 orig 与 result（mask 为 undefined 时直接返回 result） */
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

/** 亮度（Rec.601 luma，0..255） */
function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

function invert(src, mask) {
  const out = src.clone()
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 255 - out.data[i]
    out.data[i + 1] = 255 - out.data[i + 1]
    out.data[i + 2] = 255 - out.data[i + 2]
  }
  return blendMask(src, out, mask)
}

function grayscale(src, mask) {
  const out = src.clone()
  for (let i = 0; i < out.data.length; i += 4) {
    const g = Math.round(luma(out.data[i], out.data[i + 1], out.data[i + 2]))
    out.data[i] = out.data[i + 1] = out.data[i + 2] = g
  }
  return blendMask(src, out, mask)
}

/** brightness: -255..255；contrast: -100..100 */
function brightnessContrast(src, brightness = 0, contrast = 0, mask) {
  const out = src.clone()
  const c = (259 * (contrast + 255)) / (255 * (259 - contrast))
  for (let i = 0; i < out.data.length; i += 4) {
    for (let k = 0; k < 3; k += 1) {
      out.data[i + k] = clamp8(c * (out.data[i + k] - 128) + 128 + brightness)
    }
  }
  return blendMask(src, out, mask)
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  const s = max === 0 ? 0 : d / max
  return [h, s, max]
}

function hsvToRgb(h, s, v) {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let r = 0, g = 0, b = 0
  if (h < 60) { r = c; g = x }
  else if (h < 120) { r = x; g = c }
  else if (h < 180) { g = c; b = x }
  else if (h < 240) { g = x; b = c }
  else if (h < 300) { r = x; b = c }
  else { r = c; b = x }
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255]
}

/** hue: -180..180 度；sat/light 为倍率 0..2 */
function hueSaturation(src, hue = 0, sat = 1, light = 1, mask) {
  const out = src.clone()
  for (let i = 0; i < out.data.length; i += 4) {
    const [h, s, v] = rgbToHsv(out.data[i], out.data[i + 1], out.data[i + 2])
    const rgb = hsvToRgb((h + hue + 360) % 360, Math.max(0, Math.min(1, s * sat)), Math.max(0, Math.min(1, v * light)))
    out.data[i] = clamp8(rgb[0])
    out.data[i + 1] = clamp8(rgb[1])
    out.data[i + 2] = clamp8(rgb[2])
  }
  return blendMask(src, out, mask)
}

/** 色阶：black/white 为 0..255，gamma 约 0.1..10 */
function levels(src, black = 0, white = 255, gamma = 1, mask) {
  const out = src.clone()
  const span = Math.max(1, white - black)
  const invGamma = 1 / Math.max(0.01, gamma)
  const lut = new Uint8ClampedArray(256)
  for (let v = 0; v < 256; v += 1) {
    const t = Math.max(0, Math.min(1, (v - black) / span))
    lut[v] = clamp8(Math.pow(t, invGamma) * 255)
  }
  for (let i = 0; i < out.data.length; i += 4) {
    for (let k = 0; k < 3; k += 1) out.data[i + k] = lut[out.data[i + k]]
  }
  return blendMask(src, out, mask)
}

/** 阈值：按亮度二值化，threshold 为 0..255 */
function threshold(src, threshold = 128, mask) {
  const t = Math.max(0, Math.min(255, threshold))
  const out = src.clone()
  for (let i = 0; i < out.data.length; i += 4) {
    const v = luma(out.data[i], out.data[i + 1], out.data[i + 2]) >= t ? 255 : 0
    out.data[i] = out.data[i + 1] = out.data[i + 2] = v
  }
  return blendMask(src, out, mask)
}

/** 色调分离：逐通道量化到 levels 级（2..16） */
function posterize(src, steps = 5, mask) {
  const n = Math.max(2, Math.min(16, Math.round(steps)))
  const scale = 255 / (n - 1)
  const out = src.clone()
  for (let i = 0; i < out.data.length; i += 4) {
    for (let k = 0; k < 3; k += 1) {
      out.data[i + k] = clamp8(Math.round(out.data[i + k] / scale) * scale)
    }
  }
  return blendMask(src, out, mask)
}

/** 色彩平衡：三轴偏移 -100..100（青↔红 / 品红↔绿 / 黄↔蓝） */
function colorBalance(src, cyanRed = 0, magentaGreen = 0, yellowBlue = 0, mask) {
  const out = src.clone()
  const shifts = [cyanRed, magentaGreen, yellowBlue].map((v) => Math.max(-100, Math.min(100, v)) * 1.28)
  for (let i = 0; i < out.data.length; i += 4) {
    for (let k = 0; k < 3; k += 1) out.data[i + k] = clamp8(out.data[i + k] + shifts[k])
  }
  return blendMask(src, out, mask)
}

/** 渐变映射：stops 为 {pos:0..1, color:[r,g,b]} 数组，按亮度插值；缺省黑白 */
function gradientMap(src, stops, mask) {
  let pts = Array.isArray(stops) && stops.length
    ? stops.map((s) => ({ pos: Math.max(0, Math.min(1, s.pos || 0)), color: s.color || [0, 0, 0] }))
    : [{ pos: 0, color: [0, 0, 0] }, { pos: 1, color: [255, 255, 255] }]
  pts = pts.slice().sort((a, b) => a.pos - b.pos)
  const out = src.clone()
  for (let i = 0; i < out.data.length; i += 4) {
    const t = luma(out.data[i], out.data[i + 1], out.data[i + 2]) / 255
    let k = 0
    while (k < pts.length - 1 && pts[k + 1].pos < t) k += 1
    const a = pts[k]
    const b = pts[Math.min(k + 1, pts.length - 1)]
    const span = b.pos - a.pos
    const f = span > 0 ? Math.max(0, Math.min(1, (t - a.pos) / span)) : 0
    for (let c = 0; c < 3; c += 1) {
      out.data[i + c] = clamp8((a.color[c] || 0) * (1 - f) + (b.color[c] || 0) * f)
    }
  }
  return blendMask(src, out, mask)
}

/** 由控制点 {x,y}（x 升序）生成 256 项曲线查找表 */
function curveLUT(points) {
  const pts = Array.isArray(points) && points.length
    ? points.slice().sort((a, b) => a.x - b.x)
    : [{ x: 0, y: 0 }, { x: 1, y: 1 }]
  const lut = new Uint8ClampedArray(256)
  for (let v = 0; v < 256; v += 1) {
    const t = v / 255
    let y
    if (t <= pts[0].x) y = pts[0].y
    else if (t >= pts[pts.length - 1].x) y = pts[pts.length - 1].y
    else {
      let k = 0
      while (k < pts.length - 1 && pts[k + 1].x < t) k += 1
      const a = pts[k]
      const b = pts[k + 1]
      const span = (b.x - a.x) || 1
      y = a.y + (b.y - a.y) * ((t - a.x) / span)
    }
    lut[v] = clamp8(y * 255)
  }
  return lut
}

/** 曲线：points 为 {x:0..1,y:0..1} 数组（按 x 升序），分段线性映射亮度与 RGB 通道 */
function curves(src, points, mask) {
  const lut = curveLUT(points)
  const out = src.clone()
  for (let i = 0; i < out.data.length; i += 4) {
    for (let k = 0; k < 3; k += 1) out.data[i + k] = lut[out.data[i + k]]
  }
  return blendMask(src, out, mask)
}

function apply(src, effect, params = {}) {
  switch (effect) {
    case 'invert': return invert(src, params.mask)
    case 'grayscale': return grayscale(src, params.mask)
    case 'brightnessContrast': return brightnessContrast(src, params.brightness ?? 0, params.contrast ?? 0, params.mask)
    case 'hueSaturation': return hueSaturation(src, params.hue ?? 0, params.saturation ?? 1, params.lightness ?? 1, params.mask)
    case 'levels': return levels(src, params.black ?? 0, params.white ?? 255, params.gamma ?? 1, params.mask)
    case 'threshold': return threshold(src, params.threshold ?? 128, params.mask)
    case 'posterize': return posterize(src, params.levels ?? 5, params.mask)
    case 'colorBalance': return colorBalance(src, params.cyanRed ?? 0, params.magentaGreen ?? 0, params.yellowBlue ?? 0, params.mask)
    case 'gradientMap': return gradientMap(src, params.stops, params.mask)
    case 'curves': return curves(src, params.points, params.mask)
    default: return src.clone()
  }
}

module.exports = {
  apply, invert, grayscale, brightnessContrast, hueSaturation, levels,
  threshold, posterize, colorBalance, gradientMap, curves,
  blendMask, luma, curveLUT, rgbToHsv, hsvToRgb
}
