import { reactive } from 'vue'
import { getJob, markCurrentOrderIssued } from './store'
import { grainInputSignature } from './packing'

export type PrintSection = 'nest' | 'cut' | 'order' | 'labels'

interface PrintState {
  jobId: string | null
  sections: PrintSection[]
}

export const printState = reactive<PrintState>({
  jobId: null,
  sections: ['nest', 'cut', 'order', 'labels']
})

export function printJob(jobId: string, sections: PrintSection[]): void {
  const job = getJob(jobId)
  // 领料/下料内容一旦进入打印导出，即记为本机已发单据；下次改组会把该版整体作废。
  if (
    job &&
    (sections.includes('order') || sections.includes('labels')) &&
    job.result?.grain.inputSignature !== grainInputSignature(job)
  ) {
    window.alert('连纹组或取舍策略已改动，当前拼版图/单据是旧版。请先重新排样，再导出领料单据。')
    return
  }
  if (job && (sections.includes('order') || sections.includes('labels'))) {
    markCurrentOrderIssued(job)
  }
  printState.jobId = jobId
  printState.sections = sections
  // 等打印文档渲染完再唤起打印
  setTimeout(() => window.print(), 60)
}
