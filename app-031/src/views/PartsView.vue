<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  useStore,
  getJob,
  saveJob,
  runNest,
  newPart,
  allStockTemplates,
  grainGroupsOf,
  addGrainGroup,
  updateGrainGroup,
  removeGrainGroup,
  moveGrainMember,
  setGrainPolicy
} from '../lib/store'
import { uid, parsePartText, parseEdges, money } from '../lib/format'
import { toast } from '../lib/ui'
import type { Board, EdgeSide, Part } from '../types'

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

// —— 成组连纹 ——
const grainGroups = computed(() => (job.value ? grainGroupsOf(job.value) : []))

function partOf(id: string): Part | undefined {
  return job.value?.parts.find((p) => p.id === id)
}
function isMemberInOther(gIdx: number, partId: string): boolean {
  return grainGroups.value.some((g, i) => i !== gIdx && g.memberPartIds.includes(partId))
}
function addGroup(): void {
  if (!job.value) return
  addGrainGroup(job.value, [])
  save()
}
function removeGroup(id: string): void {
  if (!job.value) return
  if (!window.confirm('删除该连纹组？组成员将恢复为零散件（不删除零件本身）。')) return
  removeGrainGroup(job.value, id)
  toast('连纹组已删除，成员恢复零散件', 'info')
}
function toggleMember(gIdx: number, partId: string): void {
  if (!job.value) return
  const g = grainGroups.value[gIdx]
  if (!g) return
  const i = g.memberPartIds.indexOf(partId)
  if (i >= 0) g.memberPartIds.splice(i, 1)
  else {
    if (isMemberInOther(gIdx, partId)) {
      toast('该零件已绑在别的连纹组里，一件只能属于一组', 'bad')
      return
    }
    g.memberPartIds.push(partId)
  }
  updateGrainGroup(job.value, g.id, { memberPartIds: [...g.memberPartIds] })
}
function moveMember(gIdx: number, partId: string, delta: -1 | 1): void {
  if (!job.value) return
  const g = grainGroups.value[gIdx]
  if (!g) return
  moveGrainMember(job.value, g.id, partId, delta)
}
function toggleConcession(gIdx: number, step: 'move' | 'split'): void {
  if (!job.value) return
  const g = grainGroups.value[gIdx]
  if (!g) return
  const has = g.concession.includes(step)
  let next = g.concession.filter((x) => x !== step)
  if (has) {
    // 至少保留一种让步
    if (next.length === 0) {
      toast('至少保留一种让步（整组挪板 或 拆段）', 'bad')
      return
    }
  } else next = step === 'move' ? ['move', ...next] : [...next, 'split']
  updateGrainGroup(job.value, g.id, { concession: next })
}
function setPolicy(v: 'long-first' | 'short-first'): void {
  if (!job.value) return
  setGrainPolicy(job.value, v)
  save()
}
function groupStripLen(gIdx: number): number {
  const g = grainGroups.value[gIdx]
  if (!g) return 0
  let len = 0
  let n = 0
  for (const id of g.memberPartIds) {
    const p = partOf(id)
    if (!p) continue
    for (let k = 0; k < p.qty; k++) {
      len += p.grain === 'width' ? p.widMm : p.lenMm
      n++
    }
  }
  return n > 0 ? Math.round(len + (n - 1) * (job.value?.kerfMm ?? 3.2)) : 0
}
function memberLabel(id: string): string {
  const p = partOf(id)
  return p ? `${p.code || '(无编号)'} ${p.lenMm}×${p.widMm}×${p.qty}` : '(已删除)'
}
const policyDesc = computed(() =>
  job.value?.grainPolicy === 'short-first'
    ? '先排短组：短组先把已开板的边角小板缝填满，省板；代价是长组可能被拆开、整面柜子的花纹断在中间（让出的是连纹完整性）。'
    : '先排长组：长组优先占整条、保住长条连纹；代价是短组被挤到边角，可能要多开一张板（让出的是省板）。'
)

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

    <!-- 成组连纹 -->
    <section class="panel" style="margin-bottom: 14px">
      <div class="row" style="margin-bottom: 6px">
        <h3 style="font-size: 14px">成组连纹（同一面柜子并排门板，纹理首尾相接）</h3>
        <span class="tag">连纹长度 mm 取整 · 面积 mm² 取整</span>
        <div class="spacer" />
        <button class="sm primary" @click="addGroup">＋ 新建连纹组</button>
      </div>
      <p class="small muted" style="margin: 4px 0 10px">
        把要连纹的门板按拼装顺序绑成一组：它们会落在<strong>同一张板、纹理朝同一方向、沿纹理首尾相接排成一整条</strong>，
        中间不插别家的件；其余零散件再按老规矩填缝。一件只能属于一组；单成员组不出断口。
      </p>

      <div class="row wrap" style="gap: 18px; margin-bottom: 10px; align-items: center">
        <span class="small"><b>同板先排：</b></span>
        <label class="row small policy-opt" :class="{ on: job.grainPolicy !== 'short-first' }">
          <input type="radio" :checked="job.grainPolicy !== 'short-first'" @change="setPolicy('long-first')" />
          <span><b>先排长组（保连纹）</b>：长条不断，短组可能被挤到边角多占一张板</span>
        </label>
        <label class="row small policy-opt" :class="{ on: job.grainPolicy === 'short-first' }">
          <input type="radio" :checked="job.grainPolicy === 'short-first'" @change="setPolicy('short-first')" />
          <span><b>先排短组（省板）</b>：先填边角小板缝，长组可能被拆开，花纹断在中间</span>
        </label>
      </div>
      <p class="small" style="color: #92600a; margin: 0 0 12px">{{ policyDesc }} 这两条只能选一条。</p>

      <div v-if="grainGroups.length === 0" class="small muted">
        还没有连纹组。点「新建连纹组」，勾选同一面柜子上要纹理相接的门板。
      </div>

      <div v-for="(g, gi) in grainGroups" :key="g.id" class="grain-card">
        <div class="row" style="gap: 8px">
          <span class="gno">G{{ gi + 1 }}</span>
          <input v-model="g.name" @change="updateGrainGroup(job!, g.id, { name: g.name })" class="gname" />
          <span class="tag">{{ g.memberPartIds.length }} 种</span>
          <span class="tag good">整条约 {{ groupStripLen(gi) }} mm</span>
          <div class="spacer" />
          <label class="row small" style="gap: 4px">
            <input
              type="checkbox"
              :checked="g.allowSplit"
              @change="updateGrainGroup(job!, g.id, { allowSplit: ($event.target as HTMLInputElement).checked })"
            />
            允许让步拆段
          </label>
          <button class="sm ghost-danger" @click="removeGroup(g.id)">删组</button>
        </div>

        <div class="row small wrap" style="gap: 6px; margin: 6px 0">
          <span class="muted">一组排不下时让步顺序：</span>
          <button
            class="conc-btn"
            :class="{ on: g.concession[0] === 'move' }"
            @click="toggleConcession(gi, 'move')"
            title="整组挪到下一张板，连纹不断"
          >① 整组挪下一张板</button>
          <button
            class="conc-btn"
            :class="{ on: g.concession.includes('split'), off: !g.allowSplit }"
            :disabled="!g.allowSplit"
            @click="toggleConcession(gi, 'split')"
            title="按最长前缀拆成两段各自纹理连续的组，断口会标明"
          >{{ g.concession[0] === 'split' ? '① 拆成两段（各自连续）' : '② 拆成两段（各自连续）' }}</button>
          <span class="muted">当前顺序：{{ g.concession.map((c) => (c === 'move' ? '整组挪板' : '拆段')).join(' → ') }}</span>
        </div>

        <!-- 已绑成员（可排序=连纹首尾次序） -->
        <div v-if="g.memberPartIds.length > 0" class="member-chain">
          <template v-for="(id, mi) in g.memberPartIds" :key="id">
            <div class="member-chip" :class="{ invalid: !partOf(id) }">
              <span class="ord">{{ mi + 1 }}</span>
              <span>{{ memberLabel(id) }}</span>
              <span class="chip-actions">
                <button class="xs" :disabled="mi === 0" @click="moveMember(gi, id, -1)">←</button>
                <button class="xs" :disabled="mi === g.memberPartIds.length - 1" @click="moveMember(gi, id, 1)">→</button>
                <button class="xs ghost-danger" @click="toggleMember(gi, id)">×</button>
              </span>
            </div>
            <span v-if="mi < g.memberPartIds.length - 1" class="chain-arrow">纹理→</span>
          </template>
        </div>

        <!-- 勾选可加入的零件 -->
        <div class="add-members">
          <span class="small muted">勾选成员（按勾选顺序沿纹理相接；同一编号数量会逐扇展开）：</span>
          <div class="row wrap" style="gap: 6px; margin-top: 4px">
            <label
              v-for="p in job.parts"
              :key="p.id"
              class="pick-cb"
              :class="{ on: g.memberPartIds.includes(p.id), used: isMemberInOther(gi, p.id) }"
            >
              <input
                type="checkbox"
                :checked="g.memberPartIds.includes(p.id)"
                :disabled="isMemberInOther(gi, p.id)"
                @change="toggleMember(gi, p.id)"
              />
              {{ p.code || p.name }} {{ p.lenMm }}×{{ p.widMm }}
              <i :title="p.grain === 'length' ? '竖纹' : p.grain === 'width' ? '横纹' : '纹理无要求'">
                {{ p.grain === 'length' ? '竖' : p.grain === 'width' ? '横' : '无' }}
              </i>
            </label>
          </div>
        </div>
      </div>
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
.policy-opt {
  border: 1px solid var(--c-line);
  border-radius: 8px;
  padding: 6px 10px;
  cursor: pointer;
  max-width: 430px;
}
.policy-opt.on {
  border-color: var(--c-primary);
  background: #fff7ed;
}
.grain-card {
  border: 1px solid var(--c-line);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 10px;
  background: #fcfdfb;
}
.gno {
  background: #1f2a26;
  color: #f59e0b;
  font-weight: 700;
  border-radius: 6px;
  padding: 3px 9px;
  font-size: 13px;
}
.gname {
  width: 200px;
  font-weight: 600;
}
.conc-btn {
  border: 1px solid var(--c-line);
  background: #fff;
  border-radius: 999px;
  padding: 3px 12px;
  font-size: 12px;
  cursor: pointer;
}
.conc-btn.on {
  border-color: #b45309;
  background: #fef3c7;
  color: #92400e;
  font-weight: 700;
}
.conc-btn.off {
  opacity: 0.45;
}
.member-chain {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin: 8px 0;
}
.member-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid #d6a55e;
  background: #fffaf0;
  border-radius: 6px;
  padding: 3px 6px 3px 3px;
  font-size: 12px;
}
.member-chip.invalid {
  border-color: #dc2626;
  background: #fef2f2;
}
.member-chip .ord {
  background: #b45309;
  color: #fff;
  border-radius: 4px;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
}
.chip-actions {
  display: inline-flex;
  gap: 2px;
}
button.xs {
  border: 1px solid var(--c-line);
  background: #fff;
  border-radius: 4px;
  font-size: 11px;
  padding: 0 5px;
  line-height: 17px;
  cursor: pointer;
}
button.xs:disabled {
  opacity: 0.35;
  cursor: default;
}
.chain-arrow {
  font-size: 11px;
  color: #b45309;
  font-weight: 700;
}
.add-members {
  border-top: 1px dashed var(--c-line-soft);
  padding-top: 6px;
}
.pick-cb {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--c-line);
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
  cursor: pointer;
  background: #fff;
}
.pick-cb.on {
  border-color: #b45309;
  background: #fff7ed;
  font-weight: 600;
}
.pick-cb.used {
  opacity: 0.5;
}
.pick-cb i {
  font-style: normal;
  color: var(--c-ink-2);
  font-size: 10px;
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
