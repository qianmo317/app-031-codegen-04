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
  grainGroupNo?: number
}
const cabinetGroups = computed(() => {
  const map = new Map<string, OrderRow[]>()
  for (const p of allInstances.value) {
    const arr = map.get(p.cabinet) ?? []
    const cur = arr.find((r) => r.code === p.code)
    if (cur) {
      cur.qty++
      if (!cur.grainGroupNo && p.grainGroupNo) cur.grainGroupNo = p.grainGroupNo
    } else
      arr.push({
        code: p.code,
        name: p.name,
        origLen: p.origLen,
        origWid: p.origWid,
        qty: 1,
        grain: p.grain,
        edgeCount: p.edgeBands.length,
        exposed: p.exposed,
        grainGroupNo: p.grainGroupNo
      })
    map.set(p.cabinet, arr)
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh'))
})

const grainText = (g: string): string =>
  g === 'length' ? '竖纹' : g === 'width' ? '横纹' : '无要求'

const boardByName = (name: string) =>
  job.value?.result?.sheets.find((x) => x.boardName === name)

// 本板连纹段展示串（G号-段号），来自与预览图同一份的 placements
const grainOnSheet = (s: { placements: { grainGroupNo?: number; grainSegmentNo?: number }[] }) => {
  const set = new Set<string>()
  for (const p of s.placements)
    if (p.grainGroupNo) set.add(`G${p.grainGroupNo}-${p.grainSegmentNo}`)
  return [...set].sort()
}
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
          锯路 {{ job.kerfMm }}mm · 修边 {{ job.trimMm }}mm
          <template v-if="grainOnSheet(s).length > 0">
            ｜ 本板连纹段：
            <b v-for="gid in grainOnSheet(s)" :key="gid">{{ gid }} </b>
          </template>
        </p>
        <div class="print-sheet-wrap">
          <SheetDiagram :sheet="s" :show-cuts="false" print-mode />
        </div>
        <table class="pgrid">
          <thead>
            <tr>
              <th>序号</th><th>编号</th><th>名称</th><th>柜体</th>
              <th>尺寸(mm)</th><th>纹理</th><th>封边</th><th>见光</th><th>连纹</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in s.placements" :key="p.instanceId">
              <td>{{ p.seq }}</td>
              <td>{{ p.code }}</td>
              <td>{{ p.name }}</td>
              <td>{{ p.cabinet }}</td>
              <td>{{ mm(p.origLen) }}×{{ mm(p.origWid) }}</td>
              <td>{{ grainText(p.grain) }}</td>
              <td>{{ p.edgeBands.length }} 边</td>
              <td>{{ p.exposed ? '是' : '' }}</td>
              <td><b v-if="p.grainGroupNo">G{{ p.grainGroupNo }}-{{ p.grainSegmentNo }}#{{ p.grainOrdinal }}</b></td>
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
        <p class="doc-meta">
          按顺序下锯；同向刀已连续排程（减少推台翻转）；修边刀可多板叠切。
          <b style="color:#b45309">标注「连纹」的刀为成组门板的横断刀，断刀两侧门板纹理同方向相接。</b>
        </p>
        <table class="pgrid">
          <thead>
            <tr><th>刀序</th><th>类型</th><th>方向</th><th>位置(mm)</th><th>贯通区间(mm)</th><th>连纹</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr v-for="st in s.steps" :key="st.order">
              <td>{{ st.order + 1 }}</td>
              <td>{{ st.kind === 'trim' ? '修边' : '裁切' }}</td>
              <td>{{ st.axis === 'v' ? '竖刀' : '横刀' }}</td>
              <td>{{ Math.round(st.at) }}</td>
              <td>{{ st.span[0] }} ~ {{ st.span[1] }}</td>
              <td><b v-if="st.grainCross" style="color:#b45309">G{{ st.grainGroupNo }}</b></td>
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
        <p class="doc-meta">
          项目：{{ job.name }} ｜ 打印时间：{{ now }}
          <template v-if="job.result && job.result.grainGroups.length > 0">
            ｜ 连纹版本：<b>{{ job.result.grainVersion.slice(0, 10) }}</b>
            （组号/板号/断口以此版为准，改版后旧单作废）
          </template>
        </p>
        <p v-if="job.grainVoid" style="color:#b91c1c; border:1px solid #b91c1c; padding:4px 8px">
          本单对应的旧版（{{ job.grainVoid.oldVersion.slice(0,10) }}，签发于
          {{ new Date(job.grainVoid.issuedAt).toLocaleString('zh-CN') }}）已作废，请勿再按旧拼版图领料、开料。
        </p>

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

        <h3>二、成组连纹与断口（组号/板号与排样图、裁切表同一份）</h3>
        <p v-if="(job.result?.grainGroups.length ?? 0) === 0" class="doc-meta">本单无成组连纹要求。</p>
        <table v-else class="pgrid">
          <thead>
            <tr>
              <th>组号</th><th>组名</th><th>扇数</th><th>段号</th><th>所在板</th>
              <th>连纹长度(mm)</th><th>面积(mm²)</th><th>段内门序（沿纹理）</th><th>断口</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="g in job.result?.grainGroups ?? []" :key="g.id">
              <tr v-for="(seg, si) in g.segments" :key="seg.id">
                <td><b>G{{ g.no }}</b></td>
                <td>{{ g.name }}</td>
                <td>{{ g.memberCount }}</td>
                <td>{{ seg.segmentNo }}/{{ g.segmentCount }}</td>
                <td>第 {{ seg.boardIndex + 1 }} 张</td>
                <td>{{ seg.lengthMm }}</td>
                <td>{{ seg.areaMm2.toLocaleString() }}</td>
                <td>{{ seg.memberCodes.join(' → ') }}</td>
                <td>
                  <span v-if="g.breaks[si]" style="color:#b91c1c">
                    ✂ {{ g.breaks[si].beforeCode }} → {{ g.breaks[si].afterCode }}
                    （{{ g.breaks[si].beforeBoardIndex + 1 }}板→{{ g.breaks[si].afterBoardIndex + 1 }}板，
                    {{ g.breaks[si].reason === 'forced' ? '被迫断' : '让步拆段' }}）
                  </span>
                  <span v-else-if="si === g.segmentCount - 1" class="doc-meta">段末（无后续断口）</span>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
        <p class="doc-meta" style="margin-top:4px">
          取舍口径：{{ job.result?.grainPolicy === 'short-first'
            ? '先排短组（省板优先，长组可能被拆）'
            : '先排长组（连纹优先，可能多占一张板）' }}。
          连纹长度按毫米取整、面积按平方毫米取整（换算平方米为 2 位小数）。
        </p>

        <h3>三、零件明细（按柜体分拣）</h3>
        <div v-for="[cab, list] in cabinetGroups" :key="cab" class="avoid-break">
          <h4>柜体/房间：{{ cab }}（{{ list.reduce((a, r) => a + r.qty, 0) }} 件）</h4>
          <table class="pgrid">
            <thead>
              <tr><th>编号</th><th>名称</th><th>尺寸(mm)</th><th>数量</th><th>纹理</th><th>封边</th><th>见光</th><th>连纹组</th></tr>
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
                <td>{{ g.grainGroupNo ? 'G' + g.grainGroupNo : '' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

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
          <div class="lb-meta">{{ p.cabinet }} ｜ {{ grainText(p.grain) }} ｜ 封边 {{ p.edgeBands.length }} 边{{ p.exposed ? ' ｜ 见光' : '' }}</div>
          <div v-if="p.grainGroupNo" class="lb-grain">
            连纹 G{{ p.grainGroupNo }} 第{{ p.grainSegmentNo }}段 第{{ p.grainOrdinal }}扇 · 同板同方向首尾相接
          </div>
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
.lb-grain {
  margin-top: 1mm;
  font-size: 10.5px;
  font-weight: 700;
  color: #92400e;
  border-top: 1px dashed #b45309;
  padding-top: 1mm;
}
</style>
