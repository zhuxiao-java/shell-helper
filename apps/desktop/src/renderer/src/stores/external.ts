import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { EditItem, OpenFileRequest } from '../../../shared/external'
import { useLanStore } from './lan'

export const useExternalStore = defineStore('external', () => {
  const lan = useLanStore()
  const items = ref<EditItem[]>([])
  const visible = ref(false)
  const deferred = ref<Record<string, string>>({})
  const confirming = ref(false)
  const pending = computed(() => items.value.filter(item => item.dirty))
  const prompt = computed(() => items.value.find(item => item.dirty && item.status === 'pending' && deferred.value[item.id] !== item.hash))
  const conflict = computed(() => items.value.find(item => item.status === 'conflict' && item.dirty))
  function apply(next: EditItem[]): void {
    const previous = new Map(items.value.map(item => [item.id, item]))
    items.value = next
    for (const item of next) {
      const before = previous.get(item.id)
      if (item.status === 'conflict' && before?.status !== 'conflict') {
        ElMessage.warning(`远程文件已被其他人修改：${item.remotePath}。本地修改仍保留。`)
      } else if (item.message === '已同步远程更新' && (before?.message !== item.message || (before && before.hash !== item.hash))) {
        ElMessage.info(`远程文件已更新：${item.remotePath}。若编辑器未自动刷新，请点击“打开本地副本”。`)
      }
    }
  }
  async function initialize(): Promise<() => void> {
    const unsubscribe = window.shellHelper.onEditsChanged(next => { apply(next) })
    items.value = await window.shellHelper.listEdits()
    if (items.value.length) ElMessage.info('已恢复外部编辑副本，可从顶栏“外部编辑”打开')
    return unsubscribe
  }
  async function open(input: OpenFileRequest): Promise<void> {
    try { items.value = await window.shellHelper.openFile(input) }
    catch (error) {
      ElMessage.error((error as Error).message)
      items.value = await window.shellHelper.listEdits()
      visible.value = true
    }
  }
  function defer(item: EditItem): void { deferred.value[item.id] = item.hash }
  async function upload(item: EditItem): Promise<void> {
    if (confirming.value) return
    confirming.value = true
    try {
      items.value = await window.shellHelper.listEdits()
      const current = items.value.find(d => d.id === item.id)
      if (!current?.dirty || !current.sessionId) throw new Error('文件没有待回传修改或连接已断开')
      const confirmedHash = current.hash
      await ElMessageBox.confirm(`将本地修改回传到 ${current.hostName}\n${current.remotePath}\n回传前会检查远程冲突。`, '确认回传远程文件', {
        confirmButtonText: '回传远程', cancelButtonText: '稍后处理', type: 'warning', distinguishCancelAndClose: true
      })
      await window.shellHelper.uploadEdit(current.id, confirmedHash)
      void lan.notifyFile({ hostName: current.hostName, path: current.remotePath, action: 'modified' })
      ElMessage.success('该版本已回传')
    } catch (error) {
      if (error === 'cancel' || error === 'close') defer(item)
      else ElMessage.error((error as Error).message)
    } finally {
      confirming.value = false
      items.value = await window.shellHelper.listEdits()
    }
  }
  async function reopen(id: string, useDefault = false): Promise<void> {
    try { await window.shellHelper.reopenEdit(id, useDefault) }
    catch (error) { ElMessage.error((error as Error).message) }
  }
  async function reload(id: string): Promise<void> {
    try {
      await ElMessageBox.confirm(
        '将用远程最新内容覆盖本地副本，当前未回传的修改会丢失。',
        '用远程版本覆盖本地',
        { type: 'warning', confirmButtonText: '覆盖本地', cancelButtonText: '取消' }
      )
      items.value = await window.shellHelper.reloadEdit(id)
      ElMessage.success('已更新本地副本')
    } catch (error) {
      if (error !== 'cancel' && error !== 'close') ElMessage.error((error as Error).message)
    }
  }
  return { items, visible, pending, prompt, conflict, confirming, initialize, open, defer, upload, reopen, reload }
})
