import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'
import * as sessionApi from '@renderer/api/sessions'
import { ElMessage } from 'element-plus'
import { useHostStore } from './host'
import { recordConnect } from '@renderer/utils/recent'
import type { Session } from '@renderer/api/types'
import { isTerminalProto, isFileProto, fileSessionType, protocolLabel } from '@renderer/api/types'

export interface Tab {
  id: string
  title: string
  hostId: string
  kind: 'terminal' | 'files'
  session: Session | null
  connecting: boolean
}

export const useSessionStore = defineStore('sessions', () => {
  const tabs = ref<Tab[]>([])
  const activeId = ref<string>('')
  const hostStore = useHostStore()

  const active = () => tabs.value.find((t) => t.id === activeId.value)

  function makeTab(hostId: string, kind: Tab['kind'], title: string): Tab {
    // 必须先 reactive 再入数组:否则局部引用指向原始对象,
    // 后续对 session/connecting 的写入不会触发视图更新
    const tab = reactive<Tab>({
      id: crypto.randomUUID(),
      title,
      hostId,
      kind,
      session: null,
      connecting: true
    })
    tabs.value.push(tab)
    activeId.value = tab.id
    return tab
  }

  async function connect(tab: Tab, type: Session['type']): Promise<void> {
    try {
      const session = tab.hostId
        ? await sessionApi.openSession(tab.hostId, type)
        : await sessionApi.openLocalSession()
      if (!tabs.value.some(t => t.id === tab.id)) {
        await sessionApi.closeSession(session.session_id)
        return
      }
      tab.session = session
      if (tab.hostId) recordConnect(tab.hostId)
    } catch (err) {
      ElMessage.error(`连接失败: ${(err as Error).message}`)
      close(tab.id)
    } finally {
      tab.connecting = false
    }
  }

  async function openLocalTerminal(): Promise<string> {
    const tab = makeTab('', 'terminal', '本地终端')
    await connect(tab, 'terminal')
    return tab.id
  }

  async function openTerminal(hostId: string): Promise<string> {
    const host = hostStore.byId(hostId)
    if (!host || !isTerminalProto(host.protocol)) {
      ElMessage.error('该连接不支持终端')
      return ''
    }
    const name = host.name
    const label = protocolLabel(host?.protocol ?? 'ssh')
    const tab = makeTab(hostId, 'terminal', `${name} · ${label}`)
    await connect(tab, 'terminal')
    return tab.id
  }

  async function openFiles(hostId: string): Promise<string> {
    const host = hostStore.byId(hostId)
    if (!host || !isFileProto(host.protocol)) {
      ElMessage.error('该连接不支持文件管理')
      return ''
    }
    const name = host.name
    const label = protocolLabel(host?.protocol ?? 'sftp')
    const tab = makeTab(hostId, 'files', `${name} · ${label}`)
    await connect(tab, fileSessionType(host?.protocol ?? 'sftp'))
    return tab.id
  }

  /** 按协议决定默认界面:终端类协议开终端,文件类协议开文件管理器 */
  function openDefault(hostId: string): Promise<string> {
    const host = hostStore.byId(hostId)
    if (host && !isTerminalProto(host.protocol)) return openFiles(hostId)
    return openTerminal(hostId)
  }

  function focus(id: string): void {
    activeId.value = id
  }

  function close(id: string): void {
    const tab = tabs.value.find((t) => t.id === id)
    if (tab?.session) {
      const sessionId = tab.session.session_id
      window.shellHelper.detachEdits(sessionId)
        .catch(() => undefined)
        .finally(() => sessionApi.closeSession(sessionId).catch(() => undefined))
    }
    const idx = tabs.value.findIndex((t) => t.id === id)
    if (idx >= 0) {
      tabs.value.splice(idx, 1)
      if (activeId.value === id) {
        activeId.value = tabs.value[Math.max(0, idx - 1)]?.id ?? ''
      }
    }
  }

  return { tabs, activeId, active, openLocalTerminal, openTerminal, openFiles, openDefault, focus, close }
})
