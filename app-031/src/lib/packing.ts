// 核心排样：guillotine（直线贯通可锯）递归二分 2D 装箱
// - 纹理 length/width 硬约束：只允许指定朝向，rotated 恒为 false，放不下就报原因
// - 锯路 kerf：零件与零件、零件与余料之间留锯缝；修边 trim 为四周先切掉的边
// - 成组连纹：复用 orientsOf 的既有朝向判定与 fitsClean 的余隙判定，不按门板另开分支
// - 利用率分母为整板面积，分子为零件净面积（不含锯路）
import type {
  Board,
  GrainBreak,
  GrainGroup,
  GrainGroupPriority,
  GrainGroupResult,
  GrainNestSummary,
  GrainSegmentInfo,
  Job,
  NestResult,
  OffcutInfo,
  Part,
  Placement,
  SheetResult,
  UnplacedInfo
} from '../types'
import { EPS, type Rect } from './geometry'
import { buildSteps, simulate } from './cuts'
import type { DSeg } from './cuts'

interface Inst {
  part: Part
  k: number // 第 k 件（qty 展开）
  key: string
  cabinet: string
  group?: {
    id: string
    code: string
    order: number
    segmentCode?: string
  }
}

interface GroupMemberAtom {
  inst: Inst
  part: Part
  orient: Orient
  /** 与木纹垂直的拼接方向尺寸：门板并排时沿这个方向首尾相接 */
  cross: number
  /** 木纹方向尺寸 */
  along: number
}

interface GroupAtom {
  def: GrainGroup
  code: string
  grain: 'length' | 'width'
  axis: 'x' | 'y'
  boardId: string
  members: GroupMemberAtom[]
  netChain: number
  area: number
}

interface SegmentPlan {
  atom: GroupAtom
  members: GroupMemberAtom[]
  segmentCode: string
  startOrder: number
  endOrder: number
  split: boolean
}

interface PlacedSegment extends SegmentPlan {
  sheetIndex: number
  x: number
  y: number
  bw: number
  bh: number
  instanceIds: string[]
  reason: 'currentSheet' | 'freshSheet' | 'boardCapacity'
}

interface FRect extends Rect {
  id: number
  parentRec: number | null // 由哪次放置产生（切割依赖）
  entrySeg: 'A' | 'B' | null // 进入该空档前必须完成的刀：首刀/次刀
}

interface Rec {
  id: number
  frId: number
  instKey: string
  x: number
  y: number
  pw: number
  ph: number
  dir: 'v' | 'h'
  segA?: DSeg
  segB?: DSeg
  segExtra?: DSeg[]
}

interface SheetState {
  board: Board
  index: number
  usable: Rect
  free: FRect[]
  recs: Rec[]
  placements: Placement[]
}

interface Orient {
  pw: number
  ph: number
  rotated: boolean
}

function boardMatches(b: Board, p: Part): boolean {
  if (!p.boardId) return true
  if (b.id === p.boardId) return true
  if (b.kind === 'offcut') {
    const target = boardDefs.get(p.boardId)
    return !!target && target.thicknessMm === b.thicknessMm
  }
  return false
}

const boardDefs = new Map<string, Board>()

/** 统一为横向板（长边沿 x）。余料上台可以转，所以归一化安全。 */
function normalize(b: Board): Board {
  if (b.wMm >= b.hMm) return b
  return { ...b, wMm: b.hMm, hMm: b.wMm }
}

function groupCode(index: number): string {
  return `G${String(index + 1).padStart(2, '0')}`
}

/** 只给排样内核使用的输入指纹；版次/作废由 store 负责落本机存档。 */
export function grainInputSignature(job: Job): string {
  const payload = {
    boards: job.boards.map((b) => [b.id, b.wMm, b.hMm, b.thicknessMm, b.kind, b.offcutId]),
    parts: job.parts.map((p) => [
      p.id,
      p.code,
      p.lenMm,
      p.widMm,
      p.qty,
      p.grain,
      p.edgeBands,
      p.boardId
    ]),
    kerfMm: job.kerfMm,
    trimMm: job.trimMm,
    batchByCabinet: job.batchByCabinet,
    grainGroups: job.grainGroups,
    grainPriority: job.grainPriority
  }
  const text = JSON.stringify(payload)
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `sig_${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export function nestJob(job: Job): NestResult {
  const t0 = performance.now()
  boardDefs.clear()
  const boards = job.boards.map(normalize)
  boards.forEach((b) => boardDefs.set(b.id, b))
  const kerf = job.kerfMm
  const trim = job.trimMm
  const priority: GrainGroupPriority = job.grainPriority ?? 'longFirst'

  // 各板种实际开板数（用于库存补采提示）
  const openedCount = new Map<string, number>()

  // 只允许严丝合缝（0）或余隙 ≥ 锯路；0<余隙<锯路 时下不了刀，禁止放入
  const fitsClean = (avail: number, size: number): boolean => {
    const gap = avail - size
    return gap >= -EPS && (gap <= EPS || gap >= kerf - EPS)
  }
  const orientsOf = (p: Part): Orient[] => {
    if (p.grain === 'length') return [{ pw: p.lenMm, ph: p.widMm, rotated: false }]
    if (p.grain === 'width') return [{ pw: p.widMm, ph: p.lenMm, rotated: false }]
    if (p.lenMm === p.widMm) return [{ pw: p.lenMm, ph: p.widMm, rotated: false }]
    return [
      { pw: p.lenMm, ph: p.widMm, rotated: false },
      { pw: p.widMm, ph: p.lenMm, rotated: true }
    ]
  }

  const partMap = new Map<string, Part>()
  job.parts.forEach((p) => partMap.set(p.id, p))
  const availableQty = new Map<string, number>(job.parts.map((p) => [p.id, Math.max(0, p.qty)]))
  const insts: Inst[] = []
  const groupAtoms: GroupAtom[] = []
  const invalidGroups: { def: GrainGroup; code: string; note: string }[] = []

  const makeInst = (part: Part, k: number, group?: Inst['group']): Inst => ({
    part,
    k,
    key: `${part.id}#${k}`,
    cabinet: part.cabinet || '未分组',
    group
  })

  // 展开连纹组。组成员按写明顺序展开；同一种零件可把部分数量留给零散件。
  job.grainGroups.forEach((def, gi) => {
    const code = groupCode(gi)
    const seenPart = new Set<string>()
    let grain: 'length' | 'width' | null = null
    let boardId = ''
    let note = ''
    const atoms: GroupMemberAtom[] = []
    let order = 0

    for (const m of def.members) {
      const part = partMap.get(m.partId)
      const qty = Math.max(0, Math.floor(m.qty))
      if (!part) {
        note = `组成员指向了已删除零件`
        break
      }
      if (seenPart.has(m.partId)) {
        note = `${part.code} 在同一组内重复绑定`
        break
      }
      seenPart.add(m.partId)
      if (qty <= 0) {
        note = `${part.code} 的绑定件数必须大于 0`
        break
      }
      if ((availableQty.get(part.id) ?? 0) < qty) {
        note = `${part.code} 可绑定数量不足（清单 ${part.qty} 件，已被前面的组占用）`
        break
      }
      if (part.grain === 'none') {
        note = `${part.code} 纹理无要求，不能作为必须同纹同向的连纹组`
        break
      }
      if (grain && grain !== part.grain) {
        note = `组内纹理方向不一致（${grain === 'length' ? '竖纹' : '横纹'} / ${part.grain === 'length' ? '竖纹' : '横纹'}）`
        break
      }
      if (part.boardId) {
        if (boardId && boardId !== part.boardId) {
          note = '组内零件指定了不同板材，不能保证落在同一张板'
          break
        }
        boardId = part.boardId
      }
      grain = part.grain
      const startK = (part.qty - (availableQty.get(part.id) ?? 0)) + 1
      for (let u = 0; u < qty; u++) {
        order++
        const inst = makeInst(part, startK + u, { id: def.id, code, order })
        const orient = orientsOf(part)[0]
        atoms.push({
          inst,
          part,
          orient,
          cross: part.grain === 'length' ? orient.ph : orient.pw,
          along: part.grain === 'length' ? orient.pw : orient.ph
        })
      }
    }

    if (note || !grain) {
      invalidGroups.push({ def, code, note: note || '连纹组无效' })
      return
    }

    atoms.forEach((a) => {
      availableQty.set(a.part.id, (availableQty.get(a.part.id) ?? 0) - 1)
      insts.push(a.inst)
    })
    const axis = grain === 'length' ? 'y' : 'x'
    groupAtoms.push({
      def,
      code,
      grain,
      axis,
      boardId,
      members: atoms,
      netChain: atoms.reduce((a, m) => a + m.cross, 0),
      area: atoms.reduce((a, m) => a + m.part.lenMm * m.part.widMm, 0)
    })
  })

  // 未绑定的剩余数量仍按既有规则作为零散件排样。
  for (const p of job.parts) {
    const remain = availableQty.get(p.id) ?? 0
    const consumed = Math.max(0, p.qty - remain)
    for (let k = consumed + 1; k <= p.qty; k++) insts.push(makeInst(p, k))
  }

  // 单件组不预留长条、不制造断口；带组号随零散件一起走既有朝向/余隙判定。
  const singletonGroups = new Set(groupAtoms.filter((g) => g.members.length === 1).map((g) => g.def.id))
  const queueAtoms = groupAtoms.filter((g) => g.members.length > 1)
  queueAtoms.sort((a, b) => {
    const d = priority === 'longFirst' ? b.netChain - a.netChain : a.netChain - b.netChain
    return d || b.members.length - a.members.length || a.code.localeCompare(b.code)
  })
  const looseSorted = insts
    .filter((i) => !i.group || singletonGroups.has(i.group.id))
    .sort((a, b) => {
      if (job.batchByCabinet && a.cabinet !== b.cabinet) return a.cabinet < b.cabinet ? -1 : 1
      const am = Math.max(a.part.lenMm, a.part.widMm)
      const bm = Math.max(b.part.lenMm, b.part.widMm)
      if (bm !== am) return bm - am
      return b.part.lenMm * b.part.widMm - a.part.lenMm * a.part.widMm
    })

  const sheets: SheetState[] = []
  const placedSegments: PlacedSegment[] = []
  let frSeq = 0
  const openSheet = (b: Board): SheetState => {
    const usable: Rect = {
      x: trim,
      y: trim,
      w: Math.max(1, b.wMm - 2 * trim),
      h: Math.max(1, b.hMm - 2 * trim)
    }
    const s: SheetState = {
      board: b,
      index: sheets.length,
      usable,
      free: [
        {
          id: frSeq++,
          x: usable.x,
          y: usable.y,
          w: usable.w,
          h: usable.h,
          parentRec: null,
          entrySeg: null
        }
      ],
      recs: [],
      placements: []
    }
    sheets.push(s)
    return s
  }

  const canOpen = (b: Board): boolean => {
    // 余料板只有一块，用完即止；常规板库存是采购参考，可超开（稍后提示补采）
    if (b.kind === 'offcut') {
      const used = openedCount.get(b.id) ?? 0
      return used < 1
    }
    return true
  }

  const pickNewBoard = (p: Part, pw: number, ph: number): Board | null => {
    const viable = boards.filter(
      (b) =>
        canOpen(b) &&
        boardMatches(b, p) &&
        fitsClean(b.wMm - 2 * trim, pw) &&
        fitsClean(b.hMm - 2 * trim, ph)
    )
    // 余料小板优先，其次选面积最小的（省大板）
    viable.sort((a, b) => {
      if ((a.kind === 'offcut') !== (b.kind === 'offcut')) return a.kind === 'offcut' ? -1 : 1
      return a.wMm * a.hMm - b.wMm * b.hMm
    })
    return viable[0] ?? null
  }

  const unplaced = new Map<string, { part: Part; qty: number }>()
  const markUnplaced = (p: Part): void => {
    const cur = unplaced.get(p.id)
    if (cur) cur.qty++
    else unplaced.set(p.id, { part: p, qty: 1 })
  }

  let seq = 0

  const makePlacement = (
    inst: Inst,
    s: SheetState,
    x: number,
    y: number,
    o: Orient
  ): Placement => ({
    partId: inst.part.id,
    instanceId: inst.key,
    boardIndex: s.index,
    x,
    y,
    lenMm: o.pw,
    widMm: o.ph,
    origLen: inst.part.lenMm,
    origWid: inst.part.widMm,
    rotated: o.rotated,
    seq: 0,
    code: inst.part.code,
    name: inst.part.name,
    cabinet: inst.cabinet,
    exposed: inst.part.exposed,
    grain: inst.part.grain,
    edgeBands: inst.part.edgeBands,
    grainGroupId: inst.group?.id,
    grainGroupCode: inst.group?.code,
    grainSegmentCode: inst.group?.segmentCode,
    grainOrder: inst.group?.order
  })

  const segDepsOf = (fr: FRect, s: SheetState): DSeg[] => {
    if (fr.parentRec === null || !fr.entrySeg) return []
    const rec = s.recs.find((r) => r.id === fr.parentRec)
    if (!rec) return []
    const seg = fr.entrySeg === 'A' ? rec.segA ?? rec.segB : rec.segB ?? rec.segA
    return seg ? [seg] : []
  }

  const addFreeRect = (s: SheetState, r: Rect, parentRec: number, entrySeg: 'A' | 'B'): void => {
    if (r.w >= 1 && r.h >= 1) s.free.push({ ...r, id: frSeq++, parentRec, entrySeg })
  }

  function placeSingle(inst: Inst, s: SheetState, fr: FRect, o: Orient): Placement {
    s.free = s.free.filter((f) => f.id !== fr.id)
    const rec: Rec = {
      id: s.recs.length,
      frId: fr.id,
      instKey: inst.key,
      x: fr.x,
      y: fr.y,
      pw: o.pw,
      ph: o.ph,
      dir: fr.w >= fr.h ? 'v' : 'h'
    }
    const parentDeps = segDepsOf(fr, s)
    const gx = fr.w - o.pw
    const gy = fr.h - o.ph
    const cutX = gx >= kerf - EPS
    const cutY = gy >= kerf - EPS
    if (rec.dir === 'v') {
      if (cutX) {
        rec.segA = { axis: 'v', at: fr.x + o.pw + kerf / 2, lo: fr.y, hi: fr.y + fr.h, deps: parentDeps }
      }
      if (cutY) {
        rec.segB = {
          axis: 'h',
          at: fr.y + o.ph + kerf / 2,
          lo: fr.x,
          hi: cutX ? fr.x + o.pw : fr.x + fr.w,
          deps: rec.segA ? [rec.segA] : parentDeps
        }
      }
      if (cutY) {
        addFreeRect(
          s,
          { x: fr.x, y: fr.y + o.ph + kerf, w: cutX ? o.pw : fr.w, h: gy - kerf },
          rec.id,
          'B'
        )
      }
      if (cutX) addFreeRect(s, { x: fr.x + o.pw + kerf, y: fr.y, w: gx - kerf, h: fr.h }, rec.id, 'A')
    } else {
      if (cutY) {
        rec.segA = { axis: 'h', at: fr.y + o.ph + kerf / 2, lo: fr.x, hi: fr.x + fr.w, deps: parentDeps }
      }
      if (cutX) {
        rec.segB = {
          axis: 'v',
          at: fr.x + o.pw + kerf / 2,
          lo: fr.y,
          hi: cutY ? fr.y + o.ph : fr.y + fr.h,
          deps: rec.segA ? [rec.segA] : parentDeps
        }
      }
      if (cutY) addFreeRect(s, { x: fr.x, y: fr.y + o.ph + kerf, w: fr.w, h: gy - kerf }, rec.id, 'A')
      if (cutX) {
        addFreeRect(
          s,
          { x: fr.x + o.pw + kerf, y: fr.y, w: gx - kerf, h: cutY ? o.ph : fr.h },
          rec.id,
          'B'
        )
      }
    }
    s.recs.push(rec)
    seq++
    const pl = makePlacement(inst, s, fr.x, fr.y, o)
    pl.seq = seq
    s.placements.push(pl)
    return pl
  }

  type SegmentDims = { bw: number; bh: number; occupiedChain: number; netChain: number }
  const dimsOf = (members: GroupMemberAtom[], atom: GroupAtom): SegmentDims => {
    const alongSize = Math.max(...members.map((m) => m.along))
    const netChain = members.reduce((a, m) => a + m.cross, 0)
    const occupiedChain = netChain + (members.length - 1) * kerf
    return {
      bw: atom.axis === 'x' ? occupiedChain : alongSize,
      bh: atom.axis === 'x' ? alongSize : occupiedChain,
      occupiedChain,
      netChain
    }
  }

  function placeSegment(plan: SegmentPlan, s: SheetState, fr: FRect, reason: PlacedSegment['reason']): PlacedSegment {
    const atom = plan.atom
    const members = plan.members
    const d = dimsOf(members, atom)
    s.free = s.free.filter((f) => f.id !== fr.id)

    const rec: Rec = {
      id: s.recs.length,
      frId: fr.id,
      instKey: members[0].inst.key,
      x: fr.x,
      y: fr.y,
      pw: d.bw,
      ph: d.bh,
      dir: atom.axis === 'y' ? 'v' : 'h'
    }
    const parentDeps = segDepsOf(fr, s)
    const gx = fr.w - d.bw
    const gy = fr.h - d.bh
    const cutX = gx >= kerf - EPS
    const cutY = gy >= kerf - EPS
    const extras: DSeg[] = []

    const positions: { m: GroupMemberAtom; x: number; y: number }[] = []
    if (atom.axis === 'y') {
      let y = fr.y
      for (const m of members) {
        positions.push({ m, x: fr.x, y })
        y += m.cross + kerf
      }
      if (cutX) {
        rec.segA = { axis: 'v', at: fr.x + d.bw + kerf / 2, lo: fr.y, hi: fr.y + fr.h, deps: parentDeps }
      }
      const bandCuts: DSeg[] = []
      let boundary = fr.y
      for (let i = 0; i < members.length - 1; i++) {
        boundary += members[i].cross
        const cut: DSeg = {
          axis: 'h',
          at: boundary + kerf / 2,
          lo: fr.x,
          hi: fr.x + d.bw,
          deps: rec.segA ? [rec.segA] : parentDeps
        }
        bandCuts.push(cut)
        extras.push(cut)
        boundary += kerf
      }
      if (cutY) {
        rec.segB = {
          axis: 'h',
          at: fr.y + d.bh + kerf / 2,
          lo: fr.x,
          hi: cutX ? fr.x + d.bw : fr.x + fr.w,
          deps: rec.segA ? [rec.segA] : parentDeps
        }
      }
      positions.forEach((pos, i) => {
        const gap = d.bw - pos.m.orient.pw
        if (gap >= kerf - EPS) {
          extras.push({
            axis: 'v',
            at: pos.x + pos.m.orient.pw + kerf / 2,
            lo: pos.y,
            hi: pos.y + pos.m.cross,
            deps: [
              ...(i > 0 ? [bandCuts[i - 1]] : []),
              ...(i < members.length - 1 ? [bandCuts[i]] : []),
              ...(rec.segA ? [rec.segA] : [])
            ]
          })
        }
      })
      if (cutY) {
        addFreeRect(
          s,
          { x: fr.x, y: fr.y + d.bh + kerf, w: cutX ? d.bw : fr.w, h: gy - kerf },
          rec.id,
          'B'
        )
      }
      if (cutX) addFreeRect(s, { x: fr.x + d.bw + kerf, y: fr.y, w: gx - kerf, h: fr.h }, rec.id, 'A')
    } else {
      let x = fr.x
      for (const m of members) {
        positions.push({ m, x, y: fr.y })
        x += m.cross + kerf
      }
      if (cutY) {
        rec.segA = { axis: 'h', at: fr.y + d.bh + kerf / 2, lo: fr.x, hi: fr.x + fr.w, deps: parentDeps }
      }
      const bandCuts: DSeg[] = []
      let boundary = fr.x
      for (let i = 0; i < members.length - 1; i++) {
        boundary += members[i].cross
        const cut: DSeg = {
          axis: 'v',
          at: boundary + kerf / 2,
          lo: fr.y,
          hi: fr.y + d.bh,
          deps: rec.segA ? [rec.segA] : parentDeps
        }
        bandCuts.push(cut)
        extras.push(cut)
        boundary += kerf
      }
      if (cutX) {
        rec.segB = {
          axis: 'v',
          at: fr.x + d.bw + kerf / 2,
          lo: fr.y,
          hi: cutY ? fr.y + d.bh : fr.y + fr.h,
          deps: rec.segA ? [rec.segA] : parentDeps
        }
      }
      positions.forEach((pos, i) => {
        const gap = d.bh - pos.m.orient.ph
        if (gap >= kerf - EPS) {
          extras.push({
            axis: 'h',
            at: pos.y + pos.m.orient.ph + kerf / 2,
            lo: pos.x,
            hi: pos.x + pos.m.cross,
            deps: [
              ...(i > 0 ? [bandCuts[i - 1]] : []),
              ...(i < members.length - 1 ? [bandCuts[i]] : []),
              ...(rec.segA ? [rec.segA] : [])
            ]
          })
        }
      })
      if (cutY) addFreeRect(s, { x: fr.x, y: fr.y + d.bh + kerf, w: fr.w, h: gy - kerf }, rec.id, 'A')
      if (cutX) {
        addFreeRect(
          s,
          { x: fr.x + d.bw + kerf, y: fr.y, w: gx - kerf, h: cutY ? d.bh : fr.h },
          rec.id,
          'B'
        )
      }
    }

    rec.segExtra = extras
    s.recs.push(rec)

    const instanceIds: string[] = []
    for (const pos of positions) {
      seq++
      pos.m.inst.group = {
        ...pos.m.inst.group!,
        segmentCode: plan.segmentCode
      }
      const pl = makePlacement(pos.m.inst, s, pos.x, pos.y, pos.m.orient)
      pl.seq = seq
      pl.grainSegmentCode = plan.segmentCode
      s.placements.push(pl)
      instanceIds.push(pl.instanceId)
    }

    const placed: PlacedSegment = {
      ...plan,
      sheetIndex: s.index,
      x: fr.x,
      y: fr.y,
      bw: d.bw,
      bh: d.bh,
      instanceIds,
      reason
    }
    placedSegments.push(placed)
    return placed
  }

  const findFullSlot = (atom: GroupAtom): { s: SheetState; fr: FRect; waste: number } | null => {
    const d = dimsOf(atom.members, atom)
    let best: { s: SheetState; fr: FRect; waste: number } | null = null
    for (const s of sheets) {
      if (!atom.boardId || s.board.id === atom.boardId) {
        for (const fr of s.free) {
          if (fitsClean(fr.w, d.bw) && fitsClean(fr.h, d.bh)) {
            const waste = fr.w * fr.h - d.bw * d.bh
            if (!best || waste < best.waste) best = { s, fr, waste }
          }
        }
      }
    }
    return best
  }

  const freshBoardForMembers = (atom: GroupAtom, members: GroupMemberAtom[]): Board | null => {
    const d = dimsOf(members, atom)
    return pickNewBoard(atom.boardId ? ({ ...atom.members[0].part, boardId: atom.boardId }) : atom.members[0].part, d.bw, d.bh)
  }

  const planFor = (atom: GroupAtom, members: GroupMemberAtom[], code: string, split: boolean): SegmentPlan => ({
    atom,
    members,
    segmentCode: code,
    startOrder: members[0].inst.group!.order,
    endOrder: members[members.length - 1].inst.group!.order,
    split
  })

  const placeOnFreshBoard = (plan: SegmentPlan): PlacedSegment | null => {
    const nb = freshBoardForMembers(plan.atom, plan.members)
    if (!nb) return null
    const s = openSheet(nb)
    openedCount.set(nb.id, (openedCount.get(nb.id) ?? 0) + 1)
    return placeSegment(plan, s, s.free[0], 'freshSheet')
  }

  const requestedSplitIndex = (atom: GroupAtom): number | null => {
    const n = atom.members.length
    const raw = atom.def.splitAfter
    if (raw === undefined || raw === null) return null
    return raw >= 1 && raw <= n - 1 ? raw : null
  }

  const defaultSplitIndex = (atom: GroupAtom, availChain?: number): number | null => {
    const n = atom.members.length
    const asked = requestedSplitIndex(atom)
    const fits = (i: number): boolean => {
      const prefix = atom.members.slice(0, i)
      const d = dimsOf(prefix, atom)
      const chain = atom.axis === 'x' ? d.bw : d.bh
      if (availChain !== undefined && !fitsClean(availChain, chain)) return false
      return !!freshBoardForMembers(atom, atom.members.slice(i))
    }
    if (asked !== null) return fits(asked) ? asked : null
    const half = Math.ceil(n / 2)
    const candidates = [half, half - 1, ...Array.from({ length: n }, (_, i) => i + 1)]
    for (const i of [...new Set(candidates)]) {
      if (i >= 1 && i < n && fits(i)) return i
    }
    return null
  }

  const splitFresh = (atom: GroupAtom): PlacedSegment[] | null => {
    // 长组优先已经先尝试整组挪到新板；到这里说明单张板幅容纳不了整条。
    const dFull = dimsOf(atom.members, atom)
    const viable = boards.filter((b) => {
      if (!canOpen(b)) return false
      const p = atom.boardId ? { ...atom.members[0].part, boardId: atom.boardId } : atom.members[0].part
      if (!boardMatches(b, p)) return false
      const chainAvail = atom.axis === 'x' ? b.wMm - 2 * trim : b.hMm - 2 * trim
      const otherAvail = atom.axis === 'x' ? b.hMm - 2 * trim : b.wMm - 2 * trim
      return otherAvail + EPS >= (atom.axis === 'x' ? dFull.bh : dFull.bw) && chainAvail > 0
    })
    for (const b of viable.sort((a, c) => a.wMm * a.hMm - c.wMm * c.hMm)) {
      const availChain = atom.axis === 'x' ? b.wMm - 2 * trim : b.hMm - 2 * trim
      // 预占当前板：后半段不能再选同一块一次性余料板。
      const openedBefore = openedCount.get(b.id) ?? 0
      openedCount.set(b.id, openedBefore + 1)
      const explicit = requestedSplitIndex(atom)
      let index: number | null = null
      const probe = (i: number): boolean => {
        const pd = dimsOf(atom.members.slice(0, i), atom)
        const prefixChain = atom.axis === 'x' ? pd.bw : pd.bh
        if (!fitsClean(availChain, prefixChain)) return false
        const sd = dimsOf(atom.members.slice(i), atom)
        const suffix = pickNewBoard(
          atom.boardId ? { ...atom.members[0].part, boardId: atom.boardId } : atom.members[0].part,
          sd.bw,
          sd.bh
        )
        return !!suffix
      }
      if (explicit !== null) {
        if (probe(explicit)) index = explicit
      } else {
        const half = Math.ceil(atom.members.length / 2)
        const candidates = [half, half - 1, ...atom.members.map((_, i) => i + 1)]
        index = [...new Set(candidates)].find((i) => i >= 1 && i < atom.members.length && probe(i)) ?? null
      }
      if (index === null) {
        openedCount.set(b.id, openedBefore)
        continue
      }
      const s1 = openSheet(b)
      const p1 = placeSegment(planFor(atom, atom.members.slice(0, index), `${atom.code}-A`, true), s1, s1.free[0], 'boardCapacity')
      const p2 = placeOnFreshBoard(planFor(atom, atom.members.slice(index), `${atom.code}-B`, true))
      if (p2) return [p1, p2]
      openedCount.set(b.id, openedBefore)
    }
    return null
  }

  const splitIntoExisting = (atom: GroupAtom): PlacedSegment[] | null => {
    let chosen: { s: SheetState; fr: FRect; index: number; waste: number } | null = null
    for (const s of sheets) {
      if (atom.boardId && s.board.id !== atom.boardId) continue
      for (const fr of s.free) {
        const availChain = atom.axis === 'x' ? fr.w : fr.h
        const other = atom.axis === 'x' ? fr.h : fr.w
        const full = dimsOf(atom.members, atom)
        if (other + EPS < (atom.axis === 'x' ? full.bh : full.bw)) continue
        const index = defaultSplitIndex(atom, availChain)
        if (index === null) continue
        const prefix = dimsOf(atom.members.slice(0, index), atom)
        const pw = atom.axis === 'x' ? prefix.bw : full.bw
        const ph = atom.axis === 'x' ? full.bh : prefix.bh
        if (!fitsClean(fr.w, pw) || !fitsClean(fr.h, ph)) continue
        const waste = fr.w * fr.h - pw * ph
        if (!chosen || waste < chosen.waste) chosen = { s, fr, index, waste }
      }
    }
    if (!chosen) return null
    const p1 = placeSegment(
      planFor(atom, atom.members.slice(0, chosen.index), `${atom.code}-A`, true),
      chosen.s,
      chosen.fr,
      'currentSheet'
    )
    const p2 = placeOnFreshBoard(planFor(atom, atom.members.slice(chosen.index), `${atom.code}-B`, true))
    return p2 ? [p1, p2] : null
  }

  const markAtomUnplaced = (atom: GroupAtom): void => {
    atom.members.forEach((m) => markUnplaced(m.part))
  }

  for (const atom of queueAtoms) {
    const slot = findFullSlot(atom)
    if (slot) {
      placeSegment(planFor(atom, atom.members, atom.code, false), slot.s, slot.fr, 'currentSheet')
      continue
    }

    if (priority === 'longFirst') {
      // 先排长组：不把长组塞进半截空档，优先保住整条连纹。
      const freshFull = freshBoardForMembers(atom, atom.members)
      if (freshFull) {
        const s = openSheet(freshFull)
        openedCount.set(freshFull.id, (openedCount.get(freshFull.id) ?? 0) + 1)
        placeSegment(planFor(atom, atom.members, atom.code, false), s, s.free[0], 'freshSheet')
      } else if (atom.def.splitPolicy === 'split') {
        const parts = splitFresh(atom)
        if (!parts) markAtomUnplaced(atom)
      } else {
        markAtomUnplaced(atom)
      }
    } else {
      // 先排短组：允许当前组长在已打开板的半截缝里断开，省板但牺牲整面连纹。
      if (atom.def.splitPolicy === 'split') {
        const existing = splitIntoExisting(atom)
        if (existing) continue
        const freshFull = freshBoardForMembers(atom, atom.members)
        if (freshFull) {
          const s = openSheet(freshFull)
          openedCount.set(freshFull.id, (openedCount.get(freshFull.id) ?? 0) + 1)
          placeSegment(planFor(atom, atom.members, atom.code, false), s, s.free[0], 'freshSheet')
        } else {
          const parts = splitFresh(atom)
          if (!parts) markAtomUnplaced(atom)
        }
      } else {
        const freshFull = freshBoardForMembers(atom, atom.members)
        if (freshFull) {
          const s = openSheet(freshFull)
          openedCount.set(freshFull.id, (openedCount.get(freshFull.id) ?? 0) + 1)
          placeSegment(planFor(atom, atom.members, atom.code, false), s, s.free[0], 'freshSheet')
        } else {
          markAtomUnplaced(atom)
        }
      }
    }
  }

  // 零散件按既有大件优先/贴合空档规则填缝。
  for (const inst of looseSorted) {
    const p = inst.part
    let best:
      | { sheet: SheetState | null; fr: FRect | null; nb: Board | null; o: Orient; tier: number; waste: number }
      | null = null
    for (const o of orientsOf(p)) {
      for (const s of sheets) {
        if (!boardMatches(s.board, p)) continue
        for (const fr of s.free) {
          if (fitsClean(fr.w, o.pw) && fitsClean(fr.h, o.ph)) {
            const waste = fr.w * fr.h - o.pw * o.ph
            if (!best || waste < best.waste) best = { sheet: s, fr, nb: null, o, tier: 0, waste }
          }
        }
      }
      const nb = pickNewBoard(p, o.pw, o.ph)
      if (nb) {
        const tier = nb.kind === 'offcut' ? 1 : 2
        const waste = (nb.wMm - 2 * trim) * (nb.hMm - 2 * trim) - o.pw * o.ph
        if (!best || tier < best.tier || (tier === best.tier && waste < best.waste)) {
          best = { sheet: null, fr: null, nb, o, tier, waste }
        }
      }
    }
    if (!best) {
      markUnplaced(p)
      continue
    }
    let s: SheetState
    let fr: FRect
    if (best.sheet && best.fr) {
      s = best.sheet
      fr = best.fr
    } else {
      const nb = best.nb ?? pickNewBoard(p, best.o.pw, best.o.ph)
      if (!nb) {
        markUnplaced(p)
        continue
      }
      s = openSheet(nb)
      openedCount.set(nb.id, (openedCount.get(nb.id) ?? 0) + 1)
      fr = s.free[0]
    }
    placeSingle(inst, s, fr, best.o)
  }

  /** 把已放置分段转成三处共用的同一份组号/板号/断口数据。 */
  const segmentInfoOf = (ps: PlacedSegment): GrainSegmentInfo => {
    const orders = ps.members.map((m) => m.inst.group!.order)
    return {
      code: ps.segmentCode,
      groupId: ps.atom.def.id,
      boardIndex: ps.sheetIndex,
      boardNo: ps.sheetIndex + 1,
      startOrder: Math.min(...orders),
      endOrder: Math.max(...orders),
      instanceIds: ps.instanceIds,
      partCodes: ps.members.map((m) => m.part.code),
      chainLengthMm: Math.round(dimsOf(ps.members, ps.atom).netChain),
      areaMm2: Math.round(ps.members.reduce((a, m) => a + m.part.lenMm * m.part.widMm, 0)),
      axis: ps.atom.axis,
      split: ps.split
    }
  }

  const singletonSegmentOf = (atom: GroupAtom): GrainSegmentInfo | null => {
    const m = atom.members[0]
    const pl = sheets.flatMap((s) => s.placements).find((p) => p.instanceId === m.inst.key)
    if (!pl) return null
    return {
      code: atom.code,
      groupId: atom.def.id,
      boardIndex: pl.boardIndex,
      boardNo: pl.boardIndex + 1,
      startOrder: 1,
      endOrder: 1,
      instanceIds: [pl.instanceId],
      partCodes: [m.part.code],
      chainLengthMm: Math.round(m.cross),
      areaMm2: Math.round(m.part.lenMm * m.part.widMm),
      axis: atom.axis,
      split: false
    }
  }

  const allSegmentInfos: GrainSegmentInfo[] = [
    ...placedSegments.map(segmentInfoOf),
    ...groupAtoms.filter((g) => g.members.length === 1).map(singletonSegmentOf).filter((x): x is GrainSegmentInfo => !!x)
  ]
  const segmentsBySheet = new Map<number, GrainSegmentInfo[]>()
  allSegmentInfos.forEach((seg) => {
    const arr = segmentsBySheet.get(seg.boardIndex) ?? []
    arr.push(seg)
    segmentsBySheet.set(seg.boardIndex, arr)
  })

  const buildGroupResult = (atom: GroupAtom): GrainGroupResult => {
    const segments = allSegmentInfos.filter((s) => s.groupId === atom.def.id)
    const expected = new Set(atom.members.map((m) => m.inst.key))
    const placedKeys = new Set(segments.flatMap((s) => s.instanceIds))
    const missing = expected.size !== placedKeys.size
    const splitSegments = placedSegments.filter((p) => p.atom.def.id === atom.def.id && p.split)
    const breaks: GrainBreak[] = []
    for (let i = 0; i < splitSegments.length; i += 2) {
      const a = splitSegments[i]
      const b = splitSegments[i + 1]
      if (!b) continue
      const beforeLast = a.members[a.members.length - 1]
      const afterFirst = b.members[0]
      breaks.push({
        groupId: atom.def.id,
        groupCode: atom.code,
        afterOrder: a.endOrder,
        beforeInstanceId: beforeLast.inst.key,
        beforeCode: beforeLast.part.code,
        afterCode: afterFirst.part.code,
        boardIndex: b.sheetIndex,
        boardNo: b.sheetIndex + 1,
        axis: atom.axis,
        atMm: Math.round(atom.axis === 'x' ? b.x : b.y),
        reason: a.reason === 'currentSheet' ? 'fallback' : 'boardCapacity'
      })
    }
    const status = missing ? 'unplaced' : segments.some((s) => s.split) ? 'split' : 'complete'
    const longest = segments.reduce((a, s) => Math.max(a, s.chainLengthMm), 0)
    return {
      id: atom.def.id,
      code: atom.code,
      name: atom.def.name,
      memberCount: atom.members.length,
      netChainLengthMm: status === 'complete' ? Math.round(atom.netChain) : longest,
      totalAreaMm2: Math.round(atom.area),
      status,
      segments,
      breaks,
      connectedOrders: segments.map((s) => Array.from({ length: s.endOrder - s.startOrder + 1 }, (_, i) => s.startOrder + i)),
      note:
        status === 'complete'
          ? `${atom.members.length} 件同板、同纹同向，连纹完整`
          : status === 'split'
            ? `按让步规则拆成 ${segments.length} 小段；${segments.map((s) => `第 ${s.startOrder}-${s.endOrder} 件仍连续`).join('；')}`
            : '有成员未能排下，本组连纹不成立'
    }
  }

  const grainResults: GrainGroupResult[] = []
  groupAtoms.forEach((atom) => grainResults.push(buildGroupResult(atom)))
  invalidGroups.forEach((ig) => {
    grainResults.push({
      id: ig.def.id,
      code: ig.code,
      name: ig.def.name,
      memberCount: 0,
      netChainLengthMm: 0,
      totalAreaMm2: 0,
      status: 'invalid',
      segments: [],
      breaks: [],
      connectedOrders: [],
      note: ig.note
    })
  })

  // 组装 SheetResult
  const results: SheetResult[] = sheets.map((s) =>
    buildSheet(s, kerf, trim, segmentsBySheet.get(s.index) ?? [])
  )

  // 统计
  const boardsByType: Record<string, number> = {}
  let totalCost = 0
  for (const s of results) {
    boardsByType[s.boardName] = (boardsByType[s.boardName] ?? 0) + 1
    totalCost += s.priceCents
  }
  let exposedM = 0
  let normalM = 0
  for (const s of results) {
    for (const pl of s.placements) {
      const m =
        (pl.origLen *
          ((pl.edgeBands.includes('top') ? 1 : 0) + (pl.edgeBands.includes('bottom') ? 1 : 0)) +
          pl.origWid *
            ((pl.edgeBands.includes('left') ? 1 : 0) + (pl.edgeBands.includes('right') ? 1 : 0))) /
        1000
      if (pl.exposed) exposedM += m
      else normalM += m
    }
  }

  const unplacedList: UnplacedInfo[] = [...unplaced.values()].map((u) => ({
    partId: u.part.id,
    code: u.part.code,
    name: u.part.name,
    qty: u.qty,
    reason:
      u.part.grain === 'none'
        ? '板材尺寸或库存不足，无法排下'
        : u.part.grain === 'length'
          ? '因纹理要求为竖纹（不可旋转），现有板材排不下'
          : '因纹理要求为横纹（不可旋转），现有板材排不下'
  }))

  const baselineBoards = shelfBaseline(job, boards, kerf, trim, results.length)
  const optimizedBoards = results.length
  const savedBoards = Math.max(0, baselineBoards - optimizedBoards)
  const stockShortage = boards
    .filter((b) => b.kind !== 'offcut' && b.quantity > 0)
    .map((b) => ({
      boardId: b.id,
      boardName: b.name,
      need: openedCount.get(b.id) ?? 0,
      have: b.quantity
    }))
    .filter((x) => x.need > x.have)

  const stockUsed = results.filter((s) => s.priceCents > 0)
  const avgPrice =
    stockUsed.length > 0
      ? stockUsed.reduce((a, s) => a + s.priceCents, 0) / stockUsed.length
      : job.boards.reduce((a, b) => a + b.priceCents, 0) / Math.max(1, job.boards.length)

  const grainSummary: GrainNestSummary = {
    version: 1,
    strategy: priority,
    tradeoff:
      priority === 'longFirst'
        ? '已选“先排长组”：保住长条连纹；短组/零散件可能被挤到边角并多用板。'
        : '已选“先排短组”：短组优先填小板缝、更省板；长组可能在板间断开，牺牲整柜花纹完整。',
    unit: {
      length: 'mm',
      lengthRounding: '整数（四舍五入）',
      area: 'mm²',
      areaRounding: '整数（四舍五入）'
    },
    groups: grainResults,
    changes: [],
    issuedRevisions: [],
    inputSignature: grainInputSignature(job)
  }

  return {
    sheets: results,
    boardsUsed: optimizedBoards,
    boardsByType,
    edgeBandM: {
      exposed: Math.round(exposedM * 100) / 100,
      normal: Math.round(normalM * 100) / 100
    },
    unplaced: unplacedList,
    baselineBoards,
    savedBoards,
    savedCents: Math.round(savedBoards * avgPrice),
    totalCostCents: totalCost,
    stockShortage,
    grain: grainSummary,
    elapsedMs: Math.round(performance.now() - t0),
    generatedAt: Date.now()
  }
}

function annotateGrainSteps(sheet: SheetResult, segments: GrainSegmentInfo[]): void {
  if (segments.length === 0) return
  const boxes = segments.map((seg) => {
    const ps = sheet.placements.filter((p) => p.grainSegmentCode === seg.code)
    return {
      seg,
      x1: Math.min(...ps.map((p) => p.x)),
      x2: Math.max(...ps.map((p) => p.x + p.lenMm)),
      y1: Math.min(...ps.map((p) => p.y)),
      y2: Math.max(...ps.map((p) => p.y + p.widMm))
    }
  })
  for (const st of sheet.steps) {
    if (st.kind === 'trim') continue
    const codes = new Set<string>()
    for (const b of boxes) {
      const touches =
        st.axis === 'v'
          ? st.at >= b.x1 - 6 && st.at <= b.x2 + 6 && st.span[1] > b.y1 - EPS && st.span[0] < b.y2 + EPS
          : st.at >= b.y1 - 6 && st.at <= b.y2 + 6 && st.span[1] > b.x1 - EPS && st.span[0] < b.x2 + EPS
      if (touches) codes.add(b.seg.code)
    }
    if (codes.size > 0) {
      st.grainSegmentCodes = [...codes]
      st.label = `${st.label}【${[...codes].join('/')}】`
    }
  }
}

function buildSheet(
  s: SheetState,
  kerf: number,
  trim: number,
  grainSegments: GrainSegmentInfo[]
): SheetResult {
  const raw: DSeg[] = []
  for (const r of s.recs) {
    if (r.segA) raw.push(r.segA)
    if (r.segB) raw.push(r.segB)
    if (r.segExtra) raw.push(...r.segExtra)
  }
  const b = s.board
  const steps = buildSteps(b.wMm, b.hMm, kerf, trim, s.index, raw)
  const boardArea = b.wMm * b.hMm
  const usedArea = s.placements.reduce((a, p) => a + p.origLen * p.origWid, 0)

  // 剩余空档全部留档；两边 ≥300mm 才标记为可用余料，按面积降序。
  // 连纹条内部因长短错落锁住的碎隙不会进入 free，因此不会插入别家件。
  const offcuts: OffcutInfo[] = s.free
    .filter((f) => f.w >= 2 && f.h >= 2)
    .map((f) => ({
      x: Math.round(f.x),
      y: Math.round(f.y),
      wMm: Math.round(f.w),
      hMm: Math.round(f.h),
      areaMm2: Math.round(f.w * f.h),
      usable: f.w >= 300 - EPS && f.h >= 300 - EPS
    }))
    .sort((a, c) => c.areaMm2 - a.areaMm2)

  const sheet: SheetResult = {
    index: s.index,
    boardId: b.id,
    boardName: b.name,
    material: b.material,
    thicknessMm: b.thicknessMm,
    wMm: b.wMm,
    hMm: b.hMm,
    priceCents: b.kind === 'offcut' ? 0 : b.priceCents,
    placements: s.placements,
    steps,
    usedAreaMm2: usedArea,
    boardAreaMm2: boardArea,
    utilization: usedArea / boardArea,
    offcuts,
    grainSegments
  }
  annotateGrainSteps(sheet, grainSegments)
  const sim = simulate(b.wMm, b.hMm, kerf, steps, s.placements)
  if (!sim.ok) {
    console.error(`[排样] 第 ${s.index + 1} 张板切割模拟失败`, sim.errors)
  }
  return sheet
}

/**
 * 「随手排」基线：保持清单原顺序、固定朝向（不旋转）、朴素顺板货架式摆放。
 * 用于展示「本方案比随手排省几张板」。库存耗尽时退化为与优化方案相同的张数。
 */
function shelfBaseline(
  job: Job,
  boards: Board[],
  kerf: number,
  trim: number,
  optimizedCount: number
): number {
  let count = 0
  const cur: { value: { b: Board; x: number; y: number; shelfH: number } | null } = { value: null }
  const usable = (b: Board): [number, number] => [b.wMm - 2 * trim, b.hMm - 2 * trim]
  const newSheet = (b: Board): void => {
    count++
    cur.value = { b, x: 0, y: 0, shelfH: 0 }
  }
  const canOpen = (b: Board): boolean => b.kind !== 'offcut'
  for (const part of job.parts) {
    for (let k = 0; k < part.qty; k++) {
      const pw = part.grain === 'width' ? part.widMm : part.lenMm
      const ph = part.grain === 'width' ? part.lenMm : part.widMm
      const tryCur = (): boolean => {
        const c = cur.value
        if (!c || !boardMatches(c.b, part)) return false
        const [uw, uh] = usable(c.b)
        if (c.x + pw <= uw + EPS && c.y + Math.max(c.shelfH, ph) <= uh + EPS) {
          if (c.x === 0 && c.shelfH === 0) c.shelfH = ph
          c.x += pw + kerf
          c.shelfH = Math.max(c.shelfH, ph)
          return true
        }
        if (c.x > 0) {
          c.y += c.shelfH + kerf
          c.x = 0
          c.shelfH = 0
          if (pw <= uw + EPS && c.y + ph <= uh + EPS) {
            c.shelfH = ph
            c.x = pw + kerf
            return true
          }
        }
        return false
      }
      if (tryCur()) {
        // 已摆入当前板
      } else {
        const candidates = boards
          .filter(
            (b) =>
              canOpen(b) &&
              boardMatches(b, part) &&
              b.wMm - 2 * trim + EPS >= pw &&
              b.hMm - 2 * trim + EPS >= ph
          )
          .sort((a, b) => a.wMm * a.hMm - b.wMm * b.hMm)
        if (candidates.length === 0) return Math.max(optimizedCount, count)
        newSheet(candidates[0])
        cur.value!.x = pw + kerf
        cur.value!.shelfH = ph
      }
    }
  }
  return Math.max(count, optimizedCount)
}
