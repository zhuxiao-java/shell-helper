import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { ElMessage } from 'element-plus'
import type { LanEvent, LanFileNotice, LanShareResult, LanState, SharedHost } from '../../../shared/lan'

const EMPTY: LanState = {
  enabled: false,
  profile: { id: '', name: '', device: '' },
  peers: [],
  events: [],
  terminals: []
}

function actionLabel(event: LanEvent): string {
  return { created: '新建了', modified: '修改了', renamed: '重命名了', deleted: '删除了' }[event.action || 'modified'] || '修改了'
}

export const useLanStore = defineStore('lan', () => {
  const state = ref<LanState>({ ...EMPTY })
  const error = ref('')
  const ready = ref(false)
  let unsubscribe: (() => void) | undefined
  let initialized = false

  const peers = computed(() => state.value.peers)
  const events = computed(() => state.value.events)
  const terminals = computed(() => state.value.terminals || [])
  const profile = computed(() => state.value.profile)
  const enabled = computed(() => state.value.enabled)
  const onlineCount = computed(() => state.value.peers.length)
  const unread = computed(() => state.value.events.filter(event => !event.read).length)

  function apply(next: LanState, notify = true): void {
    const previous = new Set(state.value.events.map(event => event.id))
    state.value = { ...next, terminals: next.terminals || [] }
    error.value = next.error || ''
    if (!notify) return
    for (const event of next.events) {
      if (previous.has(event.id) || event.read) continue
      if (event.kind === 'share') {
        ElMessage.info(`${event.fromName} 分享了连接「${event.host?.name || '未命名连接'}」`)
      } else {
        ElMessage.info(`${event.fromName} ${actionLabel(event)} ${event.hostName || '远程文件'}：${event.path || ''}`)
      }
    }
  }

  async function initialize(): Promise<void> {
    if (initialized) return
    initialized = true
    try {
      apply(await window.shellHelper.lanState(), false)
      unsubscribe = window.shellHelper.onLanUpdate(next => apply(next))
      ready.value = true
    } catch (err) {
      error.value = (err as Error).message || '无法连接局域网服务'
    }
  }

  async function setEnabled(value: boolean): Promise<void> {
    try { apply(await window.shellHelper.setLanEnabled(value), false) }
    catch (err) { error.value = (err as Error).message || '无法切换局域网发现' }
  }

  async function setName(value: string): Promise<void> {
    const name = value.trim()
    if (!name) return
    try { apply(await window.shellHelper.setLanName(name), false) }
    catch (err) { error.value = (err as Error).message || '无法更新显示名' }
  }

  async function setAvatar(avatar: string): Promise<void> {
    try { apply(await window.shellHelper.setLanAvatar(avatar), false) }
    catch (err) { error.value = (err as Error).message || '无法更新头像' }
  }

  async function shareHost(targetId: string, host: SharedHost): Promise<LanShareResult> {
    try {
      const result = await window.shellHelper.shareLanHost(targetId, host)
      if (!result.ok) error.value = result.error || '分享失败'
      return result
    } catch (err) {
      const message = (err as Error).message || '分享失败'
      error.value = message
      return { ok: false, error: message }
    }
  }

  async function notifyFile(input: LanFileNotice): Promise<void> {
    if (!state.value.enabled) return
    try { await window.shellHelper.notifyLanFile(input) } catch { /* 局域网通知失败不影响文件操作 */ }
  }

  async function startTerminalShare(input: { title: string; hostName: string }): Promise<string> {
    const id = await window.shellHelper.startLanTerminalShare(input)
    apply(await window.shellHelper.lanState(), false)
    return id
  }

  async function stopTerminalShare(id: string): Promise<void> {
    await window.shellHelper.stopLanTerminalShare(id)
    apply(await window.shellHelper.lanState(), false)
  }

  async function joinTerminal(id: string): Promise<void> {
    await window.shellHelper.joinLanTerminal(id)
    apply(await window.shellHelper.lanState(), false)
  }

  async function leaveTerminal(id: string): Promise<void> {
    await window.shellHelper.leaveLanTerminal(id)
    apply(await window.shellHelper.lanState(), false)
  }

  function sendTerminalOutput(id: string, data: string): void {
    if (!state.value.enabled) return
    void window.shellHelper.sendLanTerminalOutput(id, data).catch(() => undefined)
  }

  function onTerminalOutput(callback: (payload: { id: string; data: string }) => void): () => void {
    return window.shellHelper.onLanTerminalOutput(callback)
  }

  async function markRead(): Promise<void> {
    try { apply(await window.shellHelper.markLanRead(), false) }
    catch (err) { error.value = (err as Error).message || '无法标记已读' }
  }

  function dispose(): void {
    unsubscribe?.()
    unsubscribe = undefined
    initialized = false
  }

  return { state, error, ready, peers, events, terminals, profile, enabled, onlineCount, unread, initialize, setEnabled, setName, setAvatar, shareHost, notifyFile, startTerminalShare, stopTerminalShare, joinTerminal, leaveTerminal, sendTerminalOutput, onTerminalOutput, markRead, dispose }
})
