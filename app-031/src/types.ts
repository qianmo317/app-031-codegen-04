// 数据模型（对应规格书 §7，进阶功能所需字段为可选扩展）

export type GrainDemand = 'length' | 'width' | 'none' // 竖纹 / 横纹 / 无要求
export type EdgeSide = 'top' | 'bottom' | 'left' | 'right'

export interface Board {
  id: string
  name: string
  wMm: number
  hMm: number
  thicknessMm: number
  material: string
  priceCents: number
  quantity: number // 库存张数，0 = 不限
  kind?: 'stock' | 'offcut' // stock 常规板材 / offcut 登记余料转来的小板
  offcutId?: string
}

export interface Part {
  id: string
  code: string
  name: string
  lenMm: number
  widMm: number
  qty: number
  grain: GrainDemand
  edgeBands: EdgeSide[]
  cabinet: string // 所在柜体/房间，便于分拣
  exposed: boolean // 是否见光
  boardId?: string // 指定板材类型，空 = 自动
}

export interface Placement {
  partId: string
  instanceId: string
  boardIndex: number
  x: number
  y: number
  lenMm: number // 实际占 x 方向的尺寸（纹理=横纹时为零件 wid，rotated 仍为 false）
  widMm: number // 实际占 y 方向的尺寸
  origLen: number // 清单录入尺寸（标签用）
  origWid: number
  rotated: boolean
  seq: number
  grainGroupId?: string
  grainGroupCode?: string
  grainSegmentCode?: string
  grainOrder?: number
  // 冗余展示字段
  code: string
  name: string
  cabinet: string
  exposed: boolean
  grain: GrainDemand
  edgeBands: EdgeSide[]
  adjusted?: boolean // 手工微调产生
}

export interface CutStep {
  boardIndex: number
  axis: 'v' | 'h'
  at: number // 切割线坐标（mm，板左下角原点）
  span: [number, number] // 贯通区间起止
  order: number
  kind: 'trim' | 'cut'
  label: string
  grainSegmentCodes?: string[]
}

export interface OffcutInfo {
  x: number
  y: number
  wMm: number
  hMm: number
  areaMm2: number
  usable: boolean // 两边 ≥300mm 才登记为可用余料，其余仅作碎料留档
}

export interface GrainGroupMember {
  partId: string
  qty: number // 该零件有几件绑入本组；未用完的数量仍为零散件
}

export interface GrainGroup {
  id: string
  name: string
  members: GrainGroupMember[]
  splitPolicy: 'move' | 'split' // 当前板/新板放不下时：整组挪板，或按 splitAfter 让步拆段
  splitAfter?: number // 在第 N 件后断开；1..件数-1，空/非法时默认约半数
}

export type GrainGroupPriority = 'longFirst' | 'shortFirst'

export interface GrainBreak {
  groupId: string
  groupCode: string
  afterOrder: number // 从第 1 件数起，断在此件之后
  beforeInstanceId: string
  beforeCode: string
  afterCode: string
  boardIndex: number // 后半段所在板；前半段在 boardIndex-1
  boardNo: number
  axis: 'x' | 'y' // 拼接轴向（横拼/竖拼）
  atMm: number // 断口坐标（mm，整数展示）
  reason: 'fallback' | 'boardCapacity'
}

export interface GrainSegmentInfo {
  code: string // 未拆 G01；拆开 G01-A / G01-B
  groupId: string
  boardIndex: number
  boardNo: number
  startOrder: number
  endOrder: number
  instanceIds: string[]
  partCodes: string[]
  chainLengthMm: number // 净连纹长度（不含锯路，mm，向下游统一取整）
  areaMm2: number // 组内净面积（不含锯路，mm²，整数）
  axis: 'x' | 'y'
  split: boolean
}

export interface GrainGroupResult {
  id: string
  code: string
  name: string
  memberCount: number
  netChainLengthMm: number // 未被拆开的完整连纹长度；已拆时为最长一段
  totalAreaMm2: number
  status: 'complete' | 'split' | 'unplaced' | 'invalid'
  segments: GrainSegmentInfo[]
  breaks: GrainBreak[]
  connectedOrders: number[][] // 每一小段的组内顺序；如 [[1,2],[3,4]]
  note: string
}

export interface GrainChange {
  type: 'groupChanged' | 'breakMoved' | 'sheetChanged' | 'cutChanged' | 'orderChanged'
  groupCode: string
  detail: string
  instanceIds: string[]
  items: {
    instanceId: string
    code: string
    order: number | null
    before: string
    after: string
  }[]
  affectedBoardNos: number[]
  previewRows: string[]
  cutRows: string[]
  orderRows: string[]
}

export interface GrainNestSummary {
  version: number
  strategy: GrainGroupPriority
  tradeoff: string
  unit: {
    length: 'mm'
    lengthRounding: '整数（四舍五入）'
    area: 'mm²'
    areaRounding: '整数（四舍五入）'
  }
  groups: GrainGroupResult[]
  changes: GrainChange[]
  supersededRevision?: number
  issuedRevisions: number[]
  inputSignature: string
}

export interface NestRevisionArchive {
  version: number
  inputSignature: string
  status: 'active' | 'superseded' | 'voided'
  issued: boolean
  issuedAt?: number
  voidedAt?: number
  voidReason?: string
  sheets: { boardNo: number; boardName: string; groupCodes: string[] }[]
  resultSnapshot?: NestResult
}

export interface SheetResult {
  index: number
  boardId: string
  boardName: string
  material: string
  thicknessMm: number
  wMm: number
  hMm: number
  priceCents: number
  placements: Placement[]
  steps: CutStep[]
  usedAreaMm2: number
  boardAreaMm2: number
  utilization: number
  offcuts: OffcutInfo[]
  grainSegments: GrainSegmentInfo[]
  adjusted?: boolean
}

export interface UnplacedInfo {
  partId: string
  code: string
  name: string
  qty: number
  reason: string
}

export interface NestResult {
  sheets: SheetResult[]
  boardsUsed: number
  boardsByType: Record<string, number>
  edgeBandM: { exposed: number; normal: number }
  unplaced: UnplacedInfo[]
  baselineBoards: number // 随手排（朴素顺板）需要的张数
  savedBoards: number
  savedCents: number
  totalCostCents: number
  stockShortage: { boardId: string; boardName: string; need: number; have: number }[]
  grain: GrainNestSummary
  elapsedMs: number
  generatedAt: number
}

export interface Job {
  id: string
  name: string
  createdAt: number
  boards: Board[]
  parts: Part[]
  kerfMm: number
  trimMm: number
  useOffcutIds: string[] // 参与本单排样的登记余料
  batchByCabinet: boolean // 按柜体批次分组开料
  grainGroups: GrainGroup[]
  grainPriority: GrainGroupPriority
  grainRevisions: NestRevisionArchive[]
  result?: NestResult
}

export interface RegisteredOffcut {
  id: string
  jobId: string
  jobName: string
  sheetIndex: number
  wMm: number
  hMm: number
  thicknessMm: number
  material: string
  createdAt: number
  available: boolean
  usedByJobId?: string
}
