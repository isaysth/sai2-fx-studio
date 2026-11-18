/**
 * 色彩空间换算（纯函数，无副作用、无第三方依赖）。
 *
 * 输入均为 [r,g,b] 数组（0..255）或相应的 HSV/Lab 数组，输出同约定。
 * 所有函数对非有限值做兜底、对输出做钳制，保证不产生 NaN。
 */
'use strict'

function finite(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/** 0..255 -> 0..1 */
function toUnit(v) {
  return clamp(finite(v) / 255, 0, 1)
}

/** 钳制到 0..255 并取整 */
function toByte(v) {
  return Math.round(clamp(finite(v), 0, 255))
}

/** sRGB 分量（0..1）转线性光 */
function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/** 线性光转 sRGB 分量（0..1） */
function linearToSrgb(c) {
  const v = clamp(c, 0, 1)
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
}

/** 取数组第 i 项，非数组或越界时取 0 */
function at(arr, i) {
  return Array.isArray(arr) ? finite(arr[i], 0) : 0
}

/** [r,g,b] -> [h(0..360), s(0..1), v(0..1)] */
function rgbToHsv(rgb) {
  const r = toUnit(at(rgb, 0))
  const g = toUnit(at(rgb, 1))
  const b = toUnit(at(rgb, 2))
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  const s = max === 0 ? 0 : d / max
  return [clamp(h, 0, 360), clamp(s, 0, 1), clamp(max, 0, 1)]
}

/** [h(0..360), s(0..1), v(0..1)] -> [r,g,b] */
function hsvToRgb(hsv) {
  let h = finite(at(hsv, 0), 0) % 360
  if (h < 0) h += 360
  const s = clamp(finite(at(hsv, 1), 0), 0, 1)
  const v = clamp(finite(at(hsv, 2), 0), 0, 1)
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) { r = c; g = x } else if (h < 120) { r = x; g = c } else if (h < 180) { g = c; b = x } else if (h < 240) { g = x; b = c } else if (h < 300) { r = x; b = c } else { r = c; b = x }
  return [toByte((r + m) * 255), toByte((g + m) * 255), toByte((b + m) * 255)]
}

// sRGB(D65) -> XYZ 矩阵（归一化到 Y=1 白点）
const M_RGB2XYZ = [
  0.4124564, 0.3575761, 0.1804375,
  0.2126729, 0.7151522, 0.0721750,
  0.0193339, 0.1191920, 0.9503041
]
// XYZ -> sRGB(D65) 逆矩阵
const M_XYZ2RGB = [
  3.2404542, -1.5371385, -0.4985314,
  -0.9692660, 1.8760108, 0.0415560,
  0.0556434, -0.2040259, 1.0572252
]
const WHITE = [0.95047, 1.0, 1.08883]
const EPS = 216 / 24389 // 0.008856
const KAPPA = 24389 / 27 // 903.3

/** [r,g,b] -> [L(0..100), a, b]，sRGB -> 线性 -> XYZ D65 -> CIE Lab */
function rgbToLab(rgb) {
  const rl = srgbToLinear(toUnit(at(rgb, 0)))
  const gl = srgbToLinear(toUnit(at(rgb, 1)))
  const bl = srgbToLinear(toUnit(at(rgb, 2)))
  const x = (M_RGB2XYZ[0] * rl + M_RGB2XYZ[1] * gl + M_RGB2XYZ[2] * bl) / WHITE[0]
  const y = (M_RGB2XYZ[3] * rl + M_RGB2XYZ[4] * gl + M_RGB2XYZ[5] * bl) / WHITE[1]
  const z = (M_RGB2XYZ[6] * rl + M_RGB2XYZ[7] * gl + M_RGB2XYZ[8] * bl) / WHITE[2]
  const fx = x > EPS ? Math.cbrt(x) : (KAPPA * x + 16) / 116
  const fy = y > EPS ? Math.cbrt(y) : (KAPPA * y + 16) / 116
  const fz = z > EPS ? Math.cbrt(z) : (KAPPA * z + 16) / 116
  return [clamp(116 * fy - 16, 0, 100), 500 * (fx - fy), 200 * (fy - fz)]
}

/** [L,a,b] -> [r,g,b] */
function labToRgb(lab) {
  const L = clamp(finite(at(lab, 0), 0), 0, 100)
  const a = finite(at(lab, 1), 0)
  const b = finite(at(lab, 2), 0)
  const fy = (L + 16) / 116
  const fx = fy + a / 500
  const fz = fy - b / 200
  const x = WHITE[0] * (fx * fx * fx > EPS ? fx * fx * fx : (fx - 16 / 116) / KAPPA)
  const y = WHITE[1] * (fy * fy * fy > EPS ? fy * fy * fy : (fy - 16 / 116) / KAPPA)
  const z = WHITE[2] * (fz * fz * fz > EPS ? fz * fz * fz : (fz - 16 / 116) / KAPPA)
  const rl = M_XYZ2RGB[0] * x + M_XYZ2RGB[1] * y + M_XYZ2RGB[2] * z
  const gl = M_XYZ2RGB[3] * x + M_XYZ2RGB[4] * y + M_XYZ2RGB[5] * z
  const bl = M_XYZ2RGB[6] * x + M_XYZ2RGB[7] * y + M_XYZ2RGB[8] * z
  return [toByte(linearToSrgb(rl) * 255), toByte(linearToSrgb(gl) * 255), toByte(linearToSrgb(bl) * 255)]
}

/** [r,g,b] -> '#RRGGBB'（大写） */
function rgbToHex(rgb) {
  const hex = [toByte(at(rgb, 0)), toByte(at(rgb, 1)), toByte(at(rgb, 2))]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')
  return '#' + hex.toUpperCase()
}

/** '#RRGGBB'（或 '#RGB'）-> [r,g,b]；非法输入回退为 [0,0,0] */
function hexToRgb(hex) {
  if (typeof hex !== 'string') return [0, 0, 0]
  let s = hex.trim()
  if (s[0] === '#') s = s.slice(1)
  if (/^[0-9a-fA-F]{3}$/.test(s)) s = s.split('').map((c) => c + c).join('')
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return [0, 0, 0]
  return [
    parseInt(s.slice(0, 2), 16),
    parseInt(s.slice(2, 4), 16),
    parseInt(s.slice(4, 6), 16)
  ]
}

/** Rec.709 相对亮度，返回 0..255 */
function luminance(r, g, b) {
  const v = 0.2126 * finite(r) + 0.7152 * finite(g) + 0.0722 * finite(b)
  return Math.round(clamp(v, 0, 255))
}

/**
 * 渐变取色：stops 为 [{pos:0..1, color:[r,g,b]}]，按 t 线性插值。
 * t 钳制到 0..1，结果分量钳制到 0..255。
 */
function gradientColor(stops, t) {
  if (!Array.isArray(stops) || stops.length === 0) return [0, 0, 0]
  const list = stops
    .map((s) => ({ pos: clamp(finite(s && s.pos, 0), 0, 1), color: s && s.color ? s.color : [0, 0, 0] }))
    .sort((a, b) => a.pos - b.pos)
  const tt = clamp(finite(t, 0), 0, 1)
  if (tt <= list[0].pos) return list[0].color.map(toByte)
  const last = list[list.length - 1]
  if (tt >= last.pos) return last.color.map(toByte)

  for (let i = 0; i < list.length - 1; i += 1) {
    const a = list[i]
    const b = list[i + 1]
    if (tt >= a.pos && tt <= b.pos) {
      const span = b.pos - a.pos
      const f = span > 0 ? (tt - a.pos) / span : 0
      return [0, 1, 2].map((k) => toByte(finite(at(a.color, k), 0) + (finite(at(b.color, k), 0) - finite(at(a.color, k), 0)) * f))
    }
  }
  return last.color.map(toByte)
}

module.exports = {
  rgbToHsv, hsvToRgb, rgbToLab, labToRgb,
  rgbToHex, hexToRgb, luminance, gradientColor
}
