// 成组连纹：版本签名、重排差异、精度与展示口径
// 说明：连纹长度按毫米取整（0 位小数）；面积按平方毫米取整（0 位小数，
// 换算平方米时保留 2 位小数）；封边米保留 2 位、金额保留 2 位（沿用既有口径）。
import type {
  GrainBreakReport,
  GrainGroupResult,
  GrainNestDiff,
  GrainSegmentReport,
  NestResult,
  Placement
} from '../types'

export const GRAIN_LENGTH_UNIT = 'mm'
export const GRAIN_LENGTH_DIGITS = 0
export const GRAIN_AREA_UNIT = 'mm²'
export const GRAIN_AREA_DIGITS = 0

export function grainLengthMm(v: number): number {
  return Math.round(v)
}

export function grainAreaMm2(v: number): number {
  return Math.round(v)
}

export function grainAreaM2(mm2: number): string {
  return (mm2 / 1_000_000).toFixed(2)
}

function allPlacements(result: NestResult): Placement[] {
  return result.sheets.flatMap((s) => s.placements)
}

interface InstanceGrain {
  groupId: string
  groupNo: number
  segmentNo: number
  ordinal: number
  board: number
}

function instanceMap(result: NestResult): Map<string, InstanceGrain> {
  const m = new Map<string, InstanceGrain>()
  for (const p of allPlacements(result)) {
    if (!p.grainGroupId || p.grainSegmentNo === undefined) continue
    m.set(p.instanceId, {
      groupId: p.grainGroupId,
      groupNo: p.grainGroupNo ?? 0,
      segmentNo: p.grainSegmentNo ?? 0,
      ordinal: p.grainOrdinal ?? 0,
      board: p.boardIndex
    })
  }
  return m
}

/**
 * 连纹版本签名：组归属 + 段号 + 板号 + 组内顺序。
 * 组内件数或顺序改一次、拆段位置改一次，签名都会变（旧存档/旧领料单据此作废）。
 */
export function grainSignature(result: NestResult): string {
  const parts: string[] = []
  const map = instanceMap(result)
  const keys = [...map.keys()].sort()
  for (const k of keys) {
    const g = map.get(k)!
    parts.push(`${k}@G${g.groupNo}.s${g.segmentNo}.o${g.ordinal}.b${g.board}`)
  }
  // 断口口径也进签名（同一批件但拆段位置变了必须作废旧版）
  for (const gr of result.grainGroups) {
    for (const bk of gr.breaks) {
      parts.push(
        `break:G${gr.no}:${bk.beforeInstanceId}>${bk.afterInstanceId}:b${bk.beforeBoardIndex}-${bk.afterBoardIndex}`
      )
    }
  }
  return parts.join('|')
}

/** 单据/存档上用的组摘要：组号 × 段数 × 断口数。 */
export function grainGroupDesc(result: NestResult): string {
  return result.grainGroups
    .map((g) => `G${g.no}×${g.segmentCount}段${g.breaks.length}断口`)
    .join('，')
}

interface BreakKey {
  key: string
  groupNo: number
  beforeBoard: number
  afterBoard: number
  beforeCode: string
  afterCode: string
}

function breakKeys(result: NestResult): Map<string, BreakKey> {
  const m = new Map<string, BreakKey>()
  for (const g of result.grainGroups) {
    for (const b of g.breaks) {
      const key = `${g.no}:${b.beforeInstanceId}>${b.afterInstanceId}`
      m.set(key, {
        key,
        groupNo: g.no,
        beforeBoard: b.beforeBoardIndex,
        afterBoard: b.afterBoardIndex,
        beforeCode: b.beforeCode,
        afterCode: b.afterCode
      })
    }
  }
  return m
}

/**
 * 两次排样的分组/断口差异：哪几件组号变了、断口挪到哪里、
 * 哪几张板要整张重排、预览图与单据哪几行跟着变。
 */
export function diffGrainResults(prev: NestResult | undefined, next: NestResult): GrainNestDiff | null {
  if (!prev) return null
  const a = instanceMap(prev)
  const b = instanceMap(next)
  const instanceChanges: GrainNestDiff['instanceChanges'] = []
  const allKeys = new Set([...a.keys(), ...b.keys()])
  const changedBoards = new Set<number>()
  for (const k of allKeys) {
    const x = a.get(k)
    const y = b.get(k)
    const same =
      x && y &&
      x.groupId === y.groupId &&
      x.segmentNo === y.segmentNo &&
      x.ordinal === y.ordinal &&
      x.board === y.board
    if (same) continue
    const code =
      (y ? findCode(next, k) : undefined) ?? (x ? findCode(prev, k) : k)
    instanceChanges.push({
      instanceId: k,
      code,
      fromGroupNo: x ? x.groupNo : null,
      toGroupNo: y ? y.groupNo : null,
      fromSegmentNo: x ? x.segmentNo : null,
      toSegmentNo: y ? y.segmentNo : null,
      fromBoardIndex: x ? x.board : null,
      toBoardIndex: y ? y.board : null
    })
    if (x) changedBoards.add(x.board)
    if (y) changedBoards.add(y.board)
  }
  // 断口变化
  const ba = breakKeys(prev)
  const bb = breakKeys(next)
  const breakChanges: GrainNestDiff['breakChanges'] = []
  for (const [key, v] of [...bb]) {
    const old = ba.get(key)
    if (!old) {
      breakChanges.push({
        groupNo: v.groupNo,
        kind: 'added',
        afterBoard: v.afterBoard + 1,
        beforeCodes: `${v.beforeCode}|${v.afterCode}`,
        afterCodes: `${v.beforeCode}|${v.afterCode}`
      })
      changedBoards.add(v.beforeBoard)
      changedBoards.add(v.afterBoard)
    } else if (old.beforeBoard !== v.beforeBoard || old.afterBoard !== v.afterBoard) {
      breakChanges.push({
        groupNo: v.groupNo,
        kind: 'moved',
        beforeBoard: Math.min(old.beforeBoard, old.afterBoard) + 1,
        afterBoard: Math.min(v.beforeBoard, v.afterBoard) + 1,
        beforeCodes: `${v.beforeCode}|${v.afterCode}`,
        afterCodes: `${v.beforeCode}|${v.afterCode}`
      })
      changedBoards.add(old.beforeBoard)
      changedBoards.add(old.afterBoard)
      changedBoards.add(v.beforeBoard)
      changedBoards.add(v.afterBoard)
    }
  }
  for (const [, v] of [...ba]) {
    if (!bb.has(v.key)) {
      breakChanges.push({
        groupNo: v.groupNo,
        kind: 'removed',
        beforeBoard: Math.min(v.beforeBoard, v.afterBoard) + 1,
        beforeCodes: `${v.beforeCode}|${v.afterCode}`
      })
      changedBoards.add(v.beforeBoard)
      changedBoards.add(v.afterBoard)
    }
  }
  if (instanceChanges.length === 0 && breakChanges.length === 0) return null

  const affectedBoards = [...changedBoards].filter((i) => i >= 0).sort((x, y) => x - y)
  const changedSheetRows = affectedBoards.map((bi) => ({
    boardIndex: bi,
    codes: instanceChanges
      .filter((c) => c.fromBoardIndex === bi || c.toBoardIndex === bi)
      .map((c) => c.code)
  }))
  const changedDocRows: string[] = []
  for (const c of instanceChanges) {
    changedDocRows.push(
      `${c.code}：${c.fromGroupNo === null ? '零散件' : `G${c.fromGroupNo}-${c.fromSegmentNo}段@${(c.fromBoardIndex ?? 0) + 1}板`}` +
        ` → ${c.toGroupNo === null ? '零散件' : `G${c.toGroupNo}-${c.toSegmentNo}段@${(c.toBoardIndex ?? 0) + 1}板`}`
    )
  }
  for (const bk of breakChanges) {
    const where = bk.kind === 'added'
      ? `新增断口（第 ${bk.afterBoard} 板附近，${bk.afterCodes?.replace('|', ' / ')}）`
      : bk.kind === 'removed'
        ? `取消断口（原第 ${bk.beforeBoard} 板，${bk.beforeCodes?.replace('|', ' / ')}）`
        : `断口挪位（第 ${bk.beforeBoard} 板 → 第 ${bk.afterBoard} 板，${bk.afterCodes?.replace('|', ' / ')}）`
    changedDocRows.push(`G${bk.groupNo}：${where}`)
  }
  return { instanceChanges, breakChanges, affectedBoards, changedSheetRows, changedDocRows }
}

function findCode(result: NestResult, instanceId: string): string {
  const p = allPlacements(result).find((x) => x.instanceId === instanceId)
  return p ? p.code : instanceId
}

/** 把段按组、沿纹理顺序汇总成每组的连纹报告。 */
export function buildGrainGroupResults(
  segments: GrainSegmentReport[],
  breaks: GrainBreakReport[]
): GrainGroupResult[] {
  const map = new Map<string, GrainGroupResult>()
  for (const seg of segments) {
    let g = map.get(seg.groupId)
    if (!g) {
      g = {
        id: seg.groupId,
        no: seg.groupNo,
        name: seg.groupName,
        memberCount: 0,
        segmentCount: 0,
        segments: [],
        breaks: [],
        segmentLengthsMm: []
      }
      map.set(seg.groupId, g)
    }
    g.segments.push(seg)
  }
  for (const bk of breaks) {
    map.get(bk.groupId)?.breaks.push(bk)
  }
  return [...map.values()]
    .sort((a, b) => a.no - b.no)
    .map((g) => {
      g.segments.sort((x, y) => x.segmentNo - y.segmentNo)
      g.breaks.sort((x, y) => x.afterSegmentNo - y.afterSegmentNo)
      g.segmentCount = g.segments.length
      g.memberCount = g.segments.reduce((a, s) => a + s.memberInstanceIds.length, 0)
      g.segmentLengthsMm = g.segments.map((s) => s.lengthMm)
      return g
    })
}
