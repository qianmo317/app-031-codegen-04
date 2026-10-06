import { reactive } from 'vue'
import { getJob, markGrainIssued } from './store'

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
  printState.jobId = jobId
  printState.sections = sections
  // 导出含领料/下料单即视为「单据已发出」：登记本机版本，
  // 此后分组的件数/顺序一改动，旧分组、旧领料单与旧拼版图即作废重来。
  if (sections.includes('order')) {
    const job = getJob(jobId)
    if (job) markGrainIssued(job)
  }
  // 等打印文档渲染完再唤起打印
  setTimeout(() => window.print(), 60)
}
