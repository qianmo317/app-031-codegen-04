// 全局状态：Vue reactive 单例 + localStorage 持久化（无 Pinia/Vuex）
import { reactive, computed } from 'vue'
import type {
  Board,
  GrainGroupDef,
  GroupOrderPolicy,
  Job,
  NestResult,
  Part,
  RegisteredOffcut,
  SheetResult
} from '../types'
import { nestJob } from './packing'
import { rebuildFromPlacements } from './cuts'
import { guillotineViolation } from './geometry'
import { diffGrainResults, grainGroupDesc, grainSignature } from './grain'
import { uid } from './format'
import boardsData from '../data/boards.json'

const JOBS_KEY = 'fco.jobs.v1'
const OFFCUTS_KEY = 'fco.offcuts.v1'

interface State {
  jobs: Job[]
  offcuts: RegisteredOffcut[]
  loaded: boolean
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as T
    if (Array.isArray(fallback) && !Array.isArray(parsed)) return fallback
    return parsed
  } catch {
    return fallback
  }
}

const state = reactive<State>({
  jobs: [],
  offcuts: [],
  loaded: false
})

function persist(): void {
  localStorage.setItem(JOBS_KEY, JSON.stringify(state.jobs))
  localStorage.setItem(OFFCUTS_KEY, JSON.stringify(state.offcuts))
}

function init(): void {
  if (state.loaded) return
  state.jobs = load<Job[]>(JOBS_KEY, [])
  state.offcuts = load<RegisteredOffcut[]>(OFFCUTS_KEY, [])
  state.loaded = true
}

export function defaultBoards(): Board[] {
  return boardsData.stockBoards.slice(0, 3).map((b) => ({
    id: uid('b'),
    name: b.name,
    wMm: b.wMm,
    hMm: b.hMm,
    thicknessMm: b.thicknessMm,
    material: b.material,
    priceCents: b.priceCents,
    quantity: 0,
    kind: 'stock'
  }))
}

export function allStockTemplates(): Omit<Board, 'id'>[] {
  return boardsData.stockBoards.map((b) => ({
    name: b.name,
    wMm: b.wMm,
    hMm: b.hMm,
    thicknessMm: b.thicknessMm,
    material: b.material,
    priceCents: b.priceCents,
    quantity: 0,
    kind: 'stock' as const
  }))
}

export function createJob(name: string): Job {
  init()
  const job: Job = {
    id: uid('job'),
    name: name.trim() || `开料项目 ${state.jobs.length + 1}`,
    createdAt: Date.now(),
    boards: defaultBoards(),
    parts: [],
    kerfMm: boardsData.defaults.kerfMm,
    trimMm: boardsData.defaults.trimMm,
    useOffcutIds: [],
    batchByCabinet: false,
    grainGroups: [],
    grainPolicy: 'long-first',
    grainIssued: null,
    grainVoid: null
  }
  state.jobs.unshift(job)
  persist()
  return job
}

export function deleteJob(id: string): void {
  const i = state.jobs.findIndex((j) => j.id === id)
  if (i >= 0) state.jobs.splice(i, 1)
  persist()
}

export function duplicateJob(id: string): Job | null {
  const src = getJob(id)
  if (!src) return null
  const job: Job = JSON.parse(JSON.stringify(src))
  job.id = uid('job')
  job.name = `${src.name} 副本`
  job.createdAt = Date.now()
  job.result = undefined
  state.jobs.unshift(job)
  persist()
  return job
}

export function saveJob(_job: Job): void {
  persist()
}

export function getJob(id: string): Job | undefined {
  init()
  return state.jobs.find((j) => j.id === id)
}

/** 把勾选的登记余料转成本单可用的小板（排在板材列表前，优先消耗）。 */
function boardsWithOffcuts(job: Job): Board[] {
  const offcutBoards: Board[] = state.offcuts
    .filter((o) => o.available && job.useOffcutIds.includes(o.id))
    .map((o) => ({
      id: `offcut_${o.id}`,
      name: `余料板 ${o.wMm}×${o.hMm}×${o.thicknessMm}（${o.material}）`,
      wMm: o.wMm,
      hMm: o.hMm,
      thicknessMm: o.thicknessMm,
      material: o.material,
      priceCents: 0,
      quantity: 1,
      kind: 'offcut' as const,
      offcutId: o.id
    }))
  return [...offcutBoards, ...job.boards]
}

export function runNest(job: Job): NestResult {
  const effective: Job = { ...job, boards: boardsWithOffcuts(job) }
  const prev = job.result
  const result = nestJob(effective)
  // 组内件数/顺序一改：逐条列出组号、断口、受影响板与单据行的变化
  result.grainDiff = diffGrainResults(prev, result)
  // 已发单据（本机存档）版本与本次签名不一致 → 上一次分组/领料单/拼版图作废重来
  if (job.grainIssued && job.grainIssued.version !== result.grainVersion) {
    job.grainVoid = {
      oldVersion: job.grainIssued.version,
      issuedAt: job.grainIssued.issuedAt,
      currentVersion: result.grainVersion,
      reason:
        '分组的件数或顺序已改动，旧排样对应的拼版图与已导出的领料单据全部作废，请按本版重新领料、重新打印'
    }
    job.grainIssued = null
  }
  // 标记被用掉的余料
  const usedOffcutBoardIds = new Set(
    result.sheets.filter((s) => s.boardId.startsWith('offcut_')).map((s) => s.boardId)
  )
  for (const oc of state.offcuts) {
    if (usedOffcutBoardIds.has(`offcut_${oc.id}`)) {
      oc.available = false
      oc.usedByJobId = job.id
    }
  }
  job.result = result
  persist()
  return result
}

// —— 成组连纹：组定义 CRUD、长/短组取舍、单据版本（作废判定） ——

export function grainGroupsOf(job: Job): GrainGroupDef[] {
  return job.grainGroups ?? []
}

export function addGrainGroup(job: Job, memberPartIds: string[] = []): GrainGroupDef {
  if (!job.grainGroups) job.grainGroups = []
  const no = job.grainGroups.length + 1
  const g: GrainGroupDef = {
    id: uid('gg'),
    name: `连纹组 G${no}`,
    memberPartIds,
    allowSplit: true,
    concession: ['move', 'split']
  }
  job.grainGroups.push(g)
  persist()
  return g
}

export function updateGrainGroup(job: Job, id: string, patch: Partial<GrainGroupDef>): void {
  const g = job.grainGroups?.find((x) => x.id === id)
  if (g) {
    Object.assign(g, patch)
    persist()
  }
}

export function removeGrainGroup(job: Job, id: string): void {
  if (job.grainGroups) {
    job.grainGroups = job.grainGroups.filter((g) => g.id !== id)
    persist()
  }
}

/** 同一组内成员上移/下移（改顺序即改连纹首尾相接次序，要整张板重排）。 */
export function moveGrainMember(job: Job, groupId: string, partId: string, delta: -1 | 1): void {
  const g = job.grainGroups?.find((x) => x.id === groupId)
  if (!g) return
  const i = g.memberPartIds.indexOf(partId)
  const j = i + delta
  if (i < 0 || j < 0 || j >= g.memberPartIds.length) return
  const arr = g.memberPartIds
  arr.splice(i, 1, arr[j])
  arr.splice(j, 1, partId)
  persist()
}

export function setGrainPolicy(job: Job, policy: GroupOrderPolicy): void {
  job.grainPolicy = policy
  persist()
}

/** 导出领料单时记录版本（本机存档）；之后分组改动会让该版本作废。 */
export function markGrainIssued(job: Job): void {
  if (!job.result) return
  job.grainIssued = {
    version: job.result.grainVersion,
    issuedAt: Date.now(),
    boardsUsed: job.result.boardsUsed,
    groupDesc: grainGroupDesc(job.result)
  }
  job.grainVoid = null
  persist()
}

export function clearGrainVoid(job: Job): void {
  job.grainVoid = null
  persist()
}

/** 直接用已有结果回算签名（外部导入时用）。 */
export function currentGrainSignature(job: Job): string {
  return job.result ? grainSignature(job.result) : ''
}

/**
 * 微调后连纹完整性校验：同一连纹段（同组同段）的门板必须仍在同一张板、
 * 朝向一致（同 y 或同 x）、沿纹理按 ordinal 首尾相接（净距 = kerf）。
 * 不满足则拒绝微调，避免手工拖动把长条连纹拆散。
 */
function grainContinuityViolation(
  placements: SheetResult['placements'],
  kerf: number
): string | null {
  const bySeg = new Map<string, SheetResult['placements']>()
  for (const p of placements) {
    if (!p.grainSegmentId) continue
    const arr = bySeg.get(p.grainSegmentId) ?? []
    arr.push(p)
    bySeg.set(p.grainSegmentId, arr)
  }
  for (const [, ps] of bySeg) {
    if (ps.length < 2) continue
    const ord = [...ps].sort((a, b) => (a.grainOrdinal ?? 0) - (b.grainOrdinal ?? 0))
    const boardSet = new Set(ord.map((p) => p.boardIndex))
    if (boardSet.size > 1) return `连纹段 G${ord[0].grainGroupNo}-${ord[0].grainSegmentNo} 被挪到不同板，连纹会断`
    // 判定沿 x 还是沿 y：首两件投影
    const alongX = Math.abs(ord[1].y - ord[0].y) < 0.1
    const sameLine = ord.every((p) =>
      alongX ? Math.abs(p.y - ord[0].y) < 0.1 : Math.abs(p.x - ord[0].x) < 0.1
    )
    if (!sameLine) return `连纹段 G${ord[0].grainGroupNo}-${ord[0].grainSegmentNo} 门板被错开，纹理方向不再一致`
    for (let i = 1; i < ord.length; i++) {
      const a = ord[i - 1]
      const b = ord[i]
      const gap = alongX ? b.x - (a.x + a.lenMm) : b.y - (a.y + a.widMm)
      if (Math.abs(gap - kerf) > 0.6)
        return `连纹段 G${b.grainGroupNo}-${b.grainSegmentNo} 第 ${b.grainOrdinal} 扇与前扇脱离（缝 ${gap.toFixed(1)}mm），纹理接不上`
      if (alongX && Math.abs(b.widMm - a.widMm) > 0.1)
        return `连纹段 G${b.grainGroupNo}-${b.grainSegmentNo} 门板高度不一致，纹理无法对齐`
      if (!alongX && Math.abs(b.lenMm - a.lenMm) > 0.1)
        return `连纹段 G${b.grainGroupNo}-${b.grainSegmentNo} 门板宽度不一致，纹理无法对齐`
    }
  }
  return null
}

/** 手工微调：移动/交换后重新校验 guillotine 并重算刀路；非法返回错误信息。 */
export function applyAdjustment(
  job: Job,
  sheetIndex: number,
  placements: SheetResult['placements']
): string | null {
  if (!job.result) return '尚未排样'
  const sheet = job.result.sheets[sheetIndex]
  const bounds = {
    x: job.trimMm,
    y: job.trimMm,
    w: sheet.wMm - 2 * job.trimMm,
    h: sheet.hMm - 2 * job.trimMm
  }
  const violation = guillotineViolation(
    placements.map((p) => ({ id: p.instanceId, x: p.x, y: p.y, w: p.lenMm, h: p.widMm })),
    bounds,
    job.kerfMm
  )
  if (violation) return violation
  // 连纹完整性：微调后同一连纹段仍须同板、同朝向、沿纹理首尾相接
  const grainErr = grainContinuityViolation(placements, job.kerfMm)
  if (grainErr) return grainErr
  const rebuilt = rebuildFromPlacements(
    sheet.wMm,
    sheet.hMm,
    job.kerfMm,
    job.trimMm,
    sheetIndex,
    placements
  )
  if (!rebuilt) return '调整后无法生成可执行的贯通裁切刀路'
  const offcuts = rebuilt.leftovers
    .filter((r) => r.w >= 300 - 0.05 && r.h >= 300 - 0.05)
    .map((r) => ({
      x: Math.round(r.x),
      y: Math.round(r.y),
      wMm: Math.round(r.w),
      hMm: Math.round(r.h),
      areaMm2: Math.round(r.w * r.h),
      usable: true
    }))
    .sort((a, b) => b.areaMm2 - a.areaMm2)
  sheet.placements = placements.map((p) => ({ ...p, adjusted: true }))
  sheet.steps = rebuilt.steps
  sheet.offcuts = offcuts
  sheet.adjusted = true
  sheet.usedAreaMm2 = sheet.placements.reduce((a, p) => a + p.origLen * p.origWid, 0)
  sheet.utilization = sheet.usedAreaMm2 / sheet.boardAreaMm2
  persist()
  return null
}

export function registerOffcuts(
  job: Job,
  picks: { sheetIndex: number; x: number; y: number; wMm: number; hMm: number }[]
): number {
  if (!job.result) return 0
  let n = 0
  for (const pick of picks) {
    const sheet = job.result.sheets[pick.sheetIndex]
    state.offcuts.push({
      id: uid('oc'),
      jobId: job.id,
      jobName: job.name,
      sheetIndex: pick.sheetIndex,
      wMm: pick.wMm,
      hMm: pick.hMm,
      thicknessMm: sheet.thicknessMm,
      material: sheet.material,
      createdAt: Date.now(),
      available: true
    })
    n++
  }
  persist()
  return n
}

export function addManualOffcut(input: {
  wMm: number
  hMm: number
  thicknessMm: number
  material: string
}): void {
  state.offcuts.push({
    id: uid('oc'),
    jobId: '',
    jobName: '手工登记',
    sheetIndex: -1,
    wMm: input.wMm,
    hMm: input.hMm,
    thicknessMm: input.thicknessMm,
    material: input.material,
    createdAt: Date.now(),
    available: true
  })
  persist()
}

export function removeOffcut(id: string): void {
  const i = state.offcuts.findIndex((o) => o.id === id)
  if (i >= 0) state.offcuts.splice(i, 1)
  persist()
}

export function toggleOffcut(id: string): void {
  const o = state.offcuts.find((x) => x.id === id)
  if (o) {
    o.available = !o.available
    if (o.available) o.usedByJobId = undefined
    persist()
  }
}

/** 示例：一套橱柜 + 衣柜混合 BOM（含竖纹门板、见光侧板、背板 9mm） */
export function createSampleJob(): Job {
  const job = createJob('示例：三室全屋柜体（18mm 柜体 + 9mm 背板）')
  const b18 = job.boards[0] // 颗粒板 18mm
  const bBack = boardsData.stockBoards[6]
  const back: Board = {
    id: uid('b'),
    name: bBack.name,
    wMm: bBack.wMm,
    hMm: bBack.hMm,
    thicknessMm: bBack.thicknessMm,
    material: bBack.material,
    priceCents: bBack.priceCents,
    quantity: 0,
    kind: 'stock'
  }
  job.boards.push(back)
  const P = (
    code: string,
    name: string,
    l: number,
    w: number,
    qty: number,
    grain: Part['grain'],
    edges: Part['edgeBands'],
    cabinet: string,
    exposed: boolean,
    boardId?: string
  ): Part => ({
    id: uid('p'),
    code,
    name,
    lenMm: l,
    widMm: w,
    qty,
    grain,
    edgeBands: edges,
    cabinet,
    exposed,
    boardId: boardId ?? b18.id
  })
  const all4: Part['edgeBands'] = ['top', 'bottom', 'left', 'right']
  const lb: Part['edgeBands'] = ['left', 'right']
  const tb: Part['edgeBands'] = ['top', 'bottom']
  job.parts = [
    // 地柜（600 宽标准柜 ×2 + 800 宽水槽柜）
    P('DC-S', '地柜侧板', 700, 560, 4, 'length', lb, '地柜', false),
    P('DC-D', '地柜底板', 564, 560, 2, 'none', tb, '地柜', false),
    P('DC-T', '地柜顶板/拉带', 564, 100, 2, 'none', [], '地柜', false),
    P('DC-M', '地柜门(竖纹见光)', 700, 296, 2, 'length', all4, '地柜', true),
    P('SC-S', '水槽柜侧板', 700, 560, 2, 'length', lb, '水槽柜', false),
    P('SC-D', '水槽柜底板', 764, 560, 1, 'none', tb, '水槽柜', false),
    P('SC-M', '水槽柜门(竖纹见光)', 700, 396, 2, 'length', all4, '水槽柜', true),
    // 吊柜
    P('GC-S', '吊柜侧板', 700, 320, 4, 'length', lb, '吊柜', false),
    P('GC-P', '吊柜层板', 764, 320, 2, 'none', tb, '吊柜', false),
    P('GC-M', '吊柜门板(竖纹见光)', 700, 396, 2, 'length', all4, '吊柜', true),
    // 衣柜
    P('WR-S', '衣柜见光侧板', 2200, 580, 2, 'length', all4, '衣柜', true),
    P('WR-IS', '衣柜中侧板', 2180, 560, 1, 'length', lb, '衣柜', false),
    P('WR-P', '衣柜层板', 564, 560, 5, 'none', tb, '衣柜', false),
    P('WR-T', '衣柜顶板', 1800, 560, 1, 'none', tb, '衣柜', false),
    P('WR-B', '衣柜底板', 1800, 560, 1, 'none', tb, '衣柜', false),
    P('WR-M', '衣柜门板(竖纹见光)', 2180, 446, 4, 'length', all4, '衣柜', true),
    // 9mm 背板（指定板材）
    P('BB-D', '地柜/水槽柜背板', 690, 564, 3, 'none', [], '地柜', false, back.id),
    P('BB-G', '吊柜背板', 690, 764, 1, 'none', [], '吊柜', false, back.id),
    P('BB-W', '衣柜背板(竖纹)', 2180, 900, 2, 'length', [], '衣柜', false, back.id)
  ]
  // 示例连纹组：同一面衣柜并排 4 扇门板纹理首尾相接（让步顺序：先整组挪板，再拆段）
  const wardrobeDoors = job.parts.filter((p) => p.code === 'WR-M')
  if (wardrobeDoors.length > 0) {
    job.grainGroups = [
      {
        id: uid('gg'),
        name: '衣柜门板连纹 G1（4 扇并排）',
        memberPartIds: wardrobeDoors.map((p) => p.id),
        allowSplit: true,
        concession: ['move', 'split']
      }
    ]
  }
  return job
}

export function newPart(partial: Partial<Part> = {}): Part {
  return {
    id: uid('p'),
    code: partial.code ?? '',
    name: partial.name ?? '',
    lenMm: partial.lenMm ?? 0,
    widMm: partial.widMm ?? 0,
    qty: partial.qty ?? 1,
    grain: partial.grain ?? 'none',
    edgeBands: partial.edgeBands ?? [],
    cabinet: partial.cabinet ?? '未分组',
    exposed: partial.exposed ?? false,
    boardId: partial.boardId ?? ''
  }
}

export function exportJobJson(job: Job): string {
  return JSON.stringify(job, null, 2)
}

export function importJobJson(json: string): Job | null {
  try {
    const obj = JSON.parse(json) as Job
    if (!obj.parts || !obj.boards) return null
    obj.id = uid('job')
    obj.createdAt = Date.now()
    obj.result = undefined
    state.jobs.unshift(obj)
    persist()
    return obj
  } catch {
    return null
  }
}

export function useStore() {
  init()
  return {
    state,
    jobs: computed(() => state.jobs),
    offcuts: computed(() => state.offcuts)
  }
}

export { boardsData }
