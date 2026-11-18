/**
 * 算法引擎扩展测试（无第三方依赖）：node tests/algorithms.test.js
 * 覆盖：新增 adjust 效果、mask 线性混合边界、新增 blur 类型、
 *       FILTER_LIST 数量/唯一性/可应用性、liquify 新方法与 render。
 */
'use strict'

const assert = require('node:assert/strict')
const { ImageBuffer } = require('../core/image.js')
const adjust = require('../algorithms/adjust.js')
const blur = require('../algorithms/blur.js')
const filters = require('../algorithms/filters.js')
const { LiquifySession } = require('../algorithms/liquify.js')

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok - ${name}`)
  } catch (err) {
    failed += 1
    console.error(`  not ok - ${name}\n      ${err.message}`)
  }
}

/** 手工填充的 8x8 测试图，像素值有足够变化 */
function makeImage() {
  const img = new ImageBuffer(8, 8)
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      img.setPixel(x, y, (x * 31 + y * 7) % 256, (x * 11 + y * 53) % 256, (x * 47 + y * 13) % 256, 255)
    }
  }
  return img
}

function fullMask(value, n = 64) {
  return new Uint8Array(n).fill(value)
}

function differs(a, b) {
  if (a.width !== b.width || a.height !== b.height) return true
  for (let i = 0; i < a.data.length; i += 1) if (a.data[i] !== b.data[i]) return true
  return false
}

function assertSize(img, w, h) {
  assert.equal(img.width, w, '输出宽度不符')
  assert.equal(img.height, h, '输出高度不符')
  assert.equal(img.data.length, w * h * 4, '输出数据长度不符')
}

function assertClosePixels(actual, expected, tol = 1) {
  assertSize(actual, expected.width, expected.height)
  for (let i = 0; i < expected.data.length; i += 1) {
    assert.ok(Math.abs(actual.data[i] - expected.data[i]) <= tol,
      `像素 ${i} 期望 ${expected.data[i]}，实际 ${actual.data[i]}`)
  }
}

// —— 新增 adjust 效果 ——
const NEW_ADJUST = [
  { id: 'threshold', params: { threshold: 100 } },
  { id: 'posterize', params: { levels: 4 } },
  { id: 'colorBalance', params: { cyanRed: 60, magentaGreen: -40, yellowBlue: 30 } },
  { id: 'gradientMap', params: { stops: [{ pos: 0, color: [0, 0, 0] }, { pos: 0.5, color: [255, 0, 0] }, { pos: 1, color: [255, 255, 0] }] } },
  { id: 'curves', params: { points: [{ x: 0, y: 0 }, { x: 0.5, y: 0.9 }, { x: 1, y: 1 }] } }
]

for (const { id, params } of NEW_ADJUST) {
  test(`adjust.${id} 对像素产生变化`, () => {
    const src = makeImage()
    const out = adjust.apply(src, id, params)
    assertSize(out, 8, 8)
    assert.ok(differs(src, out), `${id} 没有改变任何像素`)
  })
}

for (const { id, params } of NEW_ADJUST) {
  test(`adjust.${id} mask=0 保持原图`, () => {
    const src = makeImage()
    const out = adjust.apply(src, id, { ...params, mask: fullMask(0) })
    assertClosePixels(out, src, 0)
  })
}

for (const { id, params } of NEW_ADJUST) {
  test(`adjust.${id} mask=255 完全生效`, () => {
    const src = makeImage()
    const full = adjust.apply(src, id, params)
    const out = adjust.apply(src, id, { ...params, mask: fullMask(255) })
    assertClosePixels(out, full, 0)
  })
}

test('adjust mask 中间值产生线性混合', () => {
  const src = makeImage()
  const full = adjust.apply(src, 'threshold', { threshold: 100 })
  const mid = adjust.apply(src, 'threshold', { threshold: 100, mask: fullMask(128) })
  assert.ok(differs(mid, src), '半透明 mask 应改变原图')
  assert.ok(differs(mid, full), '半透明 mask 不应等同于全量效果')
})

test('adjust 既有效果仍支持 mask', () => {
  const src = makeImage()
  assertClosePixels(adjust.apply(src, 'invert', { mask: fullMask(0) }), src, 0)
  const full = adjust.apply(src, 'invert')
  assertClosePixels(adjust.apply(src, 'invert', { mask: fullMask(255) }), full, 0)
})

// —— 新增 blur 类型 ——
const NEW_BLURS = [
  { type: 'radial', params: { radius: 4 } },
  { type: 'surface', params: { radius: 3, threshold: 80 } },
  { type: 'special', params: { radius: 4 } },
  { type: 'lens', params: { radius: 4 } },
  { type: 'average', params: { radius: 16 } },
  { type: 'perspective', params: { radius: 6 } }
]

for (const { type, params } of NEW_BLURS) {
  test(`blur.${type} 不抛错且尺寸一致`, () => {
    const src = makeImage()
    const out = blur.blur(src, type, params)
    assertSize(out, 8, 8)
    assert.ok(differs(src, out), `${type} 没有改变任何像素`)
  })
}

for (const { type, params } of NEW_BLURS) {
  test(`blur.${type} mask=0 保持原图 / 255 完全生效`, () => {
    const src = makeImage()
    assertClosePixels(blur.blur(src, type, { ...params, mask: fullMask(0) }), src, 0)
    const full = blur.blur(src, type, params)
    assertClosePixels(blur.blur(src, type, { ...params, mask: fullMask(255) }), full, 0)
  })
}

test('blur 既有四种类型仍可用', () => {
  const src = makeImage()
  for (const type of ['box', 'gaussian', 'motion', 'zoom']) {
    assertSize(blur.blur(src, type, { radius: 3, distance: 3, strength: 0.4 }), 8, 8)
  }
})

// —— 滤镜库 ——
test('FILTER_LIST 至少 53 项且 id 唯一', () => {
  assert.ok(filters.FILTER_LIST.length >= 53, `仅 ${filters.FILTER_LIST.length} 项`)
  const ids = filters.FILTER_LIST.map((f) => f.id)
  assert.equal(new Set(ids).size, ids.length, '存在重复 id')
  for (const f of filters.FILTER_LIST) {
    assert.ok(f.id && f.name && f.group, `${f.id} 缺少基本字段`)
    assert.ok(Array.isArray(f.params), `${f.id} 缺少 params 数组`)
    assert.ok(f.defaultParams && typeof f.defaultParams === 'object', `${f.id} 缺少 defaultParams`)
    for (const p of f.params) {
      for (const key of ['key', 'label', 'min', 'max', 'default']) {
        assert.ok(Object.prototype.hasOwnProperty.call(p, key), `${f.id} 参数缺少 ${key}`)
      }
    }
  }
})

test('FILTER_LIST 保留原有 10 个 id', () => {
  const ids = new Set(filters.FILTER_LIST.map((f) => f.id))
  for (const id of ['sharpen', 'emboss', 'edge', 'sepia', 'cool', 'warm', 'bw', 'soften', 'pixelate', 'mosaic']) {
    assert.ok(ids.has(id), `缺少原有 id ${id}`)
  }
})

test('每个滤镜均可用默认参数应用且尺寸一致', () => {
  const src = makeImage()
  for (const f of filters.FILTER_LIST) {
    const out = filters.apply(src, f.id, f.defaultParams)
    assertSize(out, 8, 8)
  }
})

test('至少 50 个滤镜对测试图产生实际变化', () => {
  const src = makeImage()
  let changed = 0
  for (const f of filters.FILTER_LIST) {
    if (differs(src, filters.apply(src, f.id, f.defaultParams))) changed += 1
  }
  assert.ok(changed >= 50, `仅 ${changed} 个滤镜产生变化`)
})

test('滤镜 mask=0 保持原图 / 255 完全生效', () => {
  const src = makeImage()
  const id = 'vivid'
  const params = filters.FILTER_LIST.find((f) => f.id === id).defaultParams
  assertClosePixels(filters.apply(src, id, { ...params, mask: fullMask(0) }), src, 0)
  const full = filters.apply(src, id, params)
  assertClosePixels(filters.apply(src, id, { ...params, mask: fullMask(255) }), full, 0)
})

// —— 液化 ——
test('liquify 新增方法均增加 strokeCount', () => {
  const s = new LiquifySession(8, 8)
  const calls = [
    () => s.reconstruct(4, 4, 3, 0.5),
    () => s.clockwise(4, 4, 3, 0.5),
    () => s.counterclockwise(4, 4, 3, 0.5),
    () => s.pinch(4, 4, 3, 1),
    () => s.pushLeft(2, 2, 5, 5, 3, 1)
  ]
  let expected = 0
  for (const call of calls) {
    call()
    expected += 1
    assert.equal(s.strokeCount, expected, 'strokeCount 未按预期增加')
  }
})

test('liquify.stroke 调度全部工具', () => {
  const s = new LiquifySession(8, 8)
  const tools = ['forward', 'reconstruct', 'smooth', 'clockwise', 'counterclockwise', 'pinch', 'inflate', 'pushLeft']
  let expected = 0
  for (const tool of tools) {
    assert.equal(s.stroke(tool, 2, 2, 5, 5, 3, 1), true, `${tool} 未被调度`)
    expected += 1
    assert.equal(s.strokeCount, expected, `${tool} 未增加 strokeCount`)
  }
  assert.equal(s.stroke('unknown', 0, 0, 1, 1, 2, 1), false)
  assert.equal(s.strokeCount, expected, '未知工具不应增加 strokeCount')
})

test('liquify.reconstruct 确实衰减位移场', () => {
  const s = new LiquifySession(8, 8)
  s.forward(2, 4, 5, 4, 3, 1)
  const before = Math.abs(s.field[((4 * 8) + 5) * 2])
  assert.ok(before > 0, '前置向前变形应产生位移')
  s.reconstruct(5, 4, 3, 1)
  const after = Math.abs(s.field[((4 * 8) + 5) * 2])
  assert.ok(after < before, 'reconstruct 应减小位移场')
})

test('liquify.render 同尺寸与降采样预览均输出有效', () => {
  const s = new LiquifySession(8, 8)
  s.stroke('forward', 2, 2, 6, 6, 3, 1)
  s.stroke('clockwise', 4, 4, 3, 0.6)
  const src = makeImage()
  const full = s.render(src)
  assertSize(full, 8, 8)
  assert.ok(full.data.some((v) => v !== 0), 'render 输出不应全为 0')
  const preview = s.render(src.downsample(4))
  assertSize(preview, 4, 4)
  assert.ok(preview.data.some((v) => v !== 0), '预览 render 输出不应全为 0')
})

console.log(`\nalgorithms: ${passed} 项通过，${failed} 项失败`)
if (failed) process.exitCode = 1
