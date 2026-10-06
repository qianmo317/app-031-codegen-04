// 全局状态：Vue reactive 单例 + localStorage 持久化（无 Pinia/Vuex）
import { reactive, computed } from 'vue'
import type {
  Board,
  GrainChange,
  GrainGroup,
  Job,
  NestResult,
  NestRevisionArchive,
  Part,
  Placement,
  RegisteredOffcut,
  SheetResult
} from '../types'
import { grainInputSignature, nestJob } from './packing'
import { rebuildFromPlacements } from './cuts'
import { guillotineViolation } from './geometry'
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
    grainPriority: 'longFirst',
    grainRevisions: []
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
  const job = state.jobs.find((j) => j.id === id)
  if (job) normalizeJob(job)
  return job
}

function normalizeJob(job: Job): void {
  if (!Array.isArray(job.grainGroups)) job.grainGroups = []
  if (job.grainPriority !== 'shortFirst' && job.grainPriority !== 'longFirst') job.grainPriority = 'longFirst'
  if (!Array.isArray(job.grainRevisions)) job.grainRevisions = []
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

function archiveOf(result: NestResult, sig: string, version: number): NestRevisionArchive {
  return {
    version,
    inputSignature: sig,
    status: 'active',
    issued: false,
    sheets: result.sheets.map((s) => ({
      boardNo: s.index + 1,
      boardName: s.boardName,
      groupCodes: [...new Set(s.placements.map((p) => p.grainGroupCode).filter((x): x is string => !!x))].sort()
    }))
  }
}

function grainPlacementText(p: Placement): string {
  return `${p.grainSegmentCode ?? p.grainGroupCode ?? '零散'} / 第${p.boardIndex + 1}张 / 序${p.grainOrder ?? '-'}`
}

function describeGroupChange(
  code: string,
  kind: GrainChange['type'],
  detail: string,
  oldList: Placement[],
  newList: Placement[]
): GrainChange {
  const instanceIds = [...new Set([...oldList, ...newList].map((p) => p.instanceId))]
  const oldMap = new Map(oldList.map((p) => [p.instanceId, p]))
  const newMap = new Map(newList.map((p) => [p.instanceId, p]))
  const items = instanceIds.map((id) => {
    const op = oldMap.get(id)
    const np = newMap.get(id)
    return {
      instanceId: id,
      code: np?.code ?? op?.code ?? id,
      order: np?.grainOrder ?? op?.grainOrder ?? null,
      before: op ? grainPlacementText(op) : '未绑定/未排',
      after: np ? grainPlacementText(np) : '已解绑/未排'
    }
  })
  const boards = [...new Set([...oldList, ...newList].map((p) => p.boardIndex + 1))].sort((a, b) => a - b)
  const oldCodes = [...new Set(oldList.map((p) => p.grainSegmentCode ?? p.grainGroupCode ?? '无'))].join('/')
  const newCodes = [...new Set(newList.map((p) => p.grainSegmentCode ?? p.grainGroupCode ?? '无'))].join('/')
  return {
    type: kind,
    groupCode: code,
    detail,
    instanceIds,
    items,
    affectedBoardNos: boards,
    previewRows: items.map((it) => `${code}#${it.order ?? '-'} ${it.code}：${it.before} → ${it.after}`),
    cutRows: boards.map((n) => `第 ${n} 张板裁切步骤：带 ${code} 标记的刀序按新版重排`),
    orderRows: [`下料单/领料单：${code} 的板号、连纹长度与断口行更新（${oldCodes} → ${newCodes}）`]
  }
}

function diffGrainResults(old: NestResult | undefined, next: NestResult): GrainChange[] {
  if (!old) return []
  const oldGroups = new Map(old.grain.groups.map((g) => [g.id, g]))
  const nextGroups = new Map(next.grain.groups.map((g) => [g.id, g]))
  const oldPls = old.sheets.flatMap((s) => s.placements)
  const nextPls = next.sheets.flatMap((s) => s.placements)
  const oldByGroup = new Map<string, Placement[]>()
  const nextByGroup = new Map<string, Placement[]>()
  for (const p of oldPls) if (p.grainGroupId) oldByGroup.set(p.grainGroupId, [...(oldByGroup.get(p.grainGroupId) ?? []), p])
  for (const p of nextPls) if (p.grainGroupId) nextByGroup.set(p.grainGroupId, [...(nextByGroup.get(p.grainGroupId) ?? []), p])

  const out: GrainChange[] = []
  for (const ng of next.grain.groups) {
    const og = oldGroups.get(ng.id)
    const op = oldByGroup.get(ng.id) ?? []
    const np = nextByGroup.get(ng.id) ?? []
    const oldIds = op.map((p) => p.instanceId).sort()
    const newIds = np.map((p) => p.instanceId).sort()
    const oldOrders = op.sort((a, b) => (a.grainOrder ?? 0) - (b.grainOrder ?? 0)).map((p) => `${p.code}#${p.grainOrder}`).join(',')
    const newOrders = np.sort((a, b) => (a.grainOrder ?? 0) - (b.grainOrder ?? 0)).map((p) => `${p.code}#${p.grainOrder}`).join(',')
    if (!og || JSON.stringify(oldIds) !== JSON.stringify(newIds) || oldOrders !== newOrders) {
      out.push(
        describeGroupChange(
          ng.code,
          'groupChanged',
          !og ? '新增连纹组' : '组内件数或顺序改变，受影响板已整张重排',
          op,
          np
        )
      )
    } else if (JSON.stringify(og.breaks) !== JSON.stringify(ng.breaks)) {
      out.push(describeGroupChange(ng.code, 'breakMoved', '断口位置改变', op, np))
    } else {
      const oldMeta = {
        segmentCodes: [...new Set(op.map((p) => p.grainSegmentCode ?? p.grainGroupCode ?? ng.code))],
        boardNos: [...new Set(op.map((p) => p.boardIndex + 1))]
      }
      const newMeta = {
        segmentCodes: [...new Set(np.map((p) => p.grainSegmentCode ?? p.grainGroupCode ?? ng.code))],
        boardNos: [...new Set(np.map((p) => p.boardIndex + 1))]
      }
      if (JSON.stringify(oldMeta.boardNos) !== JSON.stringify(newMeta.boardNos) || JSON.stringify(oldMeta.segmentCodes) !== JSON.stringify(newMeta.segmentCodes)) {
        out.push(describeGroupChange(ng.code, 'sheetChanged', '组号未变但所在板号/预览行改变', op, np))
      }
    }
  }
  for (const og of old.grain.groups) {
    if (!nextGroups.has(og.id)) {
      const op = oldByGroup.get(og.id) ?? []
      out.push(
        describeGroupChange(
          og.code,
          'groupChanged',
          '连纹组已删除或成员全部解绑',
          op,
          []
        )
      )
    }
  }
  return out
}

export function runNest(job: Job): NestResult {
  normalizeJob(job)
  const effective: Job = { ...job, boards: boardsWithOffcuts(job) }
  const oldResult = job.result
  const oldSig = oldResult?.grain.inputSignature
  const nextSig = grainInputSignature(effective)
  const result = nestJob(effective)
  const sameInput = oldSig === nextSig
  if (!sameInput && oldResult) result.grain.changes = diffGrainResults(oldResult, result)

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

  if (sameInput && oldResult) {
    result.grain.version = oldResult.grain.version
    result.grain.issuedRevisions = oldResult.grain.issuedRevisions
    result.grain.supersededRevision = oldResult.grain.supersededRevision
  } else {
    const nextVersion = (oldResult?.grain.version ?? 0) + 1
    result.grain.version = nextVersion
    if (oldResult) {
      const oldVersion = oldResult.grain.version
      result.grain.supersededRevision = oldVersion
      result.grain.issuedRevisions = oldResult.grain.issuedRevisions
      const issued = oldResult.grain.issuedRevisions.includes(oldVersion)
      const oldArchive = job.grainRevisions.find((r) => r.version === oldVersion)
      if (oldArchive) {
        oldArchive.status = issued ? 'voided' : 'superseded'
        if (issued) {
          oldArchive.voidedAt = Date.now()
          oldArchive.voidReason = '组内件数/顺序或长组优先策略已改变；旧拼版图与已发领料单作废'
        }
      }
    }
    job.grainRevisions.push(archiveOf(result, nextSig, nextVersion))
  }

  job.result = result
  persist()
  return result
}

export function markCurrentOrderIssued(job: Job): boolean {
  if (!job.result) return false
  normalizeJob(job)
  const version = job.result.grain.version
  if (!job.result.grain.issuedRevisions.includes(version)) job.result.grain.issuedRevisions.push(version)
  const archive = job.grainRevisions.find((r) => r.version === version)
  if (archive) {
    archive.issued = true
    archive.issuedAt = Date.now()
    archive.status = 'active'
    archive.resultSnapshot = JSON.parse(JSON.stringify(job.result)) as NestResult
  }
  persist()
  return true
}

/** 手工微调：移动/交换后重新校验 guillotine 并重算刀路；非法返回错误信息。 */
export function applyAdjustment(
  job: Job,
  sheetIndex: number,
  placements: SheetResult['placements']
): string | null {
  if (!job.result) return '尚未排样'
  const sheet = job.result.sheets[sheetIndex]
  const groupedLocked = sheet.placements.some((p) => p.grainGroupId)
  if (groupedLocked) {
    const before = new Map(
      sheet.placements
        .filter((p) => p.grainGroupId)
        .map((p) => [p.instanceId, [p.x, p.y, p.lenMm, p.widMm, p.grainOrder].join('|')])
    )
    const changedGroup = placements.find((p) => {
      if (!p.grainGroupId) return false
      return before.get(p.instanceId) !== [p.x, p.y, p.lenMm, p.widMm, p.grainOrder].join('|')
    })
    if (changedGroup) {
      return `连纹组 ${changedGroup.grainSegmentCode ?? changedGroup.grainGroupCode} 不能手工拖散；请修改组内件数/顺序后整张重排`
    }
  }
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
  const doorGroup = (name: string, part: Part | undefined): GrainGroup | null =>
    part
      ? {
          id: uid('grp'),
          name,
          members: [{ partId: part.id, qty: part.qty }],
          splitPolicy: 'split',
          splitAfter: Math.max(1, Math.floor(part.qty / 2))
        }
      : null
  job.grainGroups = [
    doorGroup('衣柜同排门板连纹', job.parts.find((p) => p.code === 'WR-M')),
    doorGroup('水槽柜同排门板连纹', job.parts.find((p) => p.code === 'SC-M'))
  ].filter((g): g is GrainGroup => !!g)
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
    normalizeJob(obj)
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
