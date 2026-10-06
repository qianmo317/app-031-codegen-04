<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Placement, SheetResult } from '../types'
import { cabinetFill, cabinetStroke, groupHueColor } from '../lib/colors'

const props = withDefaults(
  defineProps<{
    sheet: SheetResult
    /** 当前播放到的步骤序号（含），-1 表示不显示刀路 */
    activeStep?: number
    showCuts?: boolean
    draggable?: boolean
    selectedId?: string | null
    printMode?: boolean
  }>(),
  {
    activeStep: -1,
    showCuts: false,
    draggable: false,
    selectedId: null,
    printMode: false
  }
)

const emit = defineEmits<{
  (e: 'drop', payload: { instanceId: string; xMm: number; yMm: number }): void
  (e: 'select', instanceId: string): void
}>()

const MARGIN = 26
const vb = computed(() => ({
  x: -MARGIN,
  y: -MARGIN - 18,
  w: props.sheet.wMm + MARGIN * 2,
  h: props.sheet.hMm + MARGIN * 2 + 18
}))

interface LabelCfg {
  fontSize: number
  showDims: boolean
  showCode: boolean
}
function label(pw: number, ph: number): LabelCfg {
  const fs = Math.max(0, Math.min(pw / 5.2, ph / 2.4))
  return {
    fontSize: Math.min(40, fs),
    showCode: fs >= 15,
    showDims: pw >= 118 && ph >= 58 && fs >= 20
  }
}

const stepsShown = computed(() => {
  if (props.activeStep < 0) return { done: [], active: null }
  const list = props.sheet.steps
  const upto = Math.min(props.activeStep, list.length - 1)
  return { done: list.slice(0, upto), active: list[upto] ?? null }
})

const trim = computed(() => {
  const st0 = props.sheet.steps.find((s) => s.kind === 'trim')
  if (!st0) return 8
  return Math.round(st0.at)
})

// 拖拽
const dragId = ref<string | null>(null)
const ghost = ref<{ x: number; y: number; w: number; h: number } | null>(null)

// 本板连纹段：按段聚合零件，得到包络框与沿纹理方向（预览图/工单/单据共用同一份段号）
interface StripBox {
  segmentId: string
  groupNo: number
  segmentNo: number
  x: number
  y: number
  w: number
  h: number
  axis: 'x' | 'y'
  members: Placement[]
}
const stripBoxes = computed<StripBox[]>(() => {
  const map = new Map<string, Placement[]>()
  for (const p of props.sheet.placements) {
    if (!p.grainSegmentId) continue
    const arr = map.get(p.grainSegmentId) ?? []
    arr.push(p)
    map.set(p.grainSegmentId, arr)
  }
  const boxes: StripBox[] = []
  for (const [segmentId, members] of map) {
    const ord = [...members].sort((a, b) => (a.grainOrdinal ?? 0) - (b.grainOrdinal ?? 0))
    const x0 = Math.min(...ord.map((p) => p.x))
    const y0 = Math.min(...ord.map((p) => p.y))
    const x1 = Math.max(...ord.map((p) => p.x + p.lenMm))
    const y1 = Math.max(...ord.map((p) => p.y + p.widMm))
    const axis: 'x' | 'y' =
      x1 - x0 >= y1 - y0 || new Set(ord.map((p) => p.y)).size === 1 ? 'x' : 'y'
    boxes.push({
      segmentId,
      groupNo: ord[0].grainGroupNo ?? 0,
      segmentNo: ord[0].grainSegmentNo ?? 1,
      x: x0 - 3,
      y: y0 - 3,
      w: x1 - x0 + 6,
      h: y1 - y0 + 6,
      axis,
      members: ord
    })
  }
  return boxes.sort((a, b) => a.groupNo - b.groupNo || a.segmentNo - b.segmentNo)
})

function clientToMm(e: PointerEvent): { x: number; y: number } {
  const cur = e.currentTarget as Element
  const svg = (cur.tagName.toLowerCase() === 'svg'
    ? cur
    : (cur as SVGElement).ownerSVGElement) as SVGSVGElement | null
  if (!svg) return { x: 0, y: 0 }
  const pt = svg.createSVGPoint()
  pt.x = e.clientX
  pt.y = e.clientY
  const ctm = svg.getScreenCTM()
  if (!ctm) return { x: 0, y: 0 }
  const m = pt.matrixTransform(ctm.inverse())
  return { x: m.x, y: m.y }
}

function onDown(e: PointerEvent, id: string): void {
  if (!props.draggable) return
  ;(e.target as Element).setPointerCapture?.(e.pointerId)
  dragId.value = id
  const p = props.sheet.placements.find((x) => x.instanceId === id)
  if (p) ghost.value = { x: p.x, y: p.y, w: p.lenMm, h: p.widMm }
}
function onMove(e: PointerEvent): void {
  if (!dragId.value || !ghost.value) return
  const m = clientToMm(e)
  ghost.value.x = m.x - ghost.value.w / 2
  ghost.value.y = m.y - ghost.value.h / 2
}
function onUp(e: PointerEvent): void {
  if (!dragId.value) return
  const m = clientToMm(e)
  const g = ghost.value
  const payload = {
    instanceId: dragId.value,
    xMm: g ? m.x - g.w / 2 : m.x,
    yMm: g ? m.y - g.h / 2 : m.y
  }
  emit('drop', payload)
  dragId.value = null
  ghost.value = null
}

function partCursor(): string {
  return props.draggable ? 'grab' : 'default'
}
</script>

<template>
  <svg
    class="sheet-svg"
    :viewBox="`${vb.x} ${vb.y} ${vb.w} ${vb.h}`"
    preserveAspectRatio="xMidYMid meet"
    @pointermove="onMove"
    @pointerup="onUp"
  >
    <!-- 原板 -->
    <rect
      :x="0"
      :y="0"
      :width="sheet.wMm"
      :height="sheet.hMm"
      fill="#fbfaf6"
      stroke="#3d4b45"
      stroke-width="2.4"
    />
    <text
      :x="sheet.wMm / 2"
      :y="-4"
      text-anchor="middle"
      class="board-title"
    >{{ sheet.boardName }} · {{ sheet.wMm }}×{{ sheet.hMm }}×{{ sheet.thicknessMm }}</text>
    <!-- 修边区 -->
    <rect
      :x="trim"
      :y="trim"
      :width="sheet.wMm - 2 * trim"
      :height="sheet.hMm - 2 * trim"
      fill="none"
      stroke="#9aa6a0"
      stroke-width="1"
      stroke-dasharray="6 5"
    />
    <!-- 余料 -->
    <g v-for="(o, i) in sheet.offcuts" :key="'oc' + i">
      <rect
        :x="o.x"
        :y="o.y"
        :width="o.wMm"
        :height="o.hMm"
        :fill="o.usable ? 'rgba(21,128,61,0.10)' : 'rgba(120,120,120,0.06)'"
        :stroke="o.usable ? '#15803d' : '#9aa6a0'"
        stroke-width="1"
        stroke-dasharray="4 3"
      />
      <text
        v-if="o.usable && o.wMm >= 150 && o.hMm >= 70"
        :x="o.x + 5"
        :y="o.y + 18"
        class="oc-label"
      >余料 {{ o.wMm }}×{{ o.hMm }}</text>
    </g>
    <!-- 连纹长条包络框（组号-段号同一份；箭头表示纹理首尾相接方向） -->
    <g v-for="b in stripBoxes" :key="'strip' + b.segmentId">
      <rect
        :x="b.x"
        :y="b.y"
        :width="b.w"
        :height="b.h"
        :fill="groupHueColor(b.groupNo).fill"
        :stroke="groupHueColor(b.groupNo).stroke"
        stroke-width="2.6"
        stroke-dasharray="12 5"
        fill-opacity="0.5"
      />
      <!-- 沿纹理的延续箭头：在每件之间 -->
      <g>
        <template v-for="i in b.members.length - 1" :key="'ar' + i">
          <line
            v-if="b.axis === 'x'"
            :x1="b.members[i].x + b.members[i].lenMm - 9"
            :y1="b.members[i].y + 6"
            :x2="b.members[i].x + b.members[i].lenMm + 11"
            :y2="b.members[i].y + 6"
            :stroke="groupHueColor(b.groupNo).stroke"
            stroke-width="2.4"
            marker-end="url(#grainArrow)"
          />
          <line
            v-else
            :x1="b.members[i].x + 6"
            :y1="b.members[i].y + b.members[i].widMm - 9"
            :x2="b.members[i].x + 6"
            :y2="b.members[i].y + b.members[i].widMm + 11"
            :stroke="groupHueColor(b.groupNo).stroke"
            stroke-width="2.4"
            marker-end="url(#grainArrow)"
          />
        </template>
      </g>
      <text
        :x="b.axis === 'x' ? b.x + 8 : b.x + b.w - 8"
        :y="b.axis === 'x' ? b.y + 18 : b.y + 4"
        :fill="groupHueColor(b.groupNo).text"
        class="strip-tag"
      >G{{ b.groupNo }}-{{ b.segmentNo }} 连纹</text>
    </g>
    <defs>
      <marker id="grainArrow" markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto">
        <path d="M0,0 L6,3 L0,6 Z" fill="#b45309" />
      </marker>
    </defs>
    <!-- 零件 -->
    <g
      v-for="p in sheet.placements"
      :key="p.instanceId"
      :class="{ dragging: dragId === p.instanceId, selected: selectedId === p.instanceId }"
    >
      <rect
        :x="dragId === p.instanceId && ghost ? ghost.x : p.x"
        :y="dragId === p.instanceId && ghost ? ghost.y : p.y"
        :width="p.lenMm"
        :height="p.widMm"
        :fill="cabinetFill(p.cabinet)"
        :stroke="cabinetStroke(p.cabinet)"
        :stroke-width="selectedId === p.instanceId ? 3 : 1.4"
        :style="{ cursor: partCursor() }"
        @pointerdown="onDown($event, p.instanceId)"
        @click="emit('select', p.instanceId)"
      />
      <text
        v-if="dragId !== p.instanceId"
        :x="p.x + p.lenMm / 2"
        :y="p.y + p.widMm / 2 - (label(p.lenMm, p.widMm).showDims ? 6 : 0)"
        text-anchor="middle"
        dominant-baseline="middle"
        class="part-label"
        :font-size="label(p.lenMm, p.widMm).fontSize"
        :font-weight="label(p.lenMm, p.widMm).showDims ? 700 : 600"
        :style="{ cursor: partCursor() }"
        @pointerdown="onDown($event, p.instanceId)"
      >
        <tspan v-if="label(p.lenMm, p.widMm).showCode" x="50%" dy="0">{{ p.code }}</tspan>
        <tspan
          v-if="label(p.lenMm, p.widMm).showDims"
          x="50%"
          :dy="label(p.lenMm, p.widMm).fontSize * 1.15"
          class="part-dims"
        >{{ p.origLen }}×{{ p.origWid }}</tspan>
      </text>
      <circle
        v-if="p.grain !== 'none'"
        :cx="p.x + 7"
        :cy="p.y + 7"
        r="4.2"
        :fill="cabinetStroke(p.cabinet)"
      />
      <text
        v-if="p.grainGroupNo"
        :x="p.x + p.lenMm - 6"
        :y="p.y + 15"
        text-anchor="end"
        class="gcode-tag"
        :fill="groupHueColor(p.grainGroupNo).text"
      >G{{ p.grainGroupNo }}-{{ p.grainSegmentNo }}#{{ p.grainOrdinal }}</text>
      <title>{{ p.code }} {{ p.name }} {{ p.origLen }}×{{ p.origWid }}（{{ p.cabinet }}）</title>
    </g>
    <!-- 刀路播放 -->
    <g v-if="showCuts">
      <line
        v-for="(st, i) in stepsShown.done"
        :key="'d' + i"
        :x1="st.axis === 'v' ? st.at : st.span[0]"
        :y1="st.axis === 'v' ? st.span[0] : st.at"
        :x2="st.axis === 'v' ? st.at : st.span[1]"
        :y2="st.axis === 'v' ? st.span[1] : st.at"
        :stroke="st.grainCross ? '#b45309' : st.kind === 'trim' ? '#a16207' : '#64748b'"
        :stroke-width="st.grainCross ? 2.6 : st.kind === 'trim' ? 1.4 : 1.8"
        :stroke-dasharray="st.grainCross ? '11 4' : '9 5'"
        opacity="0.9"
      />
      <line
        v-if="stepsShown.active"
        :x1="stepsShown.active.axis === 'v' ? stepsShown.active.at : stepsShown.active.span[0]"
        :y1="stepsShown.active.axis === 'v' ? stepsShown.active.span[0] : stepsShown.active.at"
        :x2="stepsShown.active.axis === 'v' ? stepsShown.active.at : stepsShown.active.span[1]"
        :y2="stepsShown.active.axis === 'v' ? stepsShown.active.span[1] : stepsShown.active.at"
        stroke="#dc2626"
        stroke-width="3.4"
        class="active-cut"
      />
    </g>
  </svg>
</template>

<style scoped>
.sheet-svg {
  width: 100%;
  height: auto;
  display: block;
  touch-action: none;
}
.board-title {
  font-size: 20px;
  fill: #5b6b64;
  font-weight: 600;
}
.part-label {
  fill: #1f2a26;
  pointer-events: none;
  user-select: none;
}
.part-dims {
  font-weight: 400;
  fill: #42524b;
}
.oc-label {
  font-size: 15px;
  fill: #15803d;
  pointer-events: none;
}
.strip-tag {
  font-size: 17px;
  font-weight: 700;
  pointer-events: none;
  user-select: none;
}
.gcode-tag {
  font-size: 12px;
  font-weight: 700;
  pointer-events: none;
  user-select: none;
}
.draggable rect:active {
  cursor: grabbing;
}
:global(.dragging) rect {
  opacity: 0.55;
}
.active-cut {
  filter: drop-shadow(0 0 3px rgba(220, 38, 38, 0.7));
  animation: blink 0.7s infinite alternate;
}
@keyframes blink {
  from {
    opacity: 0.65;
  }
  to {
    opacity: 1;
  }
}
@media print {
  .part-label {
    fill: #000;
  }
  .part-dims {
    fill: #000;
  }
}
</style>
