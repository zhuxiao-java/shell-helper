import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

export type TransferDirection = 'upload' | 'download'
export interface ResumeDownload {
  sessionId: string
  remotePath: string
  destPath: string
}
export interface TransferTask {
  id: string
  label: string
  direction: TransferDirection
  loaded: number
  total: number
  startedAt: number
  resume?: ResumeDownload
}
export interface TransferRecord extends TransferTask {
  status: 'done' | 'error'
  error?: string
  finishedAt: number
}

export const useTransfersStore = defineStore('transfers', () => {
  const active = ref<Record<string, TransferTask>>({})
  const recent = ref<TransferRecord[]>([])
  let unsubscribe: (() => void) | undefined

  const activeList = computed(() => Object.values(active.value).sort((a, b) => a.startedAt - b.startedAt))
  const activeCount = computed(() => activeList.value.length)
  const recentList = computed(() => recent.value)

  function initialize(): void {
    if (unsubscribe) return
    unsubscribe = window.shellHelper.onTransferProgress(event => {
      const task = active.value[event.id]
      if (!task) return
      task.loaded = event.loaded
      task.total = event.total
    })
  }

  function begin(task: Omit<TransferTask, 'startedAt'> & { startedAt?: number }): void {
    active.value = { ...active.value, [task.id]: { ...task, startedAt: task.startedAt || Date.now() } }
  }

  function complete(id: string): void {
    const task = active.value[id]
    if (!task) return
    recent.value.unshift({ ...task, status: 'done', finishedAt: Date.now() })
    recent.value = recent.value.slice(0, 20)
    const next = { ...active.value }
    delete next[id]
    active.value = next
  }

  function fail(id: string, error: string): void {
    const task = active.value[id]
    if (!task) return
    recent.value.unshift({ ...task, status: 'error', error, finishedAt: Date.now() })
    recent.value = recent.value.slice(0, 20)
    const next = { ...active.value }
    delete next[id]
    active.value = next
  }

  async function retry(record: TransferRecord): Promise<void> {
    if (!record.resume) return
    const id = crypto.randomUUID()
    begin({ id, label: record.label, direction: 'download', loaded: record.loaded, total: record.total, resume: record.resume })
    try {
      await window.shellHelper.downloadTo({ id, ...record.resume, resume: true })
      complete(id)
    } catch (error) {
      fail(id, (error as Error).message || '续传失败')
    }
  }

  function cancel(id: string): void {
    void window.shellHelper.cancelTransfer(id)
  }

  function clearRecent(): void {
    recent.value = []
  }

  function dispose(): void {
    unsubscribe?.()
    unsubscribe = undefined
  }

  return { active, recent, activeList, activeCount, recentList, initialize, begin, complete, fail, retry, cancel, clearRecent, dispose }
})
