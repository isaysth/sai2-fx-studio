/**
 * 核心工具模块单测（无第三方依赖、不读文件、不启 GUI）：
 *   node tests/core-tools.test.js
 *
 * 覆盖 Selection / 色彩换算 / History / ActionRecorder。
 */
'use strict'

const assert = require('node:assert/strict')
const { Selection } = require('../core/selection.js')
const { ImageBuffer } = require('../core/image.js')
const color = require('../core/color.js')
const { History } = require('../core/history.js')
const { ActionRecorder } = require('../core/actions.js')

let passed = 0
let failed = 0

function t(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  - ${name}`)
  } catch (err) {
    failed += 1
    console.error(`  FAIL - ${name}\n`, err)
  }
}

async function ta(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  - ${name}`)
  } catch (err) {
    failed += 1
    console.error(`  FAIL - ${name}\n`, err)
  }
}

async function main() {
  console.log('Selection')
  t('rect 填充指定点且不叠加', () => {
    const s = new Selection(10, 10)
    s.rect(2, 2, 4, 4)
    let m = s.mask()
    assert.equal(m[2 * 10 + 2], 255)
    assert.equal(m[5 * 10 + 5], 255)
    assert.equal(m[6 * 10 + 6], 0)
    assert.equal(m[1 * 10 + 1], 0)
    assert.equal(s.active, true)
    s.rect(7, 7, 2, 2)
    m = s.mask()
    assert.equal(m[2 * 10 + 2], 0)
    assert.equal(m[7 * 10 + 7], 255)
  })

  t('ellipse 填充指定点', () => {
    const s = new Selection(20, 20)
    s.ellipse(10, 10, 5, 5)
    const m = s.mask()
    assert.equal(m[10 * 20 + 10], 255)
    assert.equal(m[10 * 20 + 15], 255)
    assert.equal(m[10 * 20 + 16], 0)
    assert.equal(m[2 * 20 + 10], 0)
  })

  t('lasso 多边形填充', () => {
    const s = new Selection(10, 10)
    s.lasso([[2, 2], [8, 2], [5, 8]])
    const m = s.mask()
    assert.equal(m[4 * 10 + 5], 255)
    assert.equal(m[1 * 10 + 1], 0)
    assert.equal(m[9 * 10 + 9], 0)
  })

  t('pen 点集填充', () => {
    const s = new Selection(10, 10)
    s.pen([[1, 1], [8, 1], [8, 8], [1, 8]])
    const m = s.mask()
    assert.equal(m[4 * 10 + 4], 255)
    assert.equal(m[0], 0)
  })

  t('magicWand 洪泛连通区域', () => {
    const img = ImageBuffer.create(10, 10)
    for (let y = 0; y < 10; y += 1) {
      for (let x = 0; x < 10; x += 1) img.setPixel(x, y, 10, 10, 10, 255)
    }
    for (let y = 3; y <= 5; y += 1) {
      for (let x = 3; x <= 5; x += 1) img.setPixel(x, y, 200, 200, 200, 255)
    }
    img.setPixel(8, 8, 200, 200, 200, 255) // 同色但不连通

    const s = new Selection(10, 10)
    s.magicWand(img, 4, 4, 10)
    const m = s.mask()
    assert.equal(m[4 * 10 + 4], 255)
    assert.equal(m[3 * 10 + 3], 255)
    assert.equal(m[5 * 10 + 5], 255)
    assert.equal(m[0], 0)
    assert.equal(m[8 * 10 + 8], 0)
  })

  t('feather 羽化边缘', () => {
    const s = new Selection(12, 12)
    s.rect(4, 4, 4, 4)
    assert.equal(s.mask()[5 * 12 + 3], 0)
    s.feather(2)
    assert.ok(s.mask()[5 * 12 + 3] > 0, '边缘外侧应被羽化')
    assert.ok(s.mask()[5 * 12 + 5] > 0, '中心仍选中')
  })

  t('invert 反相', () => {
    const s = new Selection(4, 4)
    assert.equal(s.mask()[0], 0)
    s.invert()
    assert.equal(s.mask()[0], 255)
    assert.equal(s.active, true)
    s.invert()
    assert.equal(s.mask()[0], 0)
    assert.equal(s.active, false)
  })

  t('translate 平移', () => {
    const s = new Selection(10, 10)
    s.rect(2, 2, 2, 2)
    s.translate(3, 4)
    assert.equal(s.mask()[6 * 10 + 5], 255)
    assert.equal(s.mask()[2 * 10 + 2], 0)
  })

  t('clear 清空', () => {
    const s = new Selection(4, 4)
    s.rect(0, 0, 4, 4)
    s.clear()
    assert.equal(s.mask().every((v) => v === 0), true)
    assert.equal(s.active, false)
  })

  console.log('color')
  t('rgb <-> hsv 往返误差 <= 2', () => {
    const cases = [
      [255, 0, 0], [0, 255, 0], [0, 0, 255], [128, 128, 128],
      [37, 201, 99], [255, 255, 0], [0, 0, 0], [255, 255, 255]
    ]
    for (const c of cases) {
      const back = color.hsvToRgb(color.rgbToHsv(c))
      for (let i = 0; i < 3; i += 1) {
        assert.ok(Math.abs(back[i] - c[i]) <= 2, `${c} -> ${back}`)
      }
    }
  })

  t('rgb <-> lab 往返误差 <= 2', () => {
    const cases = [
      [255, 0, 0], [0, 255, 0], [0, 0, 255], [128, 128, 128],
      [37, 201, 99], [200, 60, 180], [0, 0, 0], [255, 255, 255]
    ]
    for (const c of cases) {
      const back = color.labToRgb(color.rgbToLab(c))
      for (let i = 0; i < 3; i += 1) {
        assert.ok(Math.abs(back[i] - c[i]) <= 2, `${c} -> ${back}`)
      }
    }
  })

  t('rgbToHex / hexToRgb 解析', () => {
    assert.equal(color.rgbToHex([255, 0, 128]), '#FF0080')
    assert.deepEqual(color.hexToRgb('#FF0080'), [255, 0, 128])
    assert.deepEqual(color.hexToRgb('#f00'), [255, 0, 0])
    assert.deepEqual(color.hexToRgb('not-a-color'), [0, 0, 0])
  })

  t('luminance 亮度', () => {
    assert.equal(color.luminance(255, 255, 255), 255)
    assert.equal(color.luminance(0, 0, 0), 0)
    assert.ok(color.luminance(128, 128, 128) > 0)
    assert.ok(color.luminance(128, 128, 128) < 255)
  })

  t('gradientColor 中点插值与边界钳制', () => {
    const stops = [{ pos: 0, color: [0, 0, 0] }, { pos: 1, color: [100, 200, 255] }]
    assert.deepEqual(color.gradientColor(stops, 0.5), [50, 100, 128])
    assert.deepEqual(color.gradientColor(stops, -1), [0, 0, 0])
    assert.deepEqual(color.gradientColor(stops, 2), [100, 200, 255])
    assert.deepEqual(color.gradientColor([], 0.5), [0, 0, 0])
  })

  t('色彩函数不产生 NaN', () => {
    for (const v of [color.rgbToHsv([]), color.hsvToRgb([]), color.rgbToLab([]), color.labToRgb([])]) {
      assert.ok(v.every((n) => Number.isFinite(n)))
    }
  })

  console.log('History')
  t('push / undo / redo / revertTo / list', () => {
    const h = new History()
    assert.deepEqual([
      h.push({ label: 'a', image: 'IMG_A' }),
      h.push({ label: 'b', image: 'IMG_B' }),
      h.push({ label: 'c', image: 'IMG_C' })
    ], [0, 1, 2])
    assert.equal(h.length, 3)
    const list = h.list()
    assert.deepEqual(list.map((x) => x.index), [0, 1, 2])
    assert.deepEqual(list.map((x) => x.label), ['a', 'b', 'c'])
    assert.ok(list.every((x) => typeof x.time === 'number'))
    assert.equal(list[0].image, undefined)

    assert.equal(h.canUndo, true)
    assert.equal(h.canRedo, false)
    let e = h.undo()
    assert.equal(e.index, 1)
    assert.equal(e.image, 'IMG_B')
    e = h.undo()
    assert.equal(e.index, 0)
    assert.equal(h.undo(), null)
    assert.equal(h.canUndo, false)
    assert.equal(h.redo().index, 1)
    assert.equal(h.redo().index, 2)
    assert.equal(h.redo(), null)

    e = h.revertTo(0)
    assert.equal(e.index, 0)
    assert.equal(h.length, 1)
    assert.equal(h.canRedo, false)
    assert.equal(h.push({ label: 'd', image: 'IMG_D' }), 3)
  })

  t('limit 淘汰最旧记录且 clear 清空', () => {
    const h = new History(2)
    h.push({ label: '1', image: 1 })
    h.push({ label: '2', image: 2 })
    h.push({ label: '3', image: 3 })
    assert.equal(h.length, 2)
    assert.deepEqual(h.list().map((x) => x.index), [1, 2])
    assert.equal(h.undo().index, 1)
    h.clear()
    assert.equal(h.length, 0)
    assert.equal(h.canUndo, false)
    assert.equal(h.canRedo, false)
  })

  console.log('ActionRecorder')
  await ta('record / steps / serialize / load / replay / clear', async () => {
    const r = new ActionRecorder('demo')
    assert.equal(r.label, 'demo')
    r.record('grab', { tab: 'adjust', effect: 'invert', params: {} })
    r.record('grab2', { tab: 'filter', effect: 'blur', params: { radius: 3 } })
    assert.equal(r.steps().length, 2)
    assert.equal(r.label, 'grab2')
    assert.deepEqual(r.steps()[1], { tab: 'filter', effect: 'blur', params: { radius: 3 } })

    const ser = r.serialize()
    assert.equal(ser.version, 1)
    assert.equal(ser.steps.length, 2)
    assert.deepEqual(JSON.parse(JSON.stringify(ser)), ser)

    const r2 = ActionRecorder.load(ser)
    assert.equal(r2.label, 'grab2')
    assert.deepEqual(r2.steps(), r.steps())
    assert.throws(() => ActionRecorder.load({ version: 2, steps: [] }))
    assert.throws(() => ActionRecorder.load({ version: 1, steps: 'x' }))

    const seen = []
    const count = await r.replay(async (step) => {
      seen.push(step.effect)
      await Promise.resolve()
    })
    assert.equal(count, 2)
    assert.deepEqual(seen, ['invert', 'blur'])

    r.clear()
    assert.equal(r.steps().length, 0)
    assert.equal(r.label, '')
  })

  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  if (failed > 0) process.exitCode = 1
}

main().catch((err) => { console.error(err); process.exitCode = 1 })
