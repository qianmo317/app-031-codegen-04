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
  // 冗余展示字段
  code: string
  name: string
  cabinet: string
  exposed: boolean
  grain: GrainDemand
  edgeBands: EdgeSide[]
  adjusted?: boolean // 手工微调产生
  // 成组连纹
  grainGroupId?: string // 所属连纹组（无 = 零散件）
  grainGroupNo?: number // 组号 G1/G2…（三处出口同一份编号）
  grainSegmentId?: string // 所属连纹段（拆段后每段各自纹理连续）
  grainSegmentNo?: number // 组内段号（1 起）
  grainOrdinal?: number // 在组内沿纹理首尾相接的顺序（1 起）
}

export interface CutStep {
  boardIndex: number
  axis: 'v' | 'h'
  at: number // 切割线坐标（mm，板左下角原点）
  span: [number, number] // 贯通区间起止
  order: number
  kind: 'trim' | 'cut'
  label: string
  // 成组连纹：把连纹长条按件分块的横断刀/剔除上方余隙的刀
  grainCross?: boolean
  grainGroupId?: string
  grainGroupNo?: number
  grainSegmentId?: string
}

export interface OffcutInfo {
  x: number
  y: number
  wMm: number
  hMm: number
  areaMm2: number
  usable: boolean // 两边 ≥300mm 才登记为可用余料，其余仅作碎料留档
}

// 成组连纹定义（录入侧）：同组件沿纹理首尾相接排成整条、同一张板、同一朝向
export interface GrainGroupDef {
  id: string
  name: string
  memberPartIds: string[] // 沿纹理首尾相接的顺序；qty 在排样时展开（第 n 件各出现 n 次）
  allowSplit: boolean // 排不下时是否允许拆段（false = 只允许整组挪下一张板）
  concession: ('move' | 'split')[] // 让步顺序：move 整组挪板 / split 拆成两段各自连续
}

// 一条连纹段（排样结果侧）：组内若干件在同一张板上首尾相接、纹理连续
export interface GrainSegmentReport {
  id: string
  groupId: string
  groupNo: number // G1/G2…
  groupName: string
  segmentNo: number // 组内段号，1 起
  boardIndex: number // 板号（0 起）；预览图/工单/单据共用此板号
  boardName: string
  axis: 'x' | 'y' // 纹理在板上的方向（统一横板后 x = 沿板长）
  lengthMm: number // 连纹长度（含件间断口锯路），mm 取整
  areaMm2: number // 该段零件净面积，平方毫米取整（不含锯路/余隙）
  memberInstanceIds: string[] // 段内件，沿纹理顺序
  memberCodes: string[]
}

// 断口：拆段/跨板后，纹理在这里接不上
export interface GrainBreakReport {
  groupId: string
  groupNo: number
  groupName: string
  afterSegmentNo: number // 断在第几段之后（前一段最后一件 与 下一段第一件 之间）
  beforeInstanceId: string
  afterInstanceId: string
  beforeCode: string
  afterCode: string
  beforeBoardIndex: number
  afterBoardIndex: number
  beforeAtMm: number // 前段在此坐标处结束（mm 取整）
  afterAtMm: number // 后段从此坐标处开始（mm 取整）
  reason: 'concession' | 'forced' // 写明的让步顺序拆段 / 单板放不下被迫断
}

// 每组的连纹汇总
export interface GrainGroupResult {
  id: string
  no: number // 组号 G1/G2…（三处出口同一份）
  name: string
  memberCount: number // 组内总件数（qty 展开）
  segmentCount: number
  segments: GrainSegmentReport[] // 沿纹理顺序
  breaks: GrainBreakReport[]
  // 每段连纹长度（mm 取整），按顺序
  segmentLengthsMm: number[]
}

// 重排前后的分组变化（组内件数/顺序一改即整张板重排，逐条列出变化）
export interface GrainChangeEntry {
  instanceId: string
  code: string
  fromGroupNo: number | null // null = 原先是零散件
  toGroupNo: number | null // null = 这次变成零散件
  fromSegmentNo: number | null
  toSegmentNo: number | null
  fromBoardIndex: number | null
  toBoardIndex: number | null
}

export interface GrainBreakChange {
  groupNo: number
  kind: 'added' | 'removed' | 'moved'
  beforeBoard?: number // 1 起展示板号
  afterBoard?: number
  beforeCodes?: string
  afterCodes?: string
}

export interface GrainNestDiff {
  instanceChanges: GrainChangeEntry[]
  breakChanges: GrainBreakChange[]
  affectedBoards: number[] // 受影响需要整张重排/重出单据的板号（0 起）
  changedSheetRows: { boardIndex: number; codes: string[] }[] // 预览图变动的行
  changedDocRows: string[] // 工单/单据上跟着变的行（组号-板号-断口口径）
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
  adjusted?: boolean
  grainSegmentIds: string[] // 本张板上的连纹段（预览图/工单共用）
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
  elapsedMs: number
  generatedAt: number
  // 成组连纹
  grainPolicy: GroupOrderPolicy
  grainGroups: GrainGroupResult[]
  grainWarnings: string[]
  grainDiff?: GrainNestDiff | null
  grainVersion: string // 本次排样的分组/断口签名（存档与单据作废判定）
}

// 同一张板上长组/短组的先后取舍（只能选一条）：
// long-first 保住长条连纹，短组被挤到边角可能多占一张板（让出的是省板）
// short-first 先填小板缝省板，长组可能被拆开，整面柜子花纹断在中间（让出的是连纹完整）
export type GroupOrderPolicy = 'long-first' | 'short-first'

// 已发单据的连纹版本（本机存档）：选错的一版已导出领料单后，旧分组/旧单据/旧拼版图作废
export interface GrainIssuedVersion {
  version: string
  issuedAt: number
  boardsUsed: number
  groupDesc: string // 组号-段数-断口数 的摘要
}

export interface GrainVoidInfo {
  oldVersion: string
  issuedAt: number
  currentVersion: string
  reason: string
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
  // 成组连纹
  grainGroups?: GrainGroupDef[]
  grainPolicy?: GroupOrderPolicy
  grainIssued?: GrainIssuedVersion | null // 已导出领料单的版本
  grainVoid?: GrainVoidInfo | null // 已作废的上一版（旧分组/单据/拼版图）
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
