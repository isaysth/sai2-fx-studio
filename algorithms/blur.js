/**
 * 模糊算法（JS 移植，来源：上游 plugins/blur/src/BlurKernels.h）。
 * 10 种：box / gaussian / motion / zoom /
 *        radial / surface / special / lens / average / perspective。
 * box/gaussian 用可分离卷积；方向性模糊用固定采样数近似，
 * 复杂度 O(w*h*S)（S 为固定采样数），与半径解耦，避免 O(radius^3)。
 *
 * mask 语义：Uint8Array(w*h)，out = orig*(1-a) + result*a, a = mask[i]/255。
 */
'use strict'

const { ImageBuffer, clamp8 } = require('../core/image.js')

/** 按 mask 线性混合 orig 与 result */
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

function clampX(x, w) { return x < 0 ? 0 : x > w - 1 ? w - 1 : x }
function clampY(y, h) { return y < 0 ? 0 : y > h - 1 ? h - 1 : y }

/** 盒式模糊：分离式滑动窗口，O(n) 与半径无关 */
function boxBlur(src, radius, mask) {
  const r = Math.max(0, Math.round(radius))
  if (r === 0) return blendMask(src, src.clone(), mask)
  const { width: w, height: h, data } = src
  const tmp = new Uint8ClampedArray(data.length)
  const out = new Uint8ClampedArray(data.length)
  const win = r * 2 + 1

  // 水平
  for (let y = 0; y < h; y += 1) {
    for (let c = 0; c < 4; c += 1) {
      let sum = 0
      for (let k = -r; k <= r; k += 1) sum += data[(y * w + clampX(k, w)) * 4 + c]
      for (let x = 0; x < w; x += 1) {
        tmp[(y * w + x) * 4 + c] = sum / win
        sum += data[(y * w + clampX(x + r + 1, w)) * 4 + c] - data[(y * w + clampX(x - r, w)) * 4 + c]
      }
    }
  }
  // 垂直
  for (let x = 0; x < w; x += 1) {
    for (let c = 0; c < 4; c += 1) {
      let sum = 0
      for (let k = -r; k <= r; k += 1) sum += tmp[(clampY(k, h) * w + x) * 4 + c]
      for (let y = 0; y < h; y += 1) {
        out[(y * w + x) * 4 + c] = sum / win
        sum += tmp[(clampY(y + r + 1, h) * w + x) * 4 + c] - tmp[(clampY(y - r, h) * w + x) * 4 + c]
      }
    }
  }
  return blendMask(src, new ImageBuffer(w, h, out), mask)
}

/** 高斯核（一维，归一化） */
function gaussianKernel(radius, sigma) {
  const r = Math.max(1, Math.round(radius))
  const s = sigma || Math.max(0.5, r / 2)
  const k = []
  let sum = 0
  for (let i = -r; i <= r; i += 1) {
    const v = Math.exp(-(i * i) / (2 * s * s))
    k.push(v)
    sum += v
  }
  return k.map((v) => v / sum)
}

/** 高斯模糊：分离式卷积 */
function gaussianBlur(src, radius, sigma, mask) {
  const r = Math.max(0, Math.round(radius))
  if (r === 0) return blendMask(src, src.clone(), mask)
  const { width: w, height: h, data } = src
  const kernel = gaussianKernel(r, sigma)
  const tmp = new Uint8ClampedArray(data.length)
  const out = new Uint8ClampedArray(data.length)

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      for (let c = 0; c < 4; c += 1) {
        let acc = 0
        for (let i = -r; i <= r; i += 1) acc += data[(y * w + clampX(x + i, w)) * 4 + c] * kernel[i + r]
        tmp[(y * w + x) * 4 + c] = acc
      }
    }
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      for (let c = 0; c < 4; c += 1) {
        let acc = 0
        for (let i = -r; i <= r; i += 1) acc += tmp[(clampY(y + i, h) * w + x) * 4 + c] * kernel[i + r]
        out[(y * w + x) * 4 + c] = acc
      }
    }
  }
  return blendMask(src, new ImageBuffer(w, h, out), mask)
}

/** 运动模糊：沿方向固定采样数平均 */
function motionBlur(src, distance, angleDeg, mask) {
  const d = Math.max(0, Math.round(distance))
  if (d === 0) return blendMask(src, src.clone(), mask)
  const { width: w, height: h, data } = src
  const out = new Uint8ClampedArray(data.length)
  const a = (angleDeg * Math.PI) / 180
  const dx = Math.cos(a)
  const dy = Math.sin(a)
  const samples = d * 2 + 1
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      for (let c = 0; c < 4; c += 1) {
        let acc = 0
        for (let s = 0; s < samples; s += 1) {
          const t = s - d
          acc += data[(clampY(Math.round(y + dy * t), h) * w + clampX(Math.round(x + dx * t), w)) * 4 + c]
        }
        out[(y * w + x) * 4 + c] = acc / samples
      }
    }
  }
  return blendMask(src, new ImageBuffer(w, h, out), mask)
}

/** 缩放模糊：从中心向外放射采样（固定 16 采样） */
function zoomBlur(src, strength, centerX, centerY, mask) {
  const z = Math.max(0, Math.min(1, strength))
  if (z === 0) return blendMask(src, src.clone(), mask)
  const { width: w, height: h, data } = src
  const out = new Uint8ClampedArray(data.length)
  const cx = centerX == null ? w / 2 : centerX
  const cy = centerY == null ? h / 2 : centerY
  const samples = 16
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      for (let c = 0; c < 4; c += 1) {
        let acc = 0
        for (let s = 0; s < samples; s += 1) {
          const t = 1 - (z * s) / samples
          const sx = clampX(Math.round(cx + (x - cx) * t), w)
          const sy = clampY(Math.round(cy + (y - cy) * t), h)
          acc += data[(sy * w + sx) * 4 + c]
        }
        out[(y * w + x) * 4 + c] = acc / samples
      }
    }
  }
  return blendMask(src, new ImageBuffer(w, h, out), mask)
}

/** 径向模糊：沿每个像素的径向轴双向采样，形成放射拉丝 */
function radialBlur(src, radius = 10, centerX, centerY, mask) {
  const r = Math.max(0, radius)
  if (r === 0) return blendMask(src, src.clone(), mask)
  const { width: w, height: h, data } = src
  const out = new Uint8ClampedArray(data.length)
  const cx = centerX == null ? w / 2 : centerX
  const cy = centerY == null ? h / 2 : centerY
  const samples = 16
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const vx = x - cx
      const vy = y - cy
      const len = Math.hypot(vx, vy) || 1
      const ux = vx / len
      const uy = vy / len
      for (let c = 0; c < 4; c += 1) {
        let acc = 0
        for (let s = 0; s < samples; s += 1) {
          const t = ((s / (samples - 1)) * 2 - 1) * r
          const sx = clampX(Math.round(x + ux * t), w)
          const sy = clampY(Math.round(y + uy * t), h)
          acc += data[(sy * w + sx) * 4 + c]
        }
        out[(y * w + x) * 4 + c] = acc / samples
      }
    }
  }
  return blendMask(src, new ImageBuffer(w, h, out), mask)
}

/** 表面模糊：保边卷积，仅平均颜色距离小于阈值的邻域像素 */
function surfaceBlur(src, radius = 5, threshold = 30, mask) {
  const r = Math.max(0, Math.min(8, Math.round(radius)))
  if (r === 0) return blendMask(src, src.clone(), mask)
  const { width: w, height: h, data } = src
  const out = new Uint8ClampedArray(data.length)
  const th2 = Math.max(0, threshold) ** 2
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const ci = (y * w + x) * 4
      const cr = data[ci], cg = data[ci + 1], cb = data[ci + 2]
      let sr = 0, sg = 0, sb = 0, sa = 0, n = 0
      for (let dy = -r; dy <= r; dy += 1) {
        const sy = clampY(y + dy, h)
        for (let dx = -r; dx <= r; dx += 1) {
          const sx = clampX(x + dx, w)
          const i = (sy * w + sx) * 4
          const dr = data[i] - cr, dg = data[i + 1] - cg, db = data[i + 2] - cb
          if (dr * dr + dg * dg + db * db > th2) continue
          sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; sa += data[i + 3]; n += 1
        }
      }
      if (!n) { n = 1; sr = cr; sg = cg; sb = cb; sa = data[ci + 3] }
      out[ci] = sr / n; out[ci + 1] = sg / n; out[ci + 2] = sb / n; out[ci + 3] = sa / n
    }
  }
  return blendMask(src, new ImageBuffer(w, h, out), mask)
}

/** 特殊模糊：沿局部边缘切线方向采样，平滑边缘而不糊化轮廓 */
function specialBlur(src, radius = 6, mask) {
  const r = Math.max(0, Math.round(radius))
  if (r === 0) return blendMask(src, src.clone(), mask)
  const { width: w, height: h, data } = src
  const out = new Uint8ClampedArray(data.length)
  const samples = 9
  const lum = (x, y) => {
    const i = (clampY(y, h) * w + clampX(x, w)) * 4
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const gx = (lum(x + 1, y - 1) + 2 * lum(x + 1, y) + lum(x + 1, y + 1))
        - (lum(x - 1, y - 1) + 2 * lum(x - 1, y) + lum(x - 1, y + 1))
      const gy = (lum(x - 1, y + 1) + 2 * lum(x, y + 1) + lum(x + 1, y + 1))
        - (lum(x - 1, y - 1) + 2 * lum(x, y - 1) + lum(x + 1, y - 1))
      const gl = Math.hypot(gx, gy)
      const ux = gl < 1e-3 ? 1 : -gy / gl
      const uy = gl < 1e-3 ? 0 : gx / gl
      for (let c = 0; c < 4; c += 1) {
        let acc = 0
        for (let s = 0; s < samples; s += 1) {
          const t = ((s / (samples - 1)) * 2 - 1) * r
          const sx = clampX(Math.round(x + ux * t), w)
          const sy = clampY(Math.round(y + uy * t), h)
          acc += data[(sy * w + sx) * 4 + c]
        }
        out[(y * w + x) * 4 + c] = acc / samples
      }
    }
  }
  return blendMask(src, new ImageBuffer(w, h, out), mask)
}

/** 镜头模糊：圆盘采样，半径随离中心距离增大（散景感） */
function lensBlur(src, radius = 12, centerX, centerY, mask) {
  const r = Math.max(0, radius)
  if (r === 0) return blendMask(src, src.clone(), mask)
  const { width: w, height: h, data } = src
  const out = new Uint8ClampedArray(data.length)
  const cx = centerX == null ? w / 2 : centerX
  const cy = centerY == null ? h / 2 : centerY
  const maxDist = Math.max(1, Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy)))
  const angles = 12
  const rings = [0.5, 1]
  // 预计算圆盘采样偏移，避免逐像素重复三角函数
  const offsets = []
  for (const ring of rings) {
    for (let a = 0; a < angles; a += 1) {
      const th = (a / angles) * Math.PI * 2
      offsets.push([Math.cos(th) * ring, Math.sin(th) * ring])
    }
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const distN = Math.min(1, Math.hypot(x - cx, y - cy) / maxDist)
      const localR = r * (0.25 + 0.75 * distN)
      for (let c = 0; c < 4; c += 1) {
        let acc = 0
        for (const [ox, oy] of offsets) {
          const sx = clampX(Math.round(x + ox * localR), w)
          const sy = clampY(Math.round(y + oy * localR), h)
          acc += data[(sy * w + sx) * 4 + c]
        }
        out[(y * w + x) * 4 + c] = acc / offsets.length
      }
    }
  }
  return blendMask(src, new ImageBuffer(w, h, out), mask)
}

/** 平均模糊：大半径盒式降采样（滑动窗口，O(n)） */
function averageBlur(src, radius = 20, mask) {
  return boxBlur(src, radius, mask)
}

/** 透视模糊：核半径沿投影方向线性递增（横向拉丝逐渐变宽） */
function perspectiveBlur(src, radius = 12, angle = 0, mask) {
  const r = Math.max(0, radius)
  if (r === 0) return blendMask(src, src.clone(), mask)
  const { width: w, height: h, data } = src
  const out = new Uint8ClampedArray(data.length)
  const a = (angle * Math.PI) / 180
  const ux = Math.cos(a), uy = Math.sin(a)
  const span = Math.max(1, w * ux + h * uy)
  const samples = 12
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const proj = Math.max(0, Math.min(1, (x * ux + y * uy) / span))
      const localR = r * proj
      for (let c = 0; c < 4; c += 1) {
        let acc = 0
        for (let s = 0; s < samples; s += 1) {
          const t = ((s / (samples - 1)) * 2 - 1) * localR
          const sx = clampX(Math.round(x + t), w)
          acc += data[(clampY(y, h) * w + sx) * 4 + c]
        }
        out[(y * w + x) * 4 + c] = acc / samples
      }
    }
  }
  return blendMask(src, new ImageBuffer(w, h, out), mask)
}

/** 统一入口：type ∈ box|gaussian|motion|zoom|radial|surface|special|lens|average|perspective */
function blur(src, type, params = {}) {
  switch (type) {
    case 'box': return boxBlur(src, params.radius ?? 3, params.mask)
    case 'motion': return motionBlur(src, params.distance ?? 5, params.angle ?? 0, params.mask)
    case 'zoom': return zoomBlur(src, params.strength ?? 0.3, params.centerX, params.centerY, params.mask)
    case 'radial': return radialBlur(src, params.radius ?? 10, params.centerX, params.centerY, params.mask)
    case 'surface': return surfaceBlur(src, params.radius ?? 5, params.threshold ?? 30, params.mask)
    case 'special': return specialBlur(src, params.radius ?? 6, params.mask)
    case 'lens': return lensBlur(src, params.radius ?? 12, params.centerX, params.centerY, params.mask)
    case 'average': return averageBlur(src, params.radius ?? 20, params.mask)
    case 'perspective': return perspectiveBlur(src, params.radius ?? 12, params.angle ?? 0, params.mask)
    case 'gaussian':
    default: return gaussianBlur(src, params.radius ?? 3, params.sigma, params.mask)
  }
}

module.exports = {
  blur, boxBlur, gaussianBlur, motionBlur, zoomBlur, gaussianKernel,
  radialBlur, surfaceBlur, specialBlur, lensBlur, averageBlur, perspectiveBlur,
  blendMask, clamp8
}
