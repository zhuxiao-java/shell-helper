import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { EditItem, OpenFileRequest } from '../../../shared/external'

export const useExternalStore = defineStore('external', () => {
  const items = ref<EditItem[]>([])
  const visible = ref(false)
  const deferred = ref<Record<string, string>>({})
  const confirming = ref(false)
  const pending = computed(() => items.value.filter(item => item.dirty))
  const prompt = computed(() => items.value.find(item => item.dirty && item.status === 'pending' && deferred.value[item.id] !== item.hash))
  async function initialize(): Promise<() => void> {
    const unsubscribe = window.shellHelper.onEditsChanged(next => { items.value = next })
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
  return { items, visible, pending, prompt, confirming, initialize, open, defer, upload, reopen }
})
