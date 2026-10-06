// 自动化断言（规格书 §8/§10 强制）：
// guillotine 100 组随机零反例、纹理零旋转、锯路/修边、守恒、封边复算、
// 30 零件锯切工步 ≤20 且模拟器还原、余料再利用、300 零件性能 <1.5s。
// 成组连纹：同板同向首尾相接、断口位置、让步拆段、长/短组取舍、版本签名/diff。
import type { Board, GrainGroupDef, Job, Part } from '../types'
import { nestJob } from './packing'
import { simulate, countSawOps } from './cuts'
import { guillotineViolation, type Rect } from './geometry'
import { diffGrainResults, grainSignature } from './grain'

export interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

export interface SelfTestReport {
  ok: boolean
  elapsedMs: number
  checks: CheckResult[]
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let boardSeq = 0
let partSeq = 0

function makeBoard(over: Partial<Board> = {}): Board {
  return {
    id: `b${boardSeq++}`,
    name: over.name ?? '测试板 2440×1220',
    wMm: over.wMm ?? 2440,
    hMm: over.hMm ?? 1220,
    thicknessMm: 18,
    material: '颗粒板',
    priceCents: 13800,
    quantity: 0,
    kind: 'stock',
    ...over
  }
}

function makePart(over: Partial<Part> = {}): Part {
  return {
    id: `p${partSeq++}`,
    code: over.code ?? `P${partSeq}`,
    name: over.name ?? '测试件',
    lenMm: over.lenMm ?? 400,
    widMm: over.widMm ?? 300,
    qty: over.qty ?? 1,
    grain: over.grain ?? 'none',
    edgeBands: over.edgeBands ?? [],
    cabinet: over.cabinet ?? '柜A',
    exposed: over.exposed ?? false,
    boardId: over.boardId ?? ''
  }
}

function makeJob(parts: Part[], over: Partial<Job> = {}): Job {
  return {
    id: `j${partSeq}`,
    name: '测试任务',
    createdAt: 0,
    boards: over.boards ?? [makeBoard()],
    parts,
    kerfMm: over.kerfMm ?? 3.2,
    trimMm: over.trimMm ?? 8,
    useOffcutIds: [],
    batchByCabinet: false,
    ...over
  }
}

/** 检查同板任意两件之间的净距：只要相邻就必须 ≥ kerf；四周 ≥ trim。 */
function assertClearances(job: Job): string | null {
  const kerf = job.kerfMm
  const trim = job.trimMm
  for (const sheet of job.result!.sheets) {
    const ps = sheet.placements
    for (const p of ps) {
      if (p.x < trim - 0.06 || p.y < trim - 0.06) return '零件越过修边区（左下）'
      if (p.x + p.lenMm > sheet.wMm - trim + 0.06) return '零件越过修边区（右）'
      if (p.y + p.widMm > sheet.hMm - trim + 0.06) return '零件越过修边区（上）'
    }
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i]
        const b = ps[j]
        const ox = Math.min(a.x + a.lenMm, b.x + b.lenMm) - Math.max(a.x, b.x)
        const oy = Math.min(a.y + a.widMm, b.y + b.widMm) - Math.max(a.y, b.y)
        if (ox > 0.06 && oy > 0.06) return '零件重叠'
        // 同向投影有重叠时，另一轴的净距必须 ≥ kerf
        if (ox > 0.06) {
          const gap = Math.abs(a.y + a.widMm - b.y) < Math.abs(a.y - (b.y + b.widMm))
            ? b.y - (a.y + a.widMm)
            : a.y - (b.y + b.widMm)
          if (gap > 0.06 && gap < kerf - 0.6) return `净距 ${gap.toFixed(2)} < 锯路 ${kerf}`
        }
        if (oy > 0.06) {
          const gap = Math.abs(a.x + a.lenMm - b.x) < Math.abs(a.x - (b.x + b.lenMm))
            ? b.x - (a.x + a.lenMm)
            : a.x - (b.x + b.lenMm)
          if (gap > 0.06 && gap < kerf - 0.6) return `净距 ${gap.toFixed(2)} < 锯路 ${kerf}`
        }
      }
    }
  }
  return null
}

function dumpJob(job: Job, err?: string): void {
  console.error('DUMP_KERF', job.kerfMm, 'TRIM', job.trimMm, 'ERR', err ?? '')
  for (const p of job.parts) {
    console.error(
      'DUMP_PART',
      JSON.stringify({
        c: p.code,
        l: p.lenMm,
        w: p.widMm,
        q: p.qty,
        g: p.grain,
        e: p.edgeBands.join(''),
        x: p.exposed ? 1 : 0
      })
    )
  }
  const m = err?.match(/板(\d+)/)
  if (m && job.result) {
    const sheet = job.result.sheets[Number(m[1]) - 1]
    if (sheet) {
      console.error('DUMP_SHEET', sheet.wMm, sheet.hMm)
      for (const p of sheet.placements)
        console.error('DUMP_PL', p.code, p.x, p.y, p.lenMm, p.widMm, p.grain)
      for (const st of sheet.steps)
        console.error('DUMP_ST', st.order, st.kind, st.axis, st.at, st.span[0], st.span[1])
      const sim = simulate(sheet.wMm, sheet.hMm, job.kerfMm, sheet.steps, sheet.placements)
      console.error('DUMP_SIM', JSON.stringify(sim.errors))
      for (const lf of sim.leaves)
        console.error('DUMP_LEAF', Math.round(lf.x), Math.round(lf.y), Math.round(lf.w), Math.round(lf.h))
    }
  }
}

function assertSheet(job: Job): string | null {
  const r = job.result!
  for (const sheet of r.sheets) {
    // guillotine 合法性
    const rects = sheet.placements.map((p) => ({
      id: p.instanceId,
      x: p.x,
      y: p.y,
      w: p.lenMm,
      h: p.widMm
    }))
    const bounds: Rect = {
      x: job.trimMm,
      y: job.trimMm,
      w: sheet.wMm - 2 * job.trimMm,
      h: sheet.hMm - 2 * job.trimMm
    }
    const v = guillotineViolation(rects, bounds, job.kerfMm)
    if (v) return `板${sheet.index + 1}：${v}`
    // 逐步切割模拟
    const sim = simulate(sheet.wMm, sheet.hMm, job.kerfMm, sheet.steps, sheet.placements)
    if (!sim.ok) return `板${sheet.index + 1}：${sim.errors.join('；')}`
    // 利用率复算（分子不含锯路）
    const net = sheet.placements.reduce((a, p) => a + p.origLen * p.origWid, 0)
    if (Math.abs(net - sheet.usedAreaMm2) > 1) return 'usedArea 与零件净面积不一致'
    if (Math.abs(net / sheet.boardAreaMm2 - sheet.utilization) > 1e-9)
      return '利用率复算不一致'
  }
  // 面积守恒不等式
  const boardArea = r.sheets.reduce((a, s) => a + s.boardAreaMm2, 0)
  const partArea = job.parts.reduce((a, p) => a + p.lenMm * p.widMm * p.qty, 0)
  if (boardArea + 1 < partArea) return 'Σ板面积 < Σ零件面积'
  return null
}

export function runSelfTest(): SelfTestReport {
  boardSeq = 0
  partSeq = 0
  const t0 = performance.now()
  const checks: CheckResult[] = []
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail })
  }

  // 1) 100 组随机任务：零反例
  const rng = mulberry32((globalThis as { FCO_SEED?: number }).FCO_SEED ?? 20260925)
  let failures = 0
  let firstFailure = ''
  let totalInstances = 0
  for (let g = 0; g < 100; g++) {
    const kerf = +(2 + rng() * 2).toFixed(2)
    const trim = 5 + Math.floor(rng() * 6)
    const partKinds = 8 + Math.floor(rng() * 33)
    const parts: Part[] = []
    for (let i = 0; i < partKinds; i++) {
      const len = 120 + Math.floor(rng() * 980)
      const wid = 80 + Math.floor(rng() * 620)
      const gr = rng()
      parts.push(
        makePart({
          code: `R${g}-${i}`,
          lenMm: len,
          widMm: wid,
          qty: 1 + Math.floor(rng() * 3),
          grain: gr < 0.4 ? 'length' : gr < 0.55 ? 'width' : 'none',
          edgeBands: rng() < 0.5 ? ['top', 'left'] : [],
          cabinet: ['客厅柜', '衣柜', '橱柜', '书柜'][Math.floor(rng() * 4)],
          exposed: rng() < 0.3
        })
      )
    }
    const job = makeJob(parts, { kerfMm: kerf, trimMm: trim })
    const r = nestJob(job)
    job.result = r
    const placed = r.sheets.reduce((a, s) => a + s.placements.length, 0)
    totalInstances = parts.reduce((a, p) => a + p.qty, 0)
    // 尺寸被限制为一定排得下
    if (r.unplaced.length > 0) {
      failures++
      firstFailure = `组${g + 1}：存在 ${r.unplaced.length} 件未排下`
      continue
    }
    if (placed !== totalInstances) {
      failures++
      firstFailure = `组${g + 1}：守恒失败 ${placed}/${totalInstances}`
      continue
    }
    const clearanceErr = assertClearances(job)
    if (clearanceErr) {
      failures++
      firstFailure = `组${g + 1}：${clearanceErr}`
      if ((globalThis as { FCO_DUMP?: boolean }).FCO_DUMP) dumpJob(job)
      continue
    }
    const sheetErr = assertSheet(job)
    if (sheetErr) {
      failures++
      firstFailure = `组${g + 1}：${sheetErr}`
      if ((globalThis as { FCO_DUMP?: boolean }).FCO_DUMP) dumpJob(job, sheetErr)
      continue
    }
    // 纹理硬约束：零旋转
    const rotated = r.sheets.flatMap((s) => s.placements).filter((p) => {
      if (p.grain === 'none') return false
      if (p.rotated) return true
      if (p.grain === 'length' && !(p.lenMm === p.origLen && p.widMm === p.origWid)) return true
      if (p.grain === 'width' && !(p.lenMm === p.origWid && p.widMm === p.origLen)) return true
      return false
    })
    if (rotated.length > 0) {
      failures++
      firstFailure = `组${g + 1}：纹理件被旋转 ${rotated.length} 次`
    }
  }
  add(
    '100 组随机 guillotine 零反例（贯通/锯路/修边/守恒/模拟）',
    failures === 0,
    failures === 0
      ? '100/100 通过；每组均验证：逐步模拟可还原全部零件'
      : firstFailure
  )

  // 2) 纹理无法满足时给原因而不是偷转
  {
    const job = makeJob([
      makePart({ code: 'BIG', lenMm: 2500, widMm: 400, qty: 1, grain: 'length' }),
      makePart({ code: 'OK', lenMm: 400, widMm: 400, qty: 1 })
    ])
    const r = nestJob(job)
    const ok =
      r.unplaced.length === 1 &&
      r.unplaced[0].code === 'BIG' &&
      r.unplaced[0].reason.includes('纹理') &&
      r.sheets.reduce((a, s) => a + s.placements.length, 0) === 1
    add('纹理排不下时明确提示且不强制旋转', ok, ok ? '提示：' + r.unplaced[0].reason : '未按预期报纹理冲突')
  }

  // 3) 锯路精确净距（两件相邻 = kerf）
  {
    const job = makeJob([
      makePart({ code: 'A', lenMm: 500, widMm: 500 }),
      makePart({ code: 'B', lenMm: 500, widMm: 500 })
    ])
    const r = nestJob(job)
    const ps = r.sheets[0].placements
    ps.sort((a, b) => a.y - b.y || a.x - b.x)
    const gap = ps[1].y - (ps[0].y + 500)
    const ok = Math.abs(gap - job.kerfMm) < 0.1
    add('相邻零件净距等于锯路 3.2mm', ok, `实测净距 ${gap.toFixed(2)}mm`)
  }

  // 4) 封边米数复算 + 见光分列
  {
    const job = makeJob([
      makePart({
        code: 'E1',
        lenMm: 500,
        widMm: 300,
        qty: 2,
        edgeBands: ['top', 'left'],
        exposed: true
      }),
      makePart({ code: 'E2', lenMm: 400, widMm: 200, qty: 1, edgeBands: ['top', 'bottom', 'left', 'right'] })
    ])
    const r = nestJob(job)
    const expectExposed = 2 * (0.5 + 0.3) // 1.6
    const expectNormal = 0.4 * 2 + 0.2 * 2 // 1.2
    const ok =
      Math.abs(r.edgeBandM.exposed - expectExposed) < 0.011 &&
      Math.abs(r.edgeBandM.normal - expectNormal) < 0.011
    add(
      '封边米数逐件复算一致且见光/非见光分列',
      ok,
      `见光 ${r.edgeBandM.exposed}m（期望 ${expectExposed}）、非见光 ${r.edgeBandM.normal}m（期望 ${expectNormal}）`
    )
  }

  // 5) 30 件标准件：锯切工步 ≤20 且模拟还原全部尺寸
  {
    const job = makeJob([makePart({ code: 'S', lenMm: 480, widMm: 398, qty: 30, grain: 'none' })])
    const r = nestJob(job)
    const ops = countSawOps(r.sheets)
    const simsOk = r.sheets.every((s) =>
      simulate(s.wMm, s.hMm, job.kerfMm, s.steps, s.placements).ok
    )
    const placed = r.sheets.reduce((a, s) => a + s.placements.length, 0)
    const ok = ops <= 20 && simsOk && placed === 30 && r.sheets.length === 2
    add(
      '30 零件锯切工步 ≤20 且按步模拟尺寸全部正确',
      ok,
      `${r.sheets.length} 张板、${ops} 个锯切工步（修边按叠切计 1 次）、模拟 ${simsOk ? '通过' : '失败'}`
    )
  }

  // 6) 余料作为小板参与下一轮排样
  {
    const small: Board = {
      id: 'offcut_test',
      name: '余料板 900×700',
      wMm: 900,
      hMm: 700,
      thicknessMm: 18,
      material: '颗粒板',
      priceCents: 0,
      quantity: 1,
      kind: 'offcut'
    }
    const job = makeJob([makePart({ code: 'O1', lenMm: 500, widMm: 500 })], {
      boards: [small, makeBoard()]
    })
    const r = nestJob(job)
    const ok = r.sheets[0].boardId === 'offcut_test' && r.sheets.length === 1
    add('余料登记后优先作为小板材参与排样', ok, ok ? '零件排上了 900×700 余料板' : '余料未被优先使用')
  }

  // 7) 300 零件（40 种规格）性能
  {
    const rng2 = mulberry32(77)
    const parts: Part[] = []
    let qtyLeft = 300
    for (let i = 0; i < 40; i++) {
      const qty = Math.min(i === 39 ? qtyLeft : 7 + Math.floor(rng2() * 2), qtyLeft)
      qtyLeft -= qty
      parts.push(
        makePart({
          code: `F${i}`,
          lenMm: 150 + Math.floor(rng2() * 750),
          widMm: 120 + Math.floor(rng2() * 500),
          qty
        })
      )
    }
    const job = makeJob(parts)
    const r = nestJob(job)
    const placed = r.sheets.reduce((a, s) => a + s.placements.length, 0)
    const ok = r.elapsedMs < 1500 && placed === 300
    add('300 零件排样 < 1.5s', ok, `耗时 ${r.elapsedMs}ms，用板 ${r.sheets.length} 张，就位 ${placed}/300`)
  }

  // 8) 手工微调合法性校验：合法布局通过，塞缝布局拒绝
  {
    const bounds: Rect = { x: 8, y: 8, w: 2424, h: 1204 }
    const legal: { id: string; x: number; y: number; w: number; h: number }[] = [
      { id: '1', x: 8, y: 8, w: 600, h: 1196 },
      { id: '2', x: 611.2, y: 8, w: 600, h: 596 },
      { id: '3', x: 611.2, y: 607.2, w: 600, h: 596.8 }
    ]
    // 经典风车形非切分布局（5 块互相顶住，找不到任何一条贯通切线）
    const illegal: { id: string; x: number; y: number; w: number; h: number }[] = [
      { id: 'B', x: 8, y: 8, w: 396.8, h: 600 },
      { id: 'C', x: 408, y: 8, w: 592, h: 396.8 },
      { id: 'E', x: 408, y: 408, w: 196.8, h: 196.8 },
      { id: 'A', x: 8, y: 608, w: 596.8, h: 396.8 },
      { id: 'D', x: 608, y: 408, w: 392, h: 596.8 }
    ]
    const okLegal = guillotineViolation(legal, bounds, 3.2) === null
    const okIllegal = guillotineViolation(illegal, bounds, 3.2) !== null
    add(
      '微调后 guillotine 合法性校验准确',
      okLegal && okIllegal,
      `合法布局 ${okLegal ? '放行' : '误拒'}；塞缝布局 ${okIllegal ? '拒绝' : '误放'}`
    )
  }

  // 9) 多板种混排 + 库存张数约束
  {    const thin = makeBoard({
      id: 'thin',
      name: '背板 2440×1220×9',
      wMm: 2440,
      hMm: 1220,
      thicknessMm: 9,
      priceCents: 9800
    })
    const thick = makeBoard({ id: 'thick', name: '主板 2440×1220×18', quantity: 1 })
    const parts = [
      makePart({ code: 'T', lenMm: 1000, widMm: 600, qty: 5, boardId: 'thick' }),
      makePart({ code: 'B', lenMm: 1000, widMm: 600, qty: 2, boardId: 'thin' })
    ]
    const job = makeJob(parts, { boards: [thick, thin] })
    const r = nestJob(job)
    const thickSheets = r.sheets.filter((s) => s.thicknessMm === 18).length
    const thinSheets = r.sheets.filter((s) => s.thicknessMm === 9).length
    const shortage = r.stockShortage.find((x) => x.boardId === 'thick')
    const ok =
      thickSheets >= 2 && thinSheets === 1 && !!shortage && shortage.need >= 2 && shortage.have === 1
    add(
      '多板种混排且 18mm 库存仅 1 张时超开并提示补采',
      ok,
      `18mm 用 ${thickSheets} 张（库存 1，需补采）、9mm 用 ${thinSheets} 张`
    )
  }

  // 10) 成组连纹：3 扇竖纹门板整段同板、同朝向、沿 x 首尾相接，中间不插件
  {
    const mk = (c: string): Part =>
      makePart({ code: c, name: '门板', lenMm: 500, widMm: 700, qty: 1, grain: 'length', edgeBands: ['top', 'bottom', 'left', 'right'] })
    const parts = [mk('D1'), mk('D2'), mk('D3')]
    const group: GrainGroupDef = {
      id: 'gg1',
      name: 'G1',
      memberPartIds: parts.map((p) => p.id),
      allowSplit: false,
      concession: ['move', 'split']
    }
    const job = makeJob(parts, { grainGroups: [group] } as Partial<Job>)
    const r = nestJob(job)
    const g = r.grainGroups.find((x) => x.id === 'gg1')
    const pls = r.sheets.flatMap((s) => s.placements).filter((p) => p.grainGroupId === 'gg1')
    const sameSheet = new Set(pls.map((p) => p.boardIndex)).size === 1
    const sameY = pls.every((p) => Math.abs(p.y - pls[0].y) < 1e-6)
    const noRotate = pls.every((p) => !p.rotated)
    const ordered = [...pls].sort((a, b) => (a.grainOrdinal ?? 0) - (b.grainOrdinal ?? 0))
    const chained = ordered.every((p, i) => i === 0 || Math.abs(p.x - (ordered[i - 1].x + 500) - 3.2) < 1e-6)
    const segLenOk = g?.segments[0].lengthMm === 1506
    const areaOk = g?.segments[0].areaMm2 === 1050000
    const simsOk = r.sheets.every((s) => simulate(s.wMm, s.hMm, job.kerfMm, s.steps, s.placements).ok)
    const ok =
      !!g && g.segmentCount === 1 && g.breaks.length === 0 && sameSheet && sameY && noRotate && chained &&
      !!segLenOk && !!areaOk && simsOk
    add(
      '成组连纹：整组同板同向沿纹理首尾相接、连纹长度/面积取整正确',
      ok,
      ok
        ? `1 段 ${g!.segments[0].lengthMm}mm、${g!.segments[0].areaMm2}mm²，顺序 ${ordered.map((p) => p.code).join('→')}`
        : `同板${sameSheet} 同y${sameY} 不转${noRotate} 相接${chained} 长${segLenOk} 面${areaOk} 模拟${simsOk}`
    )
  }

  // 11) 连纹段内沿纹理方向不允许插入别家件（占位验证）
  {
    const doors = ['E1', 'E2'].map((c) => makePart({ code: c, lenMm: 400, widMm: 300, grain: 'length' }))
    const filler = makePart({ code: 'FZ', lenMm: 120, widMm: 120, grain: 'none' })
    const group: GrainGroupDef = {
      id: 'gg2',
      name: 'G2',
      memberPartIds: doors.map((p) => p.id),
      allowSplit: false,
      concession: ['move']
    }
    const job = makeJob([...doors, filler], { grainGroups: [group] } as Partial<Job>)
    const r = nestJob(job)
    const e1 = r.sheets.flatMap((s) => s.placements).find((p) => p.code === 'E1')!
    const e2 = r.sheets.flatMap((s) => s.placements).find((p) => p.code === 'E2')!
    const fz = r.sheets.flatMap((s) => s.placements).find((p) => p.code === 'FZ')!
    const inBand = fz.y >= e1.y - 0.01 && fz.y + fz.widMm <= e1.y + e1.widMm + 0.01
    const betweenX = fz.x >= e1.x + e1.lenMm - 0.01 && fz.x + fz.lenMm <= e2.x + 0.01
    const chained = Math.abs(e2.x - (e1.x + e1.lenMm) - 3.2) < 1e-6
    const simsOk = r.sheets.every((s) => simulate(s.wMm, s.hMm, job.kerfMm, s.steps, s.placements).ok)
    add(
      '成组连纹：段内沿纹理首尾相接、中间不插别家件',
      chained && !(inBand && betweenX) && simsOk,
      `E2.x-E1.x 间隔 ${Math.round(e2.x - e1.x - e1.lenMm)}mm，填缝件${inBand && betweenX ? '错误插入' : '未插入段内'}`
    )
  }

  // 12) 整组超过单板长度：move 走不通时 forced 拆 2 段，断口标明拆点
  {
    const doors = ['L1', 'L2', 'L3', 'L4'].map((c) =>
      makePart({ code: c, lenMm: 700, widMm: 500, grain: 'length' })
    )
    const group: GrainGroupDef = {
      id: 'gg3',
      name: 'G3',
      memberPartIds: doors.map((p) => p.id),
      allowSplit: false,
      concession: ['move']
    }
    const job = makeJob(doors, { grainGroups: [group] } as Partial<Job>)
    const r = nestJob(job)
    const g = r.grainGroups.find((x) => x.id === 'gg3')
    const ok =
      !!g &&
      g.segmentCount === 2 &&
      g.breaks.length === 1 &&
      g.breaks[0].reason === 'forced' &&
      g.breaks[0].beforeCode === 'L3' &&
      g.breaks[0].afterCode === 'L4' &&
      r.unplaced.length === 0
    const simsOk = r.sheets.every((s) => simulate(s.wMm, s.hMm, job.kerfMm, s.steps, s.placements).ok)
    add(
      '成组连纹：超长组被迫拆两段，断口位置与 forced 原因明确',
      ok && simsOk,
      ok ? `段长 ${g!.segmentLengthsMm.join('/')}mm，断口 L3→L4` : JSON.stringify(g?.breaks)
    )
  }

  // 13) 让步顺序 split：已开板边角能放前缀时按让步拆段（concession 断口）
  {
    const a = ['A1', 'A2', 'A3', 'A4'].map((c) =>
      makePart({ code: c, lenMm: 430, widMm: 500, grain: 'length' })
    )
    const b = ['B1', 'B2', 'B3'].map((c) =>
      makePart({ code: c, lenMm: 400, widMm: 700, grain: 'length' })
    )
    const groups: GrainGroupDef[] = [
      { id: 'gA', name: 'GA', memberPartIds: a.map((p) => p.id), allowSplit: true, concession: ['move', 'split'] },
      { id: 'gB', name: 'GB', memberPartIds: b.map((p) => p.id), allowSplit: true, concession: ['split', 'move'] }
    ]
    const job = makeJob([...a, ...b], { grainGroups: groups } as Partial<Job>)
    const r = nestJob(job)
    const gB = r.grainGroups.find((x) => x.id === 'gB')
    const bk = gB?.breaks[0]
    const ok =
      !!gB && gB.segmentCount === 2 &&
      bk?.reason === 'concession' &&
      bk.beforeCode === 'B1' && bk.afterCode === 'B2' &&
      gB.segments[0].boardIndex === 0 && gB.segments[1].boardIndex === 1
    const simsOk = r.sheets.every((s) => simulate(s.wMm, s.hMm, job.kerfMm, s.steps, s.placements).ok)
    add(
      '成组连纹：按写明让步 split 拆段，前缀填边角、后段去新板',
      !!ok && simsOk,
      ok ? `B 组 ${gB!.segmentLengthsMm.join('/')}mm，断口 B1→B2（1板→2板）` : JSON.stringify(gB?.segments.map((s) => [s.boardIndex, s.memberCodes.join()]))
    )
  }

  // 14) 单成员组/未绑组件不出断口
  {
    const d1 = makePart({ code: 'SOLO', lenMm: 400, widMm: 300, grain: 'length' })
    const f1 = makePart({ code: 'LOOSE', lenMm: 300, widMm: 300, grain: 'none' })
    const job = makeJob([d1, f1], {
      grainGroups: [{ id: 'g1', name: 'G1', memberPartIds: [d1.id], allowSplit: false, concession: ['move'] }]
    } as Partial<Job>)
    const r = nestJob(job)
    const noBreak = r.grainGroups.every((g) => g.breaks.length === 0)
    const noTag = r.sheets.flatMap((s) => s.placements).every((p) => !p.grainSegmentId)
    add('单成员组与零散件不出断口、不带连纹段标记', noBreak && noTag, '')
  }

  // 15) 混高门板长条：高门/矮门同条，矮门上方余隙切给填缝件，切割模拟零反例
  {
    const tall = ['H1', 'H2', 'H3'].map((c) => makePart({ code: c, lenMm: 500, widMm: 600, grain: 'length' }))
    const low = ['L1', 'L2', 'L3'].map((c) => makePart({ code: c, lenMm: 500, widMm: 400, grain: 'length' }))
    const fill = ['Z1', 'Z2', 'Z3'].map((c) => makePart({ code: c, lenMm: 400, widMm: 180, grain: 'none' }))
    const job = makeJob([...tall, ...low, ...fill], {
      grainGroups: [
        { id: 'gmx', name: 'GMX', memberPartIds: [...tall, ...low].map((p) => p.id), allowSplit: true, concession: ['move', 'split'] }
      ]
    } as Partial<Job>)
    const r = nestJob(job)
    const g = r.grainGroups.find((x) => x.id === 'gmx')
    const simsOk = r.sheets.every((s) => simulate(s.wMm, s.hMm, job.kerfMm, s.steps, s.placements).ok)
    const placed = r.sheets.reduce((a, s) => a + s.placements.length, 0)
    // 填缝件应落在矮门（400 高）上方，而不是高门上方
    const zPlacedInLowBand = r.sheets
      .flatMap((s) => s.placements)
      .filter((p) => p.code.startsWith('Z'))
      .every((z) => z.y >= 411 - 1)
    add(
      '成组连纹：混高长条矮门上方余隙可填缝且 guillotine 模拟通过',
      simsOk && placed === 9 && !!g && zPlacedInLowBand,
      `就位 ${placed}/9，段 ${g?.segmentLengthsMm.join('/')}，模拟 ${simsOk}`
    )
  }

  // 16) 版本签名：组号/段号/顺序改动签名必变；diff 列出变化件与受影响板
  {    const mk = () =>
      ['V1', 'V2', 'V3'].map((c) => makePart({ code: c, lenMm: 400, widMm: 300, grain: 'length' }))
    const p1 = mk()
    const j1 = makeJob(p1, {
      grainGroups: [{ id: 'gv', name: 'GV', memberPartIds: p1.map((p) => p.id), allowSplit: false, concession: ['move'] }]
    } as Partial<Job>)
    const r1 = nestJob(j1)
    const sig1 = grainSignature(r1)
    const p2 = mk()
    const j2 = makeJob(p2, {
      grainGroups: [{ id: 'gv', name: 'GV', memberPartIds: [p2[2].id, p2[1].id, p2[0].id], allowSplit: false, concession: ['move'] }]
    } as Partial<Job>)
    const r2 = nestJob(j2)
    const sig2 = grainSignature(r2)
    const diff = diffGrainResults(r1, r2)
    const changed = diff?.instanceChanges.some((c) => c.code === 'V1' || c.code === 'V3')
    const boards = (diff?.affectedBoards.length ?? 0) >= 1
    add(
      '成组连纹：组内顺序改动签名变化，diff 列出变化件与受影响板',
      sig1 !== sig2 && !!changed && boards,
      `签名${sig1 === sig2 ? '未变(错)' : '已变'}；变化件 ${diff?.instanceChanges.length ?? 0}、受影响板 ${diff?.affectedBoards.length ?? 0}`
    )
  }

  const elapsedMs = Math.round(performance.now() - t0)
  const ok = checks.every((c) => c.ok)
  return { ok, elapsedMs, checks }
}
