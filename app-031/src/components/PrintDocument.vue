<script setup lang="ts">
import { computed } from 'vue'
import { printState } from '../lib/print'
import { getJob } from '../lib/store'
import boardsData from '../data/boards.json'
import SheetDiagram from './SheetDiagram.vue'
import { money, mm } from '../lib/format'

const job = computed(() => (printState.jobId ? getJob(printState.jobId) : undefined))
const sections = computed(() => new Set(printState.sections))
const now = computed(() => new Date().toLocaleString('zh-CN'))

const allInstances = computed(() => {
  if (!job.value?.result) return []
  return job.value.result.sheets.flatMap((s) => s.placements)
})

interface OrderRow {
  code: string
  name: string
  origLen: number
  origWid: number
  qty: number
  grain: string
  edgeCount: number
  exposed: boolean
}
const cabinetGroups = computed(() => {
  const map = new Map<string, OrderRow[]>()
  for (const p of allInstances.value) {
    const arr = map.get(p.cabinet) ?? []
    const cur = arr.find((r) => r.code === p.code)
    if (cur) cur.qty++
    else
      arr.push({
        code: p.code,
        name: p.name,
        origLen: p.origLen,
        origWid: p.origWid,
        qty: 1,
        grain: p.grain,
        edgeCount: p.edgeBands.length,
        exposed: p.exposed
      })
    map.set(p.cabinet, arr)
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh'))
})

const grainText = (g: string): string =>
  g === 'length' ? '竖纹' : g === 'width' ? '横纹' : '无要求'

const grainGroups = computed(() => job.value?.result?.grain.groups ?? [])
const grainRevisions = computed(() => job.value?.grainRevisions ?? [])

const boardByName = (name: string) =>
  job.value?.result?.sheets.find((x) => x.boardName === name)
</script>

<template>
  <div v-if="job" class="print-doc print-only">
    <!-- 排样图 -->
    <div v-if="sections.has('nest')">
      <section
        v-for="s in job.result?.sheets ?? []"
        :key="'pn' + s.index"
        class="print-page"
      >
        <h2>排样图 · 第 {{ s.index + 1 }} 张 / 共 {{ job.result?.sheets.length }} 张</h2>
        <p class="doc-meta">
          {{ s.boardName }}（{{ s.material }} {{ s.thicknessMm }}mm） · 尺寸
          {{ s.wMm }}×{{ s.hMm }}mm · 利用率 {{ (s.utilization * 100).toFixed(1) }}% ·
          锯路 {{ job.kerfMm }}mm · 修边 {{ job.trimMm }}mm ·
          连纹组 {{ s.grainSegments.map((x) => x.code).join('、') || '无' }}
        </p>
        <div class="print-sheet-wrap">
          <SheetDiagram :sheet="s" :show-cuts="false" print-mode />
        </div>
        <table class="pgrid">
          <thead>
            <tr>
              <th>序号</th><th>组号/顺序</th><th>编号</th><th>名称</th><th>柜体</th>
              <th>尺寸(mm)</th><th>纹理</th><th>封边</th><th>见光</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in s.placements" :key="p.instanceId">
              <td>{{ p.seq }}</td>
              <td>{{ p.grainSegmentCode || p.grainGroupCode || '—' }}<template v-if="p.grainOrder">#{{ p.grainOrder }}</template></td>
              <td>{{ p.code }}</td>
              <td>{{ p.name }}</td>
              <td>{{ p.cabinet }}</td>
              <td>{{ mm(p.origLen) }}×{{ mm(p.origWid) }}</td>
              <td>{{ grainText(p.grain) }}</td>
              <td>{{ p.edgeBands.length }} 边</td>
              <td>{{ p.exposed ? '是' : '' }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>

    <!-- 裁切步骤表 -->
    <div v-if="sections.has('cut')">
      <section
        v-for="s in job.result?.sheets ?? []"
        :key="'pc' + s.index"
        class="print-page"
      >
        <h2>裁切步骤表 · 第 {{ s.index + 1 }} 张（{{ s.boardName }}）</h2>
        <p class="doc-meta">按顺序下锯；同向刀已连续排程（减少推台翻转）；修边刀可多板叠切。本板连纹组：{{ s.grainSegments.map((x) => x.code).join('、') || '无' }}</p>
        <table class="pgrid">
          <thead>
            <tr><th>刀序</th><th>连纹组</th><th>类型</th><th>方向</th><th>位置(mm)</th><th>贯通区间(mm)</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr v-for="st in s.steps" :key="st.order">
              <td>{{ st.order + 1 }}</td>
              <td>{{ st.grainSegmentCodes?.join('/') || '—' }}</td>
              <td>{{ st.kind === 'trim' ? '修边' : '裁切' }}</td>
              <td>{{ st.axis === 'v' ? '竖刀' : '横刀' }}</td>
              <td>{{ Math.round(st.at) }}</td>
              <td>{{ st.span[0] }} ~ {{ st.span[1] }}</td>
              <td>{{ st.label }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>

    <!-- 下料单 / 领料单 -->
    <div v-if="sections.has('order')">
      <section class="print-page">
        <h2>下料单 / 领料单</h2>
        <p class="doc-meta">项目：{{ job.name }} ｜ 打印时间：{{ now }}</p>

        <h3>一、板材领料</h3>
        <table class="pgrid">
          <thead>
            <tr><th>板材</th><th>规格(mm)</th><th>厚度</th><th>张数</th><th>单价</th><th>小计</th></tr>
          </thead>
          <tbody>
            <tr v-for="(n, name) in job.result?.boardsByType" :key="name">
              <td>{{ name }}</td>
              <td>{{ boardByName(String(name))?.wMm }}×{{ boardByName(String(name))?.hMm }}</td>
              <td>{{ boardByName(String(name))?.thicknessMm }}</td>
              <td>{{ n }}</td>
              <td>{{ money(boardByName(String(name))?.priceCents ?? 0) }}</td>
              <td>{{ money((boardByName(String(name))?.priceCents ?? 0) * Number(n)) }}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td colspan="5">板材合计</td>
              <td>{{ money(job.result?.totalCostCents ?? 0) }}</td>
            </tr>
          </tfoot>
        </table>

        <h3>二、零件明细（按柜体分拣）</h3>
        <div v-for="[cab, list] in cabinetGroups" :key="cab" class="avoid-break">
          <h4>柜体/房间：{{ cab }}（{{ list.reduce((a, r) => a + r.qty, 0) }} 件）</h4>
          <table class="pgrid">
            <thead>
              <tr><th>编号</th><th>名称</th><th>尺寸(mm)</th><th>数量</th><th>纹理</th><th>封边</th><th>见光</th></tr>
            </thead>
            <tbody>
              <tr v-for="g in list" :key="g.code">
                <td>{{ g.code }}</td>
                <td>{{ g.name }}</td>
                <td>{{ mm(g.origLen) }}×{{ mm(g.origWid) }}</td>
                <td>{{ g.qty }}</td>
                <td>{{ grainText(g.grain) }}</td>
                <td>{{ g.edgeCount }} 边</td>
                <td>{{ g.exposed ? '是' : '' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <h3>三、成组连纹与断口（组号/板号与排样图、裁切表一致）</h3>
        <p class="doc-meta">长度单位 mm，四舍五入整数（净连纹长度，不含锯路）；面积单位 mm²，四舍五入整数（零件净面积，不含锯路）。当前版次 V{{ job.result?.grain.version }}。</p>
        <table class="pgrid">
          <thead>
            <tr><th>组号</th><th>组名</th><th>件数</th><th>状态</th><th>连纹长度(mm)</th><th>面积(mm²)</th><th>仍连续</th><th>断口位置</th></tr>
          </thead>
          <tbody>
            <tr v-for="g in grainGroups" :key="g.id">
              <td>{{ g.code }}</td>
              <td>{{ g.name }}</td>
              <td>{{ g.memberCount }}</td>
              <td>{{ g.status === 'complete' ? '完整' : g.status === 'split' ? '拆段' : g.status === 'unplaced' ? '未排下' : '无效' }}</td>
              <td>{{ g.netChainLengthMm }}</td>
              <td>{{ g.totalAreaMm2 }}</td>
              <td>{{ g.connectedOrders.map((s) => `第${s[0]}-${s[s.length - 1]}件`).join('；') || '—' }}</td>
              <td>
                <span v-if="g.breaks.length === 0">无断口</span>
                <span v-for="br in g.breaks" :key="br.beforeInstanceId">
                  第{{ br.afterOrder }}件前；后半段板{{ br.boardNo }}；{{ br.axis === 'x' ? 'X' : 'Y' }}={{ br.atMm }}mm
                </span>
              </td>
            </tr>
          </tbody>
        </table>
        <table v-if="grainRevisions.length" class="pgrid" style="margin-top: 6px">
          <thead><tr><th>版次</th><th>状态</th><th>已发单据</th><th>说明</th></tr></thead>
          <tbody>
            <tr v-for="r in [...grainRevisions].reverse()" :key="r.version">
              <td>V{{ r.version }}</td>
              <td>{{ r.status === 'active' ? '当前有效' : r.status === 'voided' ? '已作废' : '已被替代' }}</td>
              <td>{{ r.issued ? `已发 ${r.issuedAt ? new Date(r.issuedAt).toLocaleString('zh-CN') : ''}` : '未发' }}</td>
              <td>{{ r.voidReason || '本机存档' }}</td>
            </tr>
          </tbody>
        </table>
        <table v-if="job.result?.grain.changes.length" class="pgrid" style="margin-top: 6px">
          <thead><tr><th>改动组</th><th>改动说明</th><th>预览图变更行</th><th>裁切工单变更行</th><th>领料单据变更行</th></tr></thead>
          <tbody>
            <tr v-for="(c, i) in job.result.grain.changes" :key="i">
              <td>{{ c.groupCode }}</td>
              <td>{{ c.detail }}</td>
              <td>{{ c.previewRows.join('；') }}</td>
              <td>{{ c.cutRows.join('；') }}</td>
              <td>{{ c.orderRows.join('；') }}</td>
            </tr>
          </tbody>
        </table>

        <h3>四、封边与五金辅料</h3>
        <table class="pgrid">
          <tbody>
            <tr><td>见光边封边</td><td>{{ job.result?.edgeBandM.exposed }} m</td></tr>
            <tr><td>非见光边封边</td><td>{{ job.result?.edgeBandM.normal }} m</td></tr>
            <tr><td>{{ boardsData.hardware.connectorName }}</td><td>{{ allInstances.length * boardsData.hardware.connectorPerPart }}</td></tr>
            <tr><td>{{ boardsData.hardware.dowelName }}</td><td>{{ allInstances.length * boardsData.hardware.dowelPerPart }}</td></tr>
            <tr><td>{{ boardsData.hardware.screwName }}</td><td>{{ allInstances.length * boardsData.hardware.screwPerPart }}</td></tr>
            <tr>
              <td>{{ boardsData.hardware.glueName }}</td>
              <td>{{ ((((job.result?.edgeBandM.exposed ?? 0) + (job.result?.edgeBandM.normal ?? 0)) * boardsData.hardware.glueGramPerEdgeMeter) / 1000).toFixed(2) }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>

    <!-- 标签（A4 不干胶，每块一张） -->
    <div v-if="sections.has('labels')">
      <section class="print-page labels-page">
        <div
          v-for="(p, i) in allInstances"
          :key="'lb' + i"
          class="label-card avoid-break"
        >
          <div class="lb-code">{{ p.code }} <span class="lb-seq">#{{ p.seq }}</span></div>
          <div class="lb-name">{{ p.name }}</div>
          <div class="lb-dims">{{ mm(p.origLen) }} × {{ mm(p.origWid) }} mm</div>
          <div class="lb-meta">{{ p.cabinet }} ｜ {{ grainText(p.grain) }} ｜ {{ p.grainSegmentCode || p.grainGroupCode ? `连纹 ${p.grainSegmentCode || p.grainGroupCode}#${p.grainOrder} ｜ ` : '' }}封边 {{ p.edgeBands.length }} 边{{ p.exposed ? ' ｜ 见光' : '' }}</div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.print-doc {
  color: #000;
  font-size: 12px;
}
.print-doc h2 {
  font-size: 17px;
  margin-bottom: 6px;
}
.print-doc h3 {
  font-size: 14px;
  margin: 14px 0 6px;
}
.print-doc h4 {
  font-size: 13px;
  margin: 10px 0 4px;
}
.doc-meta {
  color: #333;
  margin: 0 0 8px;
  font-size: 11px;
}
.print-sheet-wrap {
  border: 1px solid #888;
  padding: 6px;
  margin-bottom: 10px;
}
table.pgrid {
  width: 100%;
  border-collapse: collapse;
  font-size: 10.5px;
}
table.pgrid th,
table.pgrid td {
  border: 1px solid #555;
  padding: 2.5px 5px;
  text-align: left;
}
table.pgrid th {
  background: #eee;
}
.labels-page {
  display: grid;
  grid-template-columns: repeat(2, 94mm);
  gap: 4mm 6mm;
  justify-content: center;
}
.label-card {
  border: 1.5px solid #000;
  border-radius: 3px;
  padding: 3mm 3.5mm;
  height: 38mm;
  overflow: hidden;
}
.lb-code {
  font-size: 15px;
  font-weight: 700;
}
.lb-seq {
  font-weight: 400;
  font-size: 11px;
}
.lb-name {
  font-size: 12px;
  margin: 1mm 0;
}
.lb-dims {
  font-size: 18px;
  font-weight: 700;
  margin: 1mm 0;
}
.lb-meta {
  font-size: 10.5px;
}
</style>
