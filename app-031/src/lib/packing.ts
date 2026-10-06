// 核心排样：guillotine（直线贯通可锯）递归二分 2D 装箱
// - 纹理 length/width 硬约束：只允许指定朝向，rotated 恒为 false，放不下就报原因
// - 锯路 kerf：零件与零件、零件与余料之间留锯缝；修边 trim 为四周先切掉的边
// - 利用率分母为整板面积，分子为零件净面积（不含锯路）
// - 成组连纹：同组件作为「长条宏件」整体进入下面同一套空档/朝向/余隙判定，
//   不另开只认门板的分支；段内首尾相接、中间不插别家件，横断刀走同一套 DSeg 依赖。
import type {
  Board,
  GrainBreakReport,
  GrainGroupDef,
  GrainSegmentReport,
  GroupOrderPolicy,
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
import { buildGrainGroupResults, grainAreaMm2, grainLengthMm, grainSignature } from './grain'

interface Inst {
  part: Part
  k: number // 第 k 件（qty 展开）
  key: string
  cabinet: string
}

interface FRect extends Rect {
  id: number
  parentRec: number | null // 由哪次放置产生（切割依赖）
  entrySeg: 'A' | 'B' | null // 进入该空档前必须完成的刀：首刀/次刀
  directDeps?: DSeg[] // 连纹单元格：进入前需先完成的具体刀（横断刀 + 边界刀）
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
  internal?: DSeg[] // 连纹长条段内横断刀（把整条按件分块）
}

interface SheetState {
  board: Board
  index: number
  usable: Rect
  free: FRect[]
  recs: Rec[]
  placements: Placement[]
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

interface Orient {
  pw: number
  ph: number
  rotated: boolean
}

// 连纹长条方案：段整体沿 axis 排布，along 为纹理方向总长，cross 为垂直纹理的最大跨
interface MemberGeo {
  along: number
  cross: number
  rotated: boolean
}
interface StripScheme {
  axis: 'x' | 'y'
  along: number
  cross: number
  members: MemberGeo[]
}

/**
 * 连纹长条的可选方案。复用零件自身的朝向硬约束（竖/横纹不可转），
 * 不另开「只认门板」分支：纹理被强制垂直于纹理轴时直接淘汰该方案。
 * x 轴 = 沿板长（首选，统一横板后即沿纹理长条方向）。
 */
function stripSchemes(parts: Part[], kerf: number): StripScheme[] {
  if (parts.length === 0) return []
  // 每一件可选（沿纹理轴 along，垂直 cross）
  const geos: { along: number; cross: number; rotated: boolean }[][] = parts.map((p) => {
    if (p.grain === 'length') return [{ along: p.lenMm, cross: p.widMm, rotated: false }]
    if (p.grain === 'width') return [{ along: p.widMm, cross: p.lenMm, rotated: false }]
    if (p.lenMm === p.widMm) return [{ along: p.lenMm, cross: p.widMm, rotated: false }]
    // 无纹理：顺摆 / 转 90° 都可（朝向判定走与 orientsOf 相同的规则）
    return [
      { along: p.lenMm, cross: p.widMm, rotated: false },
      { along: p.widMm, cross: p.lenMm, rotated: true }
    ]
  })
  const build = (axis: 'x' | 'y'): StripScheme | null => {
    // 选每件的 along/cross：无纹理件取让整条 cross 更小的（窄长条更易排）
    const members: MemberGeo[] = geos.map((opts) => {
      if (opts.length === 1) return opts[0]
      return opts.reduce((a, b) => (a.cross <= b.cross ? a : b))
    })
    const along = members.reduce((a, m) => a + m.along, 0) + kerf * (members.length - 1)
    const cross = Math.max(...members.map((m) => m.cross))
    return { axis, along, cross, members }
  }
  const x = build('x')
  // y 轴方案仅当全部件都允许把 along 转到 y：有固定纹理（length/width）时
  // 若 x 已能容纳其固定朝向，y 会强制 90° 旋转 → 违反纹理硬约束，淘汰。
  const anyGrained = parts.some((p) => p.grain !== 'none')
  const schemes: StripScheme[] = []
  if (x) schemes.push(x)
  if (!anyGrained) {
    const y = build('y')
    if (y) schemes.push(y)
  }
  return schemes
}

export function nestJob(job: Job): NestResult {
  const t0 = performance.now()
  boardDefs.clear()
  const boards = job.boards.map(normalize)
  boards.forEach((b) => boardDefs.set(b.id, b))
  const kerf = job.kerfMm
  const trim = job.trimMm
  const grainPolicy: GroupOrderPolicy = job.grainPolicy ?? 'long-first'

  const openedCount = new Map<string, number>()

  // 零件实例展开
  const insts: Inst[] = []
  for (const p of job.parts) {
    for (let k = 1; k <= Math.max(0, p.qty); k++) {
      insts.push({ part: p, k, key: `${p.id}#${k}`, cabinet: p.cabinet || '未分组' })
    }
  }

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

  // —— 成组连纹：校验定义、把组成员实例按顺序绑定 ——
  const grainWarnings: string[] = []
  const partById = new Map<string, Part>()
  for (const p of job.parts) partById.set(p.id, p)
  interface BoundGroup {
    def: GrainGroupDef
    no: number
    members: Inst[]
    schemes: StripScheme[]
    nextSegmentNo: number
  }
  const instGroupOf = new Map<string, BoundGroup>()
  const boundGroups: BoundGroup[] = []
  {
    let gno = 0
    for (const def of job.grainGroups ?? []) {
      const ids = def.memberPartIds.filter((id) => {
        if (partById.has(id)) return true
        grainWarnings.push(`连纹组「${def.name}」引用了已删除零件，该引用已忽略`)
        return false
      })
      const members: Inst[] = []
      for (const id of ids) {
        const p = partById.get(id)!
        for (let k = 1; k <= Math.max(0, p.qty); k++)
          members.push(insts.find((it) => it.key === `${id}#${k}`)!)
      }
      const own = members.filter((m) => {
        if (instGroupOf.has(m.key)) {
          grainWarnings.push(`连纹组「${def.name}」与其他组共用零件 ${m.part.code}，重复绑定已忽略`)
          return false
        }
        return true
      })
      // 指定了不同厚度板种 → 无法同板，解散
      const specified = [...new Set(own.map((m) => m.part.boardId).filter((x): x is string => !!x))]
      const sameThickness =
        specified.length <= 1 ||
        specified.every((id) => boardDefs.get(id)?.thicknessMm === boardDefs.get(specified[0])?.thicknessMm)
      let validParts = own
      if (specified.length > 1 && sameThickness) {
        // 同厚度不同板 id：清空指定，让同厚度板都能落
        validParts = own.map((m) => (m.part.boardId ? { ...m, part: { ...m.part, boardId: undefined } } : m))
      }
      const schemes = sameThickness ? stripSchemes(validParts.map((m) => m.part), kerf) : []
      const bindable = sameThickness && validParts.length >= 2 && schemes.length > 0
      if (!sameThickness)
        grainWarnings.push(`连纹组「${def.name}」成员指定了不同厚度/板种，无法同板，已解散按零散件排样`)
      else if (validParts.length >= 2 && schemes.length === 0)
        grainWarnings.push(`连纹组「${def.name}」成员纹理朝向无法统一，已解散按零散件排样`)
      else if (validParts.length === 1)
        grainWarnings.push(`连纹组「${def.name}」只有一件，不产生断口，按单件排样`)
      const bg: BoundGroup = {
        def,
        no: ++gno,
        members: bindable ? validParts : [],
        schemes: bindable ? schemes : [],
        nextSegmentNo: 1
      }
      boundGroups.push(bg)
      if (bindable) for (const m of bg.members) instGroupOf.set(m.key, bg)
    }
  }

  // 零散件排序：按柜体批次分组时柜体优先；随后大边降序、面积降序
  const looseInsts = insts.filter((i) => !instGroupOf.has(i.key))
  const sortedLoose = [...looseInsts].sort((a, b) => {
    if (job.batchByCabinet && a.cabinet !== b.cabinet) return a.cabinet < b.cabinet ? -1 : 1
    const am = Math.max(a.part.lenMm, a.part.widMm)
    const bm = Math.max(b.part.lenMm, b.part.widMm)
    if (bm !== am) return bm - am
    return b.part.lenMm * b.part.widMm - a.part.lenMm * a.part.widMm
  })
  // 长组优先/短组优先：按首选方案沿纹理长度排（取舍见 GroupOrderPolicy 注释）
  const rootGroups = [...boundGroups]
    .filter((g) => g.members.length >= 2)
    .sort((a, b) =>
      grainPolicy === 'long-first'
        ? b.schemes[0].along - a.schemes[0].along // 长组先：保住长条连纹
        : a.schemes[0].along - b.schemes[0].along // 短组先：先用小板缝填省板
    )

  const sheets: SheetState[] = []
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
        { id: frSeq++, x: usable.x, y: usable.y, w: usable.w, h: usable.h, parentRec: null, entrySeg: null }
      ],
      recs: [],
      placements: []
    }
    sheets.push(s)
    return s
  }

  const canOpen = (b: Board): boolean => {
    if (b.kind === 'offcut') return (openedCount.get(b.id) ?? 0) < 1
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
    viable.sort((a, b) => {
      if ((a.kind === 'offcut') !== (b.kind === 'offcut')) return a.kind === 'offcut' ? -1 : 1
      return a.wMm * a.hMm - b.wMm * b.hMm
    })
    return viable[0] ?? null
  }

  const unplaced = new Map<string, { part: Part; qty: number; extra?: string[] }>()
  const markUnplaced = (p: Part, extra?: string): void => {
    const cur = unplaced.get(p.id)
    if (cur) {
      cur.qty++
      if (extra && !cur.extra?.includes(extra)) cur.extra = [...(cur.extra ?? []), extra]
    } else unplaced.set(p.id, { part: p, qty: 1, extra: extra ? [extra] : undefined })
  }

  const collectedSegments: GrainSegmentReport[] = []
  const collectedBreaks: GrainBreakReport[] = []
  const placedSegmentsByGroup = new Map<string, GrainSegmentReport[]>()
  let seq = 0

  // ---------- 单件放置（既有规矩：最佳贴合空档，递归二分余隙） ----------
  type BestSlot = {
    sheet: SheetState | null
    fr: FRect | null
    nb: Board | null
    o: Orient
    tier: number
    waste: number
  }

  const findBestSlot = (p: Part, pw: number, ph: number, rotated: boolean): BestSlot | null => {
    let best: BestSlot | null = null
    for (const s of sheets) {
      if (!boardMatches(s.board, p)) continue
      for (const fr of s.free) {
        if (fitsClean(fr.w, pw) && fitsClean(fr.h, ph)) {
          const waste = fr.w * fr.h - pw * ph
          if (!best || waste < best.waste)
            best = { sheet: s, fr, nb: null, o: { pw, ph, rotated }, tier: 0, waste }
        }
      }
    }
    const nb = pickNewBoard(p, pw, ph)
    if (nb) {
      const tier = nb.kind === 'offcut' ? 1 : 2
      const waste = (nb.wMm - 2 * trim) * (nb.hMm - 2 * trim) - pw * ph
      if (!best || tier < best.tier || (tier === best.tier && waste < best.waste))
        best = { sheet: null, fr: null, nb, o: { pw, ph, rotated }, tier, waste }
    }
    return best
  }

  const resolveSlot = (best: BestSlot): { s: SheetState; fr: FRect } | null => {
    if (best.sheet && best.fr) return { s: best.sheet, fr: best.fr }
    const nb = best.nb
    if (!nb) return null
    const s = openSheet(nb)
    openedCount.set(nb.id, (openedCount.get(nb.id) ?? 0) + 1)
    return { s, fr: s.free[0] }
  }

  /** 沿父放置的切割线建立依赖。 */
  function segDepsOf(fr: FRect, s: SheetState): DSeg[] {
    if (fr.directDeps) return fr.directDeps
    if (fr.parentRec === null || !fr.entrySeg) return []
    const rec = s.recs.find((r) => r.id === fr.parentRec)
    if (!rec) return []
    const seg = fr.entrySeg === 'A' ? rec.segA ?? rec.segB : rec.segB ?? rec.segA
    return seg ? [seg] : []
  }

  /** 把外层宏矩形（单件或整条）按 guillotine 递归二分拆余隙，产出 segA/segB。 */
  function splitOuter(
    s: SheetState,
    rec: Rec,
    fr: FRect,
    pw: number,
    ph: number,
    parentDeps: DSeg[]
  ): void {
    const addFree = (r: Rect, parentRec: number, entrySeg: 'A' | 'B', directDeps?: DSeg[]): void => {
      if (r.w >= 1 && r.h >= 1) s.free.push({ ...r, id: frSeq++, parentRec, entrySeg, directDeps })
    }
    const gx = fr.w - pw
    const gy = fr.h - ph
    const cutX = gx >= kerf - EPS
    const cutY = gy >= kerf - EPS
    if (rec.dir === 'v') {
      if (cutX)
        rec.segA = { axis: 'v', at: fr.x + pw + kerf / 2, lo: fr.y, hi: fr.y + fr.h, deps: parentDeps }
      if (cutY)
        rec.segB = {
          axis: 'h',
          at: fr.y + ph + kerf / 2,
          lo: fr.x,
          hi: cutX ? fr.x + pw : fr.x + fr.w,
          deps: rec.segA ? [rec.segA] : parentDeps
        }
      if (cutY) addFree({ x: fr.x, y: fr.y + ph + kerf, w: cutX ? pw : fr.w, h: gy - kerf }, rec.id, 'B')
      if (cutX) addFree({ x: fr.x + pw + kerf, y: fr.y, w: gx - kerf, h: fr.h }, rec.id, 'A')
    } else {
      if (cutY)
        rec.segA = { axis: 'h', at: fr.y + ph + kerf / 2, lo: fr.x, hi: fr.x + fr.w, deps: parentDeps }
      if (cutX)
        rec.segB = {
          axis: 'v',
          at: fr.x + pw + kerf / 2,
          lo: fr.y,
          hi: cutY ? fr.y + ph : fr.y + fr.h,
          deps: rec.segA ? [rec.segA] : parentDeps
        }
      if (cutY) addFree({ x: fr.x, y: fr.y + ph + kerf, w: fr.w, h: gy - kerf }, rec.id, 'A')
      if (cutX)
        addFree({ x: fr.x + pw + kerf, y: fr.y, w: gx - kerf, h: cutY ? ph : fr.h }, rec.id, 'B')
    }
  }

  const pushPlacement = (
    s: SheetState,
    inst: Inst,
    x: number,
    y: number,
    o: Orient
  ): Placement => {
    const p = inst.part
    seq++
    const pl: Placement = {
      partId: p.id,
      instanceId: inst.key,
      boardIndex: s.index,
      x,
      y,
      lenMm: o.pw,
      widMm: o.ph,
      origLen: p.lenMm,
      origWid: p.widMm,
      rotated: o.rotated,
      seq,
      code: p.code,
      name: p.name,
      cabinet: inst.cabinet,
      exposed: p.exposed,
      grain: p.grain,
      edgeBands: p.edgeBands
    }
    s.placements.push(pl)
    return pl
  }

  function placeSingle(inst: Inst): boolean {
    const p = inst.part
    let best: BestSlot | null = null
    for (const o of orientsOf(p)) {
      const slot = findBestSlot(p, o.pw, o.ph, o.rotated)
      if (slot && (!best || slot.tier < best.tier || (slot.tier === best.tier && slot.waste < best.waste)))
        best = slot
    }
    if (!best) {
      markUnplaced(p)
      return false
    }
    const got = resolveSlot(best)
    if (!got) {
      markUnplaced(p)
      return false
    }
    const { s, fr } = got
    s.free = s.free.filter((f) => f.id !== fr.id)
    const o = best.o
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
    splitOuter(s, rec, fr, o.pw, o.ph, segDepsOf(fr, s))
    s.recs.push(rec)
    pushPlacement(s, inst, fr.x, fr.y, o)
    return true
  }

  // ---------- 连纹长条段（宏件） ----------
  interface StripItem {
    group: BoundGroup
    members: Inst[]
    segmentNo: number
    reason: 'concession' | 'forced'
  }

  /** 仅在已开板里找最贴合空档（不开新板）。 */
  const findOpenStripSlot = (item: StripItem, scheme: StripScheme): BestSlot | null => {
    const pw = scheme.axis === 'x' ? scheme.along : scheme.cross
    const ph = scheme.axis === 'x' ? scheme.cross : scheme.along
    let best: BestSlot | null = null
    for (const s of sheets) {
      if (!boardMatches(s.board, item.members[0].part)) continue
      for (const fr of s.free) {
        if (fitsClean(fr.w, pw) && fitsClean(fr.h, ph)) {
          const waste = fr.w * fr.h - pw * ph
          if (!best || waste < best.waste)
            best = { sheet: s, fr, nb: null, o: { pw, ph, rotated: false }, tier: 0, waste }
        }
      }
    }
    return best
  }

  const findStripSlot = (item: StripItem, scheme: StripScheme): BestSlot | null => {
    const open = findOpenStripSlot(item, scheme)
    if (open) return open
    const pw = scheme.axis === 'x' ? scheme.along : scheme.cross
    const ph = scheme.axis === 'x' ? scheme.cross : scheme.along
    const nb = pickNewBoard(item.members[0].part, pw, ph)
    return nb
      ? { sheet: null, fr: null, nb, o: { pw, ph, rotated: false }, tier: nb.kind === 'offcut' ? 1 : 2,
          waste: (nb.wMm - 2 * trim) * (nb.hMm - 2 * trim) - pw * ph }
      : null
  }

  /** 落一整段：外层宏矩形二分 + 段内横断刀 + 矮件上方可填缝单元格。 */
  function placeStrip(item: StripItem, scheme: StripScheme, best: BestSlot): GrainSegmentReport {
    const got = resolveSlot(best)
    if (!got) throw new Error('strip slot vanished')
    const { s, fr } = got
    const { group } = item
    const axis = scheme.axis
    const pw = axis === 'x' ? scheme.along : scheme.cross
    const ph = axis === 'x' ? scheme.cross : scheme.along
    s.free = s.free.filter((f) => f.id !== fr.id)

    const rec: Rec = {
      id: s.recs.length,
      frId: fr.id,
      instKey: `strip:G${group.no}:s${item.segmentNo}`,
      x: fr.x,
      y: fr.y,
      pw,
      ph,
      dir: fr.w >= fr.h ? 'v' : 'h',
      internal: []
    }
    // 长条外层拆分：先沿条的沿纹理方向把整条与右侧（axis=x）余隙竖切分开，
    // 条上方余隙则只按「最高成员的顶」在条范围内横切（混高时不贯穿到右侧余隙），
    // 各成员自己上方的矮余隙再由内部刀切成可填缝单元格。
    const parentDeps = segDepsOf(fr, s)
    const addFree = (r: Rect, parentRec: number, entrySeg: 'A' | 'B' | null, directDeps?: DSeg[]): void => {
      if (r.w >= 1 && r.h >= 1) s.free.push({ ...r, id: frSeq++, parentRec, entrySeg, directDeps })
    }
    const gx = fr.w - pw
    const gy = fr.h - ph
    const cutX = gx >= kerf - EPS
    const cutY = gy >= kerf - EPS
    // 长条外层拆分（axis=x）：竖切把整条与右侧余隙分开。
    // 条上方余隙不做整宽一刀——混高时该刀在矮件列上方没有对应材料边界，
    // 会把矮件与其上方可填缝区错误粘连；改由各成员自己的顶刀（hSeg）逐列分离，
    // 最高成员（顶到条顶）的顶刀即该列的条顶刀。
    if (axis === 'x') {
      if (cutX)
        rec.segA = { axis: 'v', at: fr.x + pw + kerf / 2, lo: fr.y, hi: fr.y + fr.h, deps: parentDeps }
      if (cutX) addFree({ x: fr.x + pw + kerf, y: fr.y, w: gx - kerf, h: fr.h }, rec.id, 'A')
    } else {
      if (cutY)
        rec.segA = { axis: 'h', at: fr.y + ph + kerf / 2, lo: fr.x, hi: fr.x + fr.w, deps: parentDeps }
      if (cutY) addFree({ x: fr.x, y: fr.y + ph + kerf, w: fr.w, h: gy - kerf }, rec.id, 'A')
    }

    // 条边界上的沿纹理刀（segA/segB）作为段内横断刀的边界依赖
    const crossAxis: 'v' | 'h' = axis === 'x' ? 'v' : 'h'
    const grainAxis: 'v' | 'h' = axis === 'x' ? 'h' : 'v'
    const outerAlongCut = rec.dir === (axis === 'x' ? 'v' : 'h') ? rec.segA : rec.segB
    const outerCrossCut = rec.dir === (axis === 'x' ? 'v' : 'h') ? rec.segB : rec.segA

    const internal = rec.internal!
    const base = axis === 'x' ? fr.y : fr.x // 纹理条的底边（垂直纹理方向起点）
    let cursor = axis === 'x' ? fr.x : fr.y
    const memberSegs: { inst: Inst; m: MemberGeo; pos: number; end: number; boundarySeg?: DSeg; hSeg?: DSeg }[] = []
    let topLeftoverAdded = false

    for (let i = 0; i < item.members.length; i++) {
      const inst = item.members[i]
      const m = scheme.members[i]
      const pos = cursor
      const mx = axis === 'x' ? pos : fr.x
      const my = axis === 'x' ? fr.y : pos
      pushPlacement(s, inst, mx, my, {
        pw: axis === 'x' ? m.along : m.cross,
        ph: axis === 'x' ? m.cross : m.along,
        rotated: m.rotated
      })
      const pl = s.placements[s.placements.length - 1]
      pl.grainGroupId = group.def.id
      pl.grainGroupNo = group.no
      pl.grainSegmentId = `${group.def.id}#${item.segmentNo}`
      pl.grainSegmentNo = item.segmentNo
      pl.grainOrdinal = i + 1

      const end = pos + m.along
      const info: (typeof memberSegs)[number] = { inst, m, pos, end }

      // 每件上方沿纹理顶刀：矮件时切出可填缝单元格；高件（顶到条顶）时该刀与
      // 条顶重合，仍生成一把只覆盖本件范围的刀，保证相邻横断刀在拓扑上有贯通边界。
      const crossGap = scheme.cross - m.cross
      const sideDeps: DSeg[] = []
      if (i > 0 && memberSegs[i - 1].boundarySeg) sideDeps.push(memberSegs[i - 1].boundarySeg!)
      else if (outerCrossCut) sideDeps.push(outerCrossCut)
      if (outerAlongCut) sideDeps.push(outerAlongCut)
      const hSeg: DSeg = {
        axis: grainAxis,
        at: base + m.cross + kerf / 2,
        lo: pos,
        hi: end,
        deps: sideDeps.length ? sideDeps : parentDeps,
        cutKey: `${rec.instKey}:top:${i}`
      }
      internal.push(hSeg)
      info.hSeg = hSeg
      if (crossGap >= kerf - EPS) {
        const cellRect: Rect =
          axis === 'x'
            ? { x: pos, y: base + m.cross + kerf, w: m.along, h: crossGap - kerf }
            : { x: base + m.cross + kerf, y: pos, w: crossGap - kerf, h: m.along }
        addFree(cellRect, rec.id, null, [hSeg])
      } else if (gy >= kerf - EPS && !topLeftoverAdded) {
        // 最高成员（顶到条顶）：它的顶刀把条与条上方整宽余隙分开，
        // 条上方余隙只登记一次，进入依赖该顶刀。
        topLeftoverAdded = true
        addFree(
          axis === 'x'
            ? { x: fr.x, y: fr.y + ph + kerf, w: pw, h: gy - kerf }
            : { x: fr.x + ph + kerf, y: fr.y, w: gx - kerf, h: pw },
          rec.id,
          null,
          [hSeg]
        )
      }

      // 与下一件之间的横断刀：统一贯穿到条顶（最高成员的顶），保证 guillotine 贯通；
      // 相邻件更矮时，刀上方是已被顶刀分离的余隙，不会切穿任何零件。
      if (i + 1 < item.members.length) {
        const deps: DSeg[] = [hSeg]
        if (outerCrossCut) deps.push(outerCrossCut)
        if (outerAlongCut) deps.push(outerAlongCut)
        if (i > 0 && memberSegs[i - 1].boundarySeg) deps.push(memberSegs[i - 1].boundarySeg!)
        const cutSeg: DSeg = {
          axis: crossAxis,
          at: end + kerf / 2,
          lo: base,
          hi: base + scheme.cross,
          deps: [...new Set(deps)],
          grainGroupId: group.def.id,
          grainGroupNo: group.no,
          grainSegmentId: rec.instKey,
          grainCross: true,
          cutKey: `${rec.instKey}:cross:${i}`
        }
        internal.push(cutSeg)
        info.boundarySeg = cutSeg
        cursor = end + kerf
      }
      memberSegs.push(info)
    }
    s.recs.push(rec)

    const seg: GrainSegmentReport = {
      id: `${group.def.id}#${item.segmentNo}`,
      groupId: group.def.id,
      groupNo: group.no,
      groupName: group.def.name,
      segmentNo: item.segmentNo,
      boardIndex: s.index,
      boardName: s.board.name,
      axis,
      lengthMm: grainLengthMm(scheme.along),
      areaMm2: grainAreaMm2(item.members.reduce((a, mm) => a + mm.part.lenMm * mm.part.widMm, 0)),
      memberInstanceIds: item.members.map((m) => m.key),
      memberCodes: item.members.map((m) => m.part.code)
    }
    collectedSegments.push(seg)
    const arr = placedSegmentsByGroup.get(group.def.id) ?? []
    arr.push(seg)
    placedSegmentsByGroup.set(group.def.id, arr)
    return seg
  }

  /** 只在已开板上落段（不新板）；找不到返回 false。 */
  const tryPlaceOnOpenSheets = (item: StripItem, schemes: StripScheme[]): boolean => {
    let best: { slot: BestSlot; scheme: StripScheme } | null = null
    for (const scheme of schemes) {
      const slot = findOpenStripSlot(item, scheme)
      if (slot && (!best || slot.waste < best.slot.waste)) best = { slot, scheme }
    }
    if (!best) return false
    placeStrip(item, best.scheme, best.slot)
    return true
  }

  /**
   * 段（含拆出的后段）自己的方案：按本段成员重算沿纹理长度，
   * 轴向锁死为组的纹理方向（竖/横纹件的朝向判定仍走 stripSchemes 内的硬约束）。
   */
  const schemesFor = (item: StripItem): StripScheme[] => {
    const axis = item.group.schemes[0].axis
    return stripSchemes(item.members.map((m) => m.part), kerf).filter((sc) => sc.axis === axis)
  }

  /** 登记断口：前一段末件 与 本段首件 之间纹理接不上。 */
  function registerBreak(group: BoundGroup, item: StripItem, seg: GrainSegmentReport): void {
    if (item.segmentNo <= 1) return
    const prev = (placedSegmentsByGroup.get(group.def.id) ?? []).find(
      (x) => x.segmentNo === item.segmentNo - 1
    )
    if (!prev) return
    collectedBreaks.push({
      groupId: group.def.id,
      groupNo: group.no,
      groupName: group.def.name,
      afterSegmentNo: item.segmentNo,
      beforeInstanceId: prev.memberInstanceIds[prev.memberInstanceIds.length - 1],
      afterInstanceId: item.members[0].key,
      beforeCode: prev.memberCodes[prev.memberCodes.length - 1],
      afterCode: item.members[0].part.code,
      beforeBoardIndex: prev.boardIndex,
      afterBoardIndex: seg.boardIndex,
      beforeAtMm: prev.lengthMm,
      afterAtMm: 0,
      reason: item.reason
    })
  }

  /** 强制为整条新开一张常规板（整组挪板）。 */
  function forceOpenForStrip(item: StripItem, schemes: StripScheme[]): boolean {
    const probe = item.members[0].part
    for (const scheme of schemes) {
      const pw = scheme.axis === 'x' ? scheme.along : scheme.cross
      const ph = scheme.axis === 'x' ? scheme.cross : scheme.along
      const nb = boards
        .filter(
          (b) =>
            b.kind !== 'offcut' &&
            canOpen(b) &&
            boardMatches(b, probe) &&
            fitsClean(b.wMm - 2 * trim, pw) &&
            fitsClean(b.hMm - 2 * trim, ph)
        )
        .sort((a, b) => a.wMm * a.hMm - b.wMm * b.hMm)[0]
      if (!nb) continue
      const s = openSheet(nb)
      openedCount.set(nb.id, (openedCount.get(nb.id) ?? 0) + 1)
      const slot: BestSlot = {
        sheet: s,
        fr: s.free[0],
        nb: null,
        o: { pw, ph, rotated: false },
        tier: 0,
        waste: 0
      }
      const seg = placeStrip(item, scheme, slot)
      registerBreak(item.group, item, seg)
      return true
    }
    return false
  }

  /**
   * 拆段：找最长前缀放下，前缀成段、后段回队列。
   * - concession：前缀必须落在「已开板」的边角空档（真正填缝，不新增板）；
   * - forced：前缀可新开板（整段超过单板长度，被迫断）。
   */
  function splitAndPlace(
    item: StripItem,
    mode: 'concession' | 'forced'
  ): { tail: StripItem } | null {
    const group = item.group
    const axis = group.schemes[0].axis
    for (let cutAt = item.members.length - 1; cutAt >= 1; cutAt--) {
      const prefix = item.members.slice(0, cutAt)
      const schemes = stripSchemes(prefix.map((m) => m.part), kerf).filter((sc) => sc.axis === axis)
      if (schemes.length === 0) continue
      const head: StripItem = { group, members: prefix, segmentNo: item.segmentNo, reason: mode }
      let best: { slot: BestSlot; scheme: StripScheme } | null = null
      if (mode === 'concession') {
        for (const scheme of schemes) {
          const slot = findOpenStripSlot(head, scheme)
          if (slot && (!best || slot.waste < best.slot.waste)) best = { slot, scheme }
        }
      } else {
        for (const scheme of schemes) {
          const slot = findStripSlot(head, scheme)
          if (slot && (!best || slot.waste < best.slot.waste)) best = { slot, scheme }
        }
      }
      if (best) {
        const seg = placeStrip(head, best.scheme, best.slot)
        registerBreak(group, head, seg)
        group.nextSegmentNo = Math.max(group.nextSegmentNo, item.segmentNo + 1)
        return {
          tail: {
            group,
            members: item.members.slice(cutAt),
            segmentNo: item.segmentNo + 1,
            reason: mode
          }
        }
      }
    }
    return null
  }

  /** 处理一整个组：整段 → 让步（move/split 写明顺序）→ 兜底 forced 拆 → 标记未排下。 */
  function processGroup(group: BoundGroup): void {
    const queue: StripItem[] = [
      { group, members: group.members, segmentNo: group.nextSegmentNo, reason: 'concession' }
    ]
    while (queue.length > 0) {
      const item = queue.shift()!
      group.nextSegmentNo = Math.max(group.nextSegmentNo, item.segmentNo)
      if (item.members.length === 0) continue

      // 段方案（拆出的后段按本段成员重算尺寸，轴向锁死组的纹理方向）
      const itemSchemes =
        item.segmentNo === 1 ? item.group.schemes : schemesFor(item)

      // 1) 先在已开板上找（保长条、顺便填边角缝），不开新板
      if (tryPlaceOnOpenSheets(item, itemSchemes)) {
        const seg = placedSegmentsByGroup.get(group.def.id)!.find(
          (x) => x.segmentNo === item.segmentNo
        )!
        registerBreak(group, item, seg)
        continue
      }
      if (item.members.length === 1) {
        // 它已是拆段后的尾段：即便这一件单板也放不下，断口仍要落在它前面
        if (item.segmentNo > 1) {
          const prev = (placedSegmentsByGroup.get(group.def.id) ?? []).find(
            (x) => x.segmentNo === item.segmentNo - 1
          )
          if (prev)
            collectedBreaks.push({
              groupId: group.def.id,
              groupNo: group.no,
              groupName: group.def.name,
              afterSegmentNo: item.segmentNo,
              beforeInstanceId: prev.memberInstanceIds[prev.memberInstanceIds.length - 1],
              afterInstanceId: item.members[0].key,
              beforeCode: prev.memberCodes[prev.memberCodes.length - 1],
              afterCode: item.members[0].part.code,
              beforeBoardIndex: prev.boardIndex,
              afterBoardIndex: prev.boardIndex,
              beforeAtMm: prev.lengthMm,
              afterAtMm: 0,
              reason: 'forced'
            })
        }
        markUnplaced(item.members[0].part, `连纹组 G${group.no}`)
        continue
      }

      // 2) 已开板放不下 → 按写明的让步顺序处理（会产生段间断口）
      const concession: ('move' | 'split')[] =
        group.def.concession && group.def.concession.length > 0
          ? group.def.concession
          : ['move', 'split']
      // 写明的首选让步：split 在 move 之前 → 填边角缝是主动让步（concession）；
      // move 在 split 之前 → 先尝试整组挪板，挪不动才拆，拆属于被迫（forced）。
      const splitIsPreferred = concession[0] === 'split'
      let handled = false
      for (const step of concession) {
        if (step === 'move' && forceOpenForStrip(item, itemSchemes)) {
          handled = true
          break
        }
        if (step === 'split' && group.def.allowSplit) {
          const r = splitAndPlace(item, splitIsPreferred ? 'concession' : 'forced')
          if (r) {
            queue.unshift(r.tail)
            handled = true
            break
          }
        }
      }
      if (handled) continue

      // 3) 让步未放行：整段开新板能放下就整组挪（不断），否则被迫拆（forced）
      if (forceOpenForStrip(item, itemSchemes)) continue
      const r = splitAndPlace(item, 'forced')
      if (r) {
        queue.unshift(r.tail)
        continue
      }
      for (const m of item.members) markUnplaced(m.part, `连纹组 G${group.no}`)
    }
  }

  // 主调度：先按长/短取舍排组（保住长条 or 先填缝），零散件再按既有规矩填缝
  for (const group of rootGroups) processGroup(group)
  for (const inst of sortedLoose) placeSingle(inst)

  // 组装 SheetResult
  const results: SheetResult[] = sheets.map((s) => buildSheet(s, kerf, trim))

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
      (u.extra && u.extra.length > 0 ? `${u.extra.join('、')}；` : '') +
      (u.part.grain === 'none'
        ? '板材尺寸或库存不足，无法排下'
        : u.part.grain === 'length'
          ? '因纹理要求为竖纹（不可旋转），现有板材排不下'
          : '因纹理要求为横纹（不可旋转），现有板材排不下')
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

  const grainGroups = buildGrainGroupResults(collectedSegments, collectedBreaks)
  const partial: NestResult = {
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
    elapsedMs: Math.round(performance.now() - t0),
    generatedAt: Date.now(),
    grainPolicy,
    grainGroups,
    grainWarnings,
    grainDiff: null,
    grainVersion: ''
  }
  partial.grainVersion = grainSignature(partial)
  return partial
}

function buildSheet(s: SheetState, kerf: number, trim: number): SheetResult {
  const raw: DSeg[] = []
  for (const r of s.recs) {
    if (r.segA) raw.push(r.segA)
    if (r.segB) raw.push(r.segB)
    if (r.internal) raw.push(...r.internal)
  }
  const b = s.board
  const steps = buildSteps(b.wMm, b.hMm, kerf, trim, s.index, raw)
  const boardArea = b.wMm * b.hMm
  const usedArea = s.placements.reduce((a, p) => a + p.origLen * p.origWid, 0)

  // 剩余空档全部留档；两边 ≥300mm 才标记为可用余料，按面积降序
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

  // 本板连纹段（段号/板号同一份数据，供预览图与工单共用）
  const grainSegmentIds = [
    ...new Set(s.placements.map((p) => p.grainSegmentId).filter((x): x is string => !!x))
  ]

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
    grainSegmentIds
  }
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
