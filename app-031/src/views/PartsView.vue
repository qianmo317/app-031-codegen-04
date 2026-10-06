<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  useStore,
  getJob,
  saveJob,
  runNest,
  newPart,
  allStockTemplates
} from '../lib/store'
import { uid, parsePartText, parseEdges, money } from '../lib/format'
import { toast } from '../lib/ui'
import { grainInputSignature } from '../lib/packing'
import type { Board, EdgeSide, GrainGroup, Part } from '../types'

const route = useRoute()
const router = useRouter()
const { state } = useStore()
const job = computed(() => getJob(route.params.id as string))

const importOpen = ref(false)
const importText = ref('')
const importErr = ref<string[]>([])
const importReplace = ref(false)
const running = ref(false)

const grainLabel: Record<Part['grain'], string> = {
  length: '竖纹',
  width: '横纹',
  none: '无要求'
}
const edgeDefs: { key: EdgeSide; label: string }[] = [
  { key: 'top', label: '上' },
  { key: 'bottom', label: '下' },
  { key: 'left', label: '左' },
  { key: 'right', label: '右' }
]

const totalPieces = computed(() => job.value?.parts.reduce((a, p) => a + (p.qty || 0), 0) ?? 0)
const totalArea = computed(
  () => (job.value?.parts.reduce((a, p) => a + p.lenMm * p.widMm * p.qty, 0) ?? 0) / 1e6
)

const availableOffcuts = computed(() => state.offcuts.filter((o) => o.available))

function partById(id: string): Part | undefined {
  return job.value?.parts.find((p) => p.id === id)
}
function groupBoundQty(partId: string, exceptGroupId?: string): number {
  if (!job.value) return 0
  return job.value.grainGroups
    .filter((g) => g.id !== exceptGroupId)
    .reduce((a, g) => a + g.members.filter((m) => m.partId === partId).reduce((x, m) => x + (m.qty || 0), 0), 0)
}
function partAvailableForGroup(part: Part, group?: GrainGroup): number {
  const inGroup = group?.members.find((m) => m.partId === part.id)?.qty ?? 0
  return part.qty - groupBoundQty(part.id, group?.id) + inGroup
}
function addGrainGroup(): void {
  if (!job.value) return
  const firstGrain = job.value.parts.find((p) => p.grain !== 'none' && groupBoundQty(p.id) < p.qty)
  const group: GrainGroup = {
    id: uid('grp'),
    name: `连纹组 ${job.value.grainGroups.length + 1}`,
    members: firstGrain ? [{ partId: firstGrain.id, qty: 1 }] : [],
    splitPolicy: 'split',
    splitAfter: 1
  }
  job.value.grainGroups.push(group)
  save()
}
function removeGrainGroup(id: string): void {
  if (!job.value) return
  job.value.grainGroups = job.value.grainGroups.filter((g) => g.id !== id)
  save()
}
function addMember(g: GrainGroup): void {
  const candidate = job.value?.parts.find(
    (p) => p.grain !== 'none' && !g.members.some((m) => m.partId === p.id) && groupBoundQty(p.id, g.id) < p.qty
  )
  if (!candidate) {
    toast('没有可添加的有纹理零件；先增加零件数量或解绑其它组', 'bad')
    return
  }
  g.members.push({ partId: candidate.id, qty: 1 })
  save()
}
function memberPartChanged(member: GrainGroup['members'][number]): void {
  member.qty = 1
  save()
}
function memberQtyChanged(g: GrainGroup, partId: string, qty: number): void {
  const part = partById(partId)
  const m = g.members.find((x) => x.partId === partId)
  if (!part || !m) return
  m.qty = Math.max(1, Math.min(qty || 1, partAvailableForGroup(part, g)))
  const total = groupMemberCount(g)
  if (g.splitAfter) g.splitAfter = Math.min(Math.max(1, g.splitAfter), Math.max(1, total - 1))
  save()
}
function groupMemberCount(g: GrainGroup): number {
  return g.members.reduce((a, m) => a + Math.max(0, Number(m.qty) || 0), 0)
}
function groupWarnings(): string[] {
  const j = job.value
  if (!j) return []
  const out: string[] = []
  j.grainGroups.forEach((g, gi) => {
    const total = groupMemberCount(g)
    const parts = g.members.map((m) => partById(m.partId)).filter((p): p is Part => !!p)
    if (total <= 1) return
    const grains = new Set(parts.map((p) => p.grain))
    if (grains.has('none') || grains.size > 1) out.push(`${groupCodeText(gi)}「${g.name}」纹理方向不一致，无法同纹连纹`)
    const boardIds = new Set(parts.map((p) => p.boardId).filter(Boolean))
    if (boardIds.size > 1) out.push(`${groupCodeText(gi)}「${g.name}」指定了多种板材，不能保证同板`)
    if (g.splitPolicy === 'split' && (g.splitAfter ?? 0) < 1) out.push(`${groupCodeText(gi)}需写明拆在哪里（第 N 件之后）`)
  })
  return out
}
function groupCodeText(i: number): string {
  return `G${String(i + 1).padStart(2, '0')}`
}
function grainPartText(p: Part | undefined): string {
  if (!p) return '已删除零件'
  return `${p.code} ${p.name}（${p.grain === 'length' ? '竖纹' : p.grain === 'width' ? '横纹' : '无纹'} ${p.lenMm}×${p.widMm}，可绑 ${p.qty - groupBoundQty(p.id)} 件）`
}

function save(): void {
  if (job.value) saveJob(job.value)
}

function addBoard(): void {
  if (!job.value) return
  const t = allStockTemplates()[3] // 2745×1220
  job.value.boards.push({ ...t, id: uid('b') } as Board)
  save()
}
function onPickTemplate(e: Event): void {
  const sel = e.target as HTMLSelectElement
  const i = Number(sel.value)
  sel.selectedIndex = 0
  if (i >= 0) addSpecificBoard(allStockTemplates()[i])
}
function addSpecificBoard(t: ReturnType<typeof allStockTemplates>[number]): void {
  if (!job.value) return
  if (job.value.boards.some((b) => b.name === t.name)) {
    toast('该板材已在库中', 'bad')
    return
  }
  job.value.boards.push({ ...t, id: uid('b') } as Board)
  save()
}
function removeBoard(id: string): void {
  if (!job.value) return
  if (job.value.boards.length <= 1) {
    toast('至少保留一种板材', 'bad')
    return
  }
  job.value.boards = job.value.boards.filter((b) => b.id !== id)
  for (const p of job.value.parts) if (p.boardId === id) p.boardId = ''
  save()
}
function toggleOffcut(id: string): void {
  if (!job.value) return
  const arr = job.value.useOffcutIds
  const i = arr.indexOf(id)
  if (i >= 0) arr.splice(i, 1)
  else arr.push(id)
  save()
}

function addPart(): void {
  job.value?.parts.push(
    newPart({
      code: `P${(job.value.parts.length + 1).toString().padStart(2, '0')}`,
      name: '新零件'
    })
  )
  save()
}
function removePart(id: string): void {
  if (!job.value) return
  job.value.parts = job.value.parts.filter((p) => p.id !== id)
  save()
}
function duplicatePart(p: Part): void {
  const idx = job.value!.parts.findIndex((x) => x.id === p.id)
  job.value!.parts.splice(idx + 1, 0, { ...p, id: uid('p') })
  save()
}
function toggleEdge(p: Part, e: EdgeSide): void {
  const i = p.edgeBands.indexOf(e)
  if (i >= 0) p.edgeBands.splice(i, 1)
  else p.edgeBands.push(e)
  save()
}

const warnings = computed<string[]>(() => {
  const out: string[] = []
  const j = job.value
  if (!j) return out
  const maxW = Math.max(...j.boards.map((b) => b.wMm - 2 * j.trimMm))
  const maxH = Math.max(...j.boards.map((b) => b.hMm - 2 * j.trimMm))
  for (const p of j.parts) {
    const long = Math.max(p.lenMm, p.widMm)
    const short = Math.min(p.lenMm, p.widMm)
    if (p.grain === 'length' && (p.lenMm > maxW || p.widMm > maxH))
      out.push(`「${p.code}」竖纹件 ${p.lenMm}×${p.widMm} 超过可用板幅 ${maxW}×${maxH}`)
    if (p.grain === 'width' && (p.widMm > maxW || p.lenMm > maxH))
      out.push(`「${p.code}」横纹件 ${p.lenMm}×${p.widMm} 超过可用板幅 ${maxW}×${maxH}`)
    if (p.grain === 'none' && long > maxW)
      out.push(`「${p.code}」长边 ${long} 超过板长 ${maxW}`)
    void short
  }
  if (j.trimMm < 5 || j.trimMm > 10) out.push('修边量通常取 5~10mm')
  return out
})

function doImport(): void {
  if (!job.value) return
  const { rows, errors } = parsePartText(importText.value)
  importErr.value = errors
  if (rows.length === 0) {
    toast('没有可导入的行', 'bad')
    return
  }
  const boardId = job.value.boards[0]?.id ?? ''
  const built = rows.map((r) =>
    newPart({
      code: r.code || `P${Math.floor(Math.random() * 9000 + 1000)}`,
      name: r.name,
      lenMm: r.lenMm,
      widMm: r.widMm,
      qty: r.qty,
      grain: r.grain as Part['grain'],
      edgeBands: parseEdges(r.edges),
      cabinet: r.cabinet,
      exposed: r.exposed,
      boardId
    })
  )
  if (importReplace.value) job.value.parts = built
  else job.value.parts.push(...built)
  save()
  toast(`已导入 ${built.length} 条`, 'good')
  importOpen.value = false
  importText.value = ''
}

async function doNest(): Promise<void> {
  const j = job.value
  if (!j) return
  if (j.parts.length === 0) {
    toast('请先添加零件', 'bad')
    return
  }
  running.value = true
  try {
    if (
      j.result &&
      j.result.grain.inputSignature !== grainInputSignature(j) &&
      j.result.grain.issuedRevisions.includes(j.result.grain.version)
    ) {
      const ok = window.confirm(
        `V${j.result.grain.version} 的领料/下料单已经发出并保存在本机。继续排样会把旧分组、旧拼版图和已发单据标记作废。确定继续吗？`
      )
      if (!ok) {
        running.value = false
        return
      }
    }
    const r = runNest(j)
    if (r.unplaced.length > 0) {
      toast(`${r.unplaced.length} 种零件未排下，请看排样页提示`, 'bad', 4200)
    } else {
      toast(`排样完成：${r.boardsUsed} 张板，${r.elapsedMs}ms`, 'good')
    }
    router.push(`/nest/${j.id}`)
  } finally {
    running.value = false
  }
}

const sampleTsv = `名称\t长\t宽\t数量\t纹理\t封边\t柜体\t见光
门板\t2200\t450\t2\t竖纹\t上下左右\t衣柜\t是
层板\t550\t560\t4\t无\t左右\t衣柜\t否`
</script>

<template>
  <div v-if="job">
    <div class="row wrap" style="margin-bottom: 14px">
      <input v-model="job.name" @change="save" style="width: 320px; font-weight: 650; font-size: 16px" />
      <span class="tag">创建于 {{ new Date(job.createdAt).toLocaleDateString('zh-CN') }}</span>
      <div class="spacer" />
      <button class="primary" :disabled="running" @click="doNest">
        {{ running ? '排样计算中…' : '开始排样 →' }}
      </button>
    </div>

    <!-- 参数与余料 -->
    <section class="panel" style="margin-bottom: 14px">
      <div class="row wrap" style="align-items: flex-end">
        <label class="field" style="width: 130px">
          <span>锯路 kerf (mm)</span>
          <input v-model.number="job.kerfMm" type="number" step="0.1" min="1" max="8" @change="save" />
        </label>
        <label class="field" style="width: 130px">
          <span>四周修边 (mm)</span>
          <input v-model.number="job.trimMm" type="number" step="1" min="0" max="20" @change="save" />
        </label>
        <label class="field row" style="margin-bottom: 10px">
          <input type="checkbox" v-model="job.batchByCabinet" @change="save" />
          <span style="margin: 0 0 0 6px">按柜体批次分组开料（同柜零件尽量连续排）</span>
        </label>
      </div>
      <div v-if="availableOffcuts.length > 0">
        <h4 style="margin: 8px 0 6px; font-size: 13px">余料优先：勾选已登记余料作为小板材参与本单排样</h4>
        <div class="row wrap">
          <label
            v-for="o in availableOffcuts"
            :key="o.id"
            class="offcut-chip"
            :class="{ on: job.useOffcutIds.includes(o.id) }"
          >
            <input type="checkbox" :checked="job.useOffcutIds.includes(o.id)" @change="toggleOffcut(o.id)" />
            {{ o.wMm }}×{{ o.hMm}}×{{ o.thicknessMm }} {{ o.material }}（{{ o.jobName }}）
          </label>
        </div>
      </div>
    </section>

    <!-- 成组连纹 -->
    <section class="panel grain-panel">
      <div class="row" style="margin-bottom: 8px">
        <h3 style="font-size: 14px">成组连纹</h3>
        <span class="tag good">同组必须同板、同纹同向，沿花纹首尾相接</span>
        <div class="spacer" />
        <button class="sm" @click="addGrainGroup">＋ 新建连纹组</button>
      </div>
      <div class="grain-strategy">
        <b>同一张板只能选一种取舍：</b>
        <label :class="{ on: job.grainPriority === 'longFirst' }">
          <input type="radio" value="longFirst" v-model="job.grainPriority" @change="save" />
          先排长组（保连纹，可能多用 1 张板）
        </label>
        <label :class="{ on: job.grainPriority === 'shortFirst' }">
          <input type="radio" value="shortFirst" v-model="job.grainPriority" @change="save" />
          先排短组（填满小板缝，长组可能在板间断开）
        </label>
      </div>
      <p class="small muted">
        连纹长度按毫米取整（四舍五入，净长度不含锯路）；面积按平方毫米 mm² 整数计算（零件净面积，不含锯路）。组内顺序就是下面成员从上到下的顺序。
        未绑定的件或只有一件的组不会制造断口，继续按普通件填缝。
      </p>
      <div v-if="groupWarnings().length" class="warn-box">
        <div v-for="(w, i) in groupWarnings()" :key="i">⚠️ {{ w }}</div>
      </div>
      <div v-if="job.grainGroups.length === 0" class="small muted">尚未绑定连纹组；零散门板会各自排样，可能一扇深一扇浅。</div>
      <div v-for="(g, gi) in job.grainGroups" :key="g.id" class="grain-card">
        <div class="row wrap grain-head">
          <b class="gcode">{{ groupCodeText(gi) }}</b>
          <input v-model="g.name" @change="save" style="width: 220px" />
          <label class="row small">
            放不下时
            <select v-model="g.splitPolicy" @change="save">
              <option value="move">整组挪到下一张板</option>
              <option value="split">按写明顺序拆成两小段</option>
            </select>
          </label>
          <label v-if="g.splitPolicy === 'split'" class="row small">
            断在第
            <input
              v-model.number="g.splitAfter"
              type="number"
              min="1"
              :max="Math.max(1, groupMemberCount(g) - 1)"
              @change="save"
            />
            件之后
          </label>
          <span class="tag">共 {{ groupMemberCount(g) }} 件</span>
          <div class="spacer" />
          <button class="sm" @click="addMember(g)">加成员</button>
          <button class="sm ghost-danger" @click="removeGrainGroup(g.id)">解散</button>
        </div>
        <div v-for="(m, mi) in g.members" :key="m.partId + mi" class="grain-member">
          <span class="ord">{{ mi + 1 }}</span>
          <select v-model="m.partId" @change="memberPartChanged(m)">
            <option v-for="p in job.parts.filter((x) => x.grain !== 'none' && (!g.members.some((z) => z.partId === x.id && z !== m) || x.id === m.partId))" :key="p.id" :value="p.id">
              {{ grainPartText(p) }}
            </option>
          </select>
          <label class="row small">绑定 <input v-model.number="m.qty" type="number" min="1" :max="partById(m.partId)?.qty ?? 1" @change="memberQtyChanged(g, m.partId, m.qty)" /> 件</label>
          <button class="sm ghost-danger" @click="g.members.splice(mi, 1); save()">×</button>
        </div>
      </div>
    </section>

    <!-- 板材库 -->
    <section class="panel" style="margin-bottom: 14px">
      <div class="row" style="margin-bottom: 8px">
        <h3 style="font-size: 14px">板材库</h3>
        <div class="spacer" />
        <select style="width: 260px" @change="onPickTemplate">
          <option value="-1">＋ 从常用规格添加…</option>
          <option v-for="(t, i) in allStockTemplates()" :key="i" :value="i">{{ t.name }} {{ money(t.priceCents) }}</option>
        </select>
        <button class="sm" @click="addBoard">添加自定义板</button>
      </div>
      <table class="grid board-table">
        <thead>
          <tr>
            <th>名称/材质</th><th>长(mm)</th><th>宽(mm)</th><th>厚(mm)</th>
            <th>单价</th><th>库存张数(0=不限)</th><th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="b in job.boards" :key="b.id">
            <td>
              <input v-model="b.name" @change="save" />
              <input v-model="b.material" @change="save" class="sub-input" placeholder="材质" />
            </td>
            <td style="width: 96px"><input v-model.number="b.wMm" type="number" @change="save" /></td>
            <td style="width: 96px"><input v-model.number="b.hMm" type="number" @change="save" /></td>
            <td style="width: 84px"><input v-model.number="b.thicknessMm" type="number" @change="save" /></td>
            <td style="width: 110px"><input v-model.number="b.priceCents" type="number" @change="save" /></td>
            <td style="width: 130px"><input v-model.number="b.quantity" type="number" min="0" @change="save" /></td>
            <td style="width: 46px"><button class="sm ghost-danger" @click="removeBoard(b.id)">删</button></td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 零件清单 -->
    <section class="panel">
      <div class="row" style="margin-bottom: 8px">
        <h3 style="font-size: 14px">零件清单</h3>
        <span class="tag">{{ job.parts.length }} 种 / {{ totalPieces }} 件 / {{ totalArea.toFixed(2) }}m²</span>
        <div class="spacer" />
        <button class="sm" @click="importOpen = !importOpen">批量粘贴导入</button>
        <button class="sm primary" @click="addPart">＋ 添加零件</button>
      </div>

      <div v-if="importOpen" class="import-box">
        <p class="small muted">
          支持 Excel 直接粘贴（制表符分隔），列：名称/长/宽/数量/纹理(竖|横|无)/封边(上下左右)/柜体/见光(是)。
          无表头时按「名称,长,宽,数量,纹理,封边,柜体,见光」顺序解析。
        </p>
        <textarea v-model="importText" rows="6" :placeholder="sampleTsv"></textarea>
        <p v-for="(e, i) in importErr" :key="i" class="small" style="color: var(--c-bad)">{{ e }}</p>
        <div class="row" style="margin-top: 6px">
          <label class="row small"><input type="checkbox" v-model="importReplace" /> 替换当前清单</label>
          <div class="spacer" />
          <button class="sm" @click="importOpen = false">取消</button>
          <button class="sm primary" @click="doImport">解析并导入</button>
        </div>
      </div>

      <div v-if="warnings.length > 0" class="warn-box">
        <div v-for="(w, i) in warnings" :key="i">⚠️ {{ w }}</div>
      </div>

      <div class="table-scroll">
        <table class="grid parts-table">
          <thead>
            <tr>
              <th style="width: 80px">编号</th>
              <th style="width: 130px">名称</th>
              <th style="width: 80px">长(mm)</th>
              <th style="width: 80px">宽(mm)</th>
              <th style="width: 64px">数量</th>
              <th style="width: 92px">纹理</th>
              <th style="width: 132px">封边</th>
              <th style="width: 110px">柜体/房间</th>
              <th style="width: 70px">见光</th>
              <th style="width: 130px">指定板材</th>
              <th style="width: 78px"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in job.parts" :key="p.id">
              <td><input v-model="p.code" @change="save" /></td>
              <td><input v-model="p.name" @change="save" /></td>
              <td><input v-model.number="p.lenMm" type="number" min="1" @change="save" /></td>
              <td><input v-model.number="p.widMm" type="number" min="1" @change="save" /></td>
              <td><input v-model.number="p.qty" type="number" min="1" @change="save" /></td>
              <td>
                <select v-model="p.grain" @change="save">
                  <option v-for="(lab, g) in grainLabel" :key="g" :value="g">{{ lab }}</option>
                </select>
              </td>
              <td>
                <div class="edge-group">
                  <label v-for="ed in edgeDefs" :key="ed.key" class="edge-cb" :class="{ on: p.edgeBands.includes(ed.key) }">
                    <input type="checkbox" :checked="p.edgeBands.includes(ed.key)" @change="toggleEdge(p, ed.key)" />
                    {{ ed.label }}
                  </label>
                </div>
              </td>
              <td><input v-model="p.cabinet" @change="save" /></td>
              <td style="text-align: center"><input type="checkbox" v-model="p.exposed" @change="save" /></td>
              <td>
                <select v-model="p.boardId" @change="save">
                  <option value="">自动</option>
                  <option v-for="b in job.boards" :key="b.id" :value="b.id">{{ b.name }}</option>
                </select>
              </td>
              <td>
                <button class="sm" title="复制一行" @click="duplicatePart(p)">复</button>
                <button class="sm ghost-danger" title="删除" @click="removePart(p.id)">×</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <div class="sticky-bar no-print">
      <span>{{ job.parts.length }} 种 / {{ totalPieces }} 件 · 总面积 {{ totalArea.toFixed(2) }}m²</span>
      <div class="spacer" />
      <router-link :to="`/`">返回列表</router-link>
      <button class="primary" :disabled="running" @click="doNest">
        {{ running ? '排样计算中…' : '开始排样 →' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.grain-panel {
  margin-bottom: 14px;
}
.grain-strategy {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  font-size: 12px;
  margin-bottom: 8px;
}
.grain-strategy label {
  border: 1px solid var(--c-line);
  border-radius: 999px;
  padding: 5px 10px;
  display: inline-flex;
  gap: 5px;
  align-items: center;
}
.grain-strategy label.on {
  border-color: var(--c-accent);
  background: #f0faf8;
  color: var(--c-accent);
  font-weight: 700;
}
.grain-card {
  border: 1px solid var(--c-line-soft);
  border-radius: 8px;
  padding: 10px;
  margin-top: 10px;
  background: #fafcf9;
}
.grain-head {
  gap: 8px;
}
.gcode {
  background: #1f2a26;
  color: #fff;
  border-radius: 5px;
  padding: 3px 7px;
}
.grain-member {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 7px;
}
.grain-member .ord {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #e7ede9;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
}
.grain-member select {
  flex: 1;
  min-width: 260px;
}
.grain-member input[type='number'] {
  width: 72px;
}
.offcut-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--c-line);
  border-radius: 999px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
  background: #fff;
}
.offcut-chip.on {
  border-color: var(--c-accent);
  background: #f0faf8;
  color: var(--c-accent);
  font-weight: 600;
}
.sub-input {
  margin-top: 3px;
  font-size: 11px;
  color: var(--c-ink-2);
}
.import-box {
  border: 1px dashed var(--c-line);
  border-radius: 6px;
  padding: 10px;
  margin-bottom: 10px;
  background: #fafcf9;
}
.warn-box {
  border: 1px solid #f0d9b5;
  background: #fffbeb;
  color: #92600a;
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 12px;
  margin-bottom: 10px;
}
.table-scroll {
  overflow-x: auto;
}
.parts-table th,
.parts-table td {
  padding: 4px 6px;
}
.parts-table input,
.parts-table select {
  padding: 4px 6px;
  min-width: 0;
}
.edge-group {
  display: flex;
  gap: 2px;
}
.edge-cb {
  font-size: 11px;
  border: 1px solid var(--c-line);
  border-radius: 4px;
  padding: 2px 5px;
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  gap: 2px;
  white-space: nowrap;
}
.edge-cb.on {
  background: #1f2a26;
  color: #fff;
  border-color: #1f2a26;
}
.edge-cb input {
  display: none;
}
.sticky-bar {
  position: sticky;
  bottom: 12px;
  margin-top: 16px;
  background: #1f2a26;
  color: #eef2ee;
  border-radius: 10px;
  padding: 10px 16px;
  display: flex;
  gap: 14px;
  align-items: center;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.25);
}
.sticky-bar a {
  color: #9fb0a7;
}
</style>
