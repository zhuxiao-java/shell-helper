<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useHostStore } from '@renderer/stores/host'
import { useLanStore } from '@renderer/stores/lan'
import { useTransfersStore } from '@renderer/stores/transfers'
import { useTerminalBus } from '@renderer/stores/terminalBus'
import { useRemoteAssistStore } from '@renderer/stores/remoteAssist'
import { useSessionStore } from '@renderer/stores/session'
import HostPanel from '@renderer/components/HostPanel.vue'
import TabBar from '@renderer/components/TabBar.vue'
import TerminalView from '@renderer/components/TerminalView.vue'
import FileManager from '@renderer/components/FileManager.vue'
import HostFormDialog from '@renderer/components/HostFormDialog.vue'
import LanPanel from '@renderer/components/LanPanel.vue'
import ShareLanDialog from '@renderer/components/ShareLanDialog.vue'
import TunnelDialog from '@renderer/components/TunnelDialog.vue'
import SharedTerminalDialog from '@renderer/components/SharedTerminalDialog.vue'
import WorkspaceDialog from '@renderer/components/WorkspaceDialog.vue'
import RemoteAssistDialog from '@renderer/components/RemoteAssistDialog.vue'
import TransferCenter from '@renderer/components/TransferCenter.vue'
import { ensureConn } from '@renderer/api/client'
import { getRecents } from '@renderer/utils/recent'
import { isFileProto, isTerminalProto, type Host, type Protocol } from '@renderer/api/types'
import { useSettingsStore } from '@renderer/stores/settings'
import { useExternalStore } from '@renderer/stores/external'
import SettingsDialog from '@renderer/components/SettingsDialog.vue'
import ExternalEdits from '@renderer/components/ExternalEdits.vue'
import { hasDialog, installShortcuts } from '@renderer/utils/shortcuts'
import CommandPalette from '@renderer/components/CommandPalette.vue'
import StartupScreen from '@renderer/components/StartupScreen.vue'
import { fileBridges, sessionMeta, terminalBridges } from '@renderer/utils/workspace'
import { validCommand, type ActionId, type TerminalCommand } from '../../shared/settings'

const hostStore = useHostStore()
const lan = useLanStore()
const transfers = useTransfersStore()
const terminalBus = useTerminalBus()
const remoteAssist = useRemoteAssistStore()
const sessionStore = useSessionStore()
const backendReady = ref(false)
const insetTitlebar = new URLSearchParams(window.location.search).get('titlebar') === 'inset'
const startup = reactive({
  state: 'loading' as 'loading' | 'error',
  message: '正在准备界面…',
  detail: '',
  error: '',
  step: 0,
  done: false
})
const formVisible = ref(false)
const lanVisible = ref(false)
const shareVisible = ref(false)
const shareHost = ref<Host | null>(null)
const transferCenterVisible = ref(false)
const tunnelVisible = ref(false)
const tunnelHost = ref<Host | null>(null)
const sharedTerminal = ref<import('../../shared/lan').SharedTerminal | null>(null)
const sharedTerminalVisible = ref(false)
const workspaceVisible = ref(false)
const editingHost = ref<Host | null>(null)
const version = ref('')
const initialProtocol = ref<Protocol>('ssh')
const initialHostAddress = ref('')
const composerQuery = ref('')
const composerFocused = ref(false)
const composerActive = ref(-1)
const composerInput = ref<HTMLInputElement>()
const settings = useSettingsStore()
const external = useExternalStore()
const hostPanel = ref<InstanceType<typeof HostPanel>>()
const confirmingCommand = ref(false)
const paletteOpen = ref(false)
interface SavedTab { hostId: string; kind: 'terminal' | 'files'; title: string }
function readSavedTabs(): SavedTab[] {
  try {
    const parsed = JSON.parse(localStorage.getItem('shell-helper:open-tabs') || '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is SavedTab => !!item && typeof item === 'object' && (item.kind === 'terminal' || item.kind === 'files') && typeof item.hostId === 'string' && typeof item.title === 'string')
  } catch { return [] }
}
const savedTabs = readSavedTabs()
let persistTabs = false
const commandAvailable = computed(() => activeTab.value?.kind === 'terminal' && !!terminalBridges.get(sessionStore.activeId)?.ready())
let disposeShortcuts: (() => void) | undefined
let disposeEdits: (() => void) | undefined
let initializing = false
let editsInitialized = false

const activeTab = computed(() => sessionStore.active())
const activeDetail = computed<{ label: string; value: string } | null>(() => {
  const tab = activeTab.value
  if (!tab) return null
  if (tab.kind === 'terminal') {
    const size = sessionMeta.terminal[tab.id]
    return size ? { label: '终端', value: `${size.cols} × ${size.rows}` } : null
  }
  const path = sessionMeta.path[tab.id]
  return path ? { label: '路径', value: path } : null
})
const themeQuery = window.matchMedia('(prefers-color-scheme: dark)')
function applyAppearance(): void {
  const mode = settings.value.appearance
  document.documentElement.classList.toggle('theme-dark', mode === 'dark' || (mode === 'system' && themeQuery.matches))
}
const terminalTabs = computed(() => sessionStore.tabs.filter((t) => t.kind === 'terminal'))
const splitEnabled = ref(false)
const splitTabId = ref('')
const splitTab = computed(() => terminalTabs.value.find(tab => tab.id === splitTabId.value))
const canSplit = computed(() => activeTab.value?.kind === 'terminal' && terminalTabs.value.some(tab => tab.id !== sessionStore.activeId))
function toggleSplit(): void {
  if (splitEnabled.value) { splitEnabled.value = false; splitTabId.value = ''; terminalBus.broadcast = false; return }
  const candidate = terminalTabs.value.find(tab => tab.id !== sessionStore.activeId)
  if (!candidate) return
  splitTabId.value = candidate.id
  splitEnabled.value = true
}
watch(() => [sessionStore.activeId, terminalTabs.value.map(tab => tab.id).join(',')] as const, () => {
  if (!splitEnabled.value) return
  if (activeTab.value?.kind !== 'terminal') { splitEnabled.value = false; splitTabId.value = ''; terminalBus.broadcast = false; return }
  if (splitTabId.value === sessionStore.activeId || !terminalTabs.value.some(tab => tab.id === splitTabId.value)) {
    const next = terminalTabs.value.find(tab => tab.id !== sessionStore.activeId)
    if (!next) { splitEnabled.value = false; splitTabId.value = ''; terminalBus.broadcast = false } else splitTabId.value = next.id
  }
})
const fileTabs = computed(() => sessionStore.tabs.filter((t) => t.kind === 'files'))

// 当前工作区标题(无活动会话时为“工作台”)
const workspaceName = computed(() => activeTab.value?.title ?? '工作台')
const activeHost = computed(() => activeTab.value?.hostId ? hostStore.byId(activeTab.value.hostId) : null)
const activeProtocolLabel = computed(() => {
  const tab = activeTab.value
  if (!tab) return ''
  if (!tab.hostId) return 'LOCAL'
  return (activeHost.value?.protocol ?? (tab.kind === 'files' ? 'sftp' : 'ssh')).toUpperCase()
})
const activeState = computed(() => {
  const tab = activeTab.value
  if (!tab) return backendReady.value ? '本地服务已就绪' : '本地服务未连接'
  if (tab.connecting) return '连接中'
  if (tab.error) return '连接失败'
  if (!tab.session) return '等待连接'
  if (tab.session.status === 'closed') return '已断开'
  return '已连接'
})
const activeStateTone = computed(() => {
  const tab = activeTab.value
  if (!tab) return backendReady.value ? 'ok' : 'err'
  if (tab.connecting) return 'pending'
  if (tab.error) return 'err'
  if (!tab.session) return 'pending'
  return tab.session.status === 'closed' ? 'off' : 'ok'
})
const activeSubtitle = computed(() => {
  const tab = activeTab.value
  if (!tab) {
    return hostStore.hosts.length
      ? '从左侧选择连接，或在下方输入主机名 / 地址快速连接'
      : '添加第一台连接，开始远程工作'
  }
  if (!tab.hostId) return '本地终端 · 此电脑'
  return activeHost.value ? hostAddress(activeHost.value) : tab.title
})

// ---- 侧栏显隐与宽度(持久化到 localStorage,失败不阻断) ----
const SIDEBAR_W_KEY = 'shell-helper:sidebar-width'
const SIDEBAR_VIS_KEY = 'shell-helper:sidebar-visible'
const MIN_W = 220
const MAX_W = 360
const DEFAULT_W = 260

const sidebarVisible = ref(true)
const sidebarWidth = ref(DEFAULT_W)
const resizing = ref(false)

function loadSidebarPrefs(): void {
  try {
    const w = Number(localStorage.getItem(SIDEBAR_W_KEY))
    if (w >= MIN_W && w <= MAX_W) sidebarWidth.value = w
    sidebarVisible.value = localStorage.getItem(SIDEBAR_VIS_KEY) !== '0'
  } catch {
    /* 忽略读取异常 */
  }
}

function saveSidebarPrefs(): void {
  try {
    localStorage.setItem(SIDEBAR_W_KEY, String(sidebarWidth.value))
    localStorage.setItem(SIDEBAR_VIS_KEY, sidebarVisible.value ? '1' : '0')
  } catch {
    /* 隐私模式等写入失败不阻断使用 */
  }
}

function toggleSidebar(): void {
  sidebarVisible.value = !sidebarVisible.value
  saveSidebarPrefs()
}

function onResizeStart(e: MouseEvent): void {
  e.preventDefault()
  resizing.value = true
  const startX = e.clientX
  const startW = sidebarWidth.value
  const onMove = (ev: MouseEvent): void => {
    const next = startW + (ev.clientX - startX)
    sidebarWidth.value = Math.min(MAX_W, Math.max(MIN_W, next))
  }
  const onUp = (): void => {
    resizing.value = false
    saveSidebarPrefs()
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

// 最近连接(将 id 映射为现存主机,自动忽略已删除项)
const recentItems = ref(getRecents())
const recents = computed(() => recentItems.value
  .map((r) => ({ host: hostStore.byId(r.hostId), ts: r.ts }))
  .filter((x): x is { host: Host; ts: number } => !!x.host)
  .slice(0, 5))
const startConnections = computed(() => recents.value.length
  ? recents.value
  : hostStore.hosts.slice(0, 5).map((host) => ({ host, ts: 0 })))

function reloadRecents(): void {
  recentItems.value = getRecents()
}

function hostAddress(host: Host): string {
  return host.protocol === 'local' ? '此电脑 · 默认 Shell' : `${host.username}@${host.host}:${host.port}`
}

const composerMatches = computed(() => {
  const text = composerQuery.value.trim().toLowerCase()
  if (!text) return []
  return hostStore.hosts
    .filter(host => `${host.name} ${host.host} ${host.tags} ${host.group}`.toLowerCase().includes(text))
    .slice(0, 6)
})
const composerOpen = computed(() => composerFocused.value && !!composerQuery.value.trim())
const composerActiveId = computed(() => {
  const host = composerMatches.value[composerActive.value]
  return host ? `composer-option-${host.id}` : undefined
})
watch(composerQuery, () => { composerActive.value = -1 })

function onComposerKey(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    if (!composerMatches.value.length) return
    event.preventDefault()
    composerActive.value = (composerActive.value + 1) % composerMatches.value.length
  } else if (event.key === 'ArrowUp') {
    if (!composerMatches.value.length) return
    event.preventDefault()
    composerActive.value = composerActive.value <= 0 ? composerMatches.value.length - 1 : composerActive.value - 1
  } else if (event.key === 'Enter') {
    event.preventDefault()
    submitComposer()
  } else if (event.key === 'Escape') {
    composerFocused.value = false
    composerInput.value?.blur()
  }
}

function chooseComposer(host: Host): void {
  composerQuery.value = ''
  composerFocused.value = false
  composerInput.value?.blur()
  void sessionStore.openDefault(host.id)
}

function submitComposer(): void {
  const query = composerQuery.value.trim()
  if (!query) return
  const host = composerMatches.value[composerActive.value] ?? composerMatches.value[0]
  if (host) {
    chooseComposer(host)
    return
  }
  // 没匹配到已保存连接时，把输入作为主机地址带进新建表单
  composerQuery.value = ''
  composerFocused.value = false
  composerInput.value?.blur()
  openForm(null, 'ssh', query)
}

function relTime(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

function startRemoteAssist(peer: import('../../shared/lan').LanPeer): void {
  lanVisible.value = false
  remoteAssist.invite(peer)
}

function openSharedTerminal(terminal: import('../../shared/lan').SharedTerminal): void {
  sharedTerminal.value = terminal
  sharedTerminalVisible.value = true
}

function openTunnelHost(host: Host | null = null): void {
  tunnelHost.value = host
  tunnelVisible.value = true
}

function openShareHost(host: Host | null = null): void {
  shareHost.value = host
  shareVisible.value = true
}

function openForm(host: Host | null = null, protocol: Protocol = 'ssh', initialHost = ''): void {
  editingHost.value = host
  initialProtocol.value = protocol
  initialHostAddress.value = initialHost
  formVisible.value = true
}

function action(id: ActionId): boolean {
  if (id === 'newConnection') openForm()
  else if (id === 'openSettings') settings.visible = true
  else if (id === 'toggleSidebar') toggleSidebar()
  else if (id === 'searchConnections') {
    sidebarVisible.value = true
    saveSidebarPrefs()
    void nextTick(() => hostPanel.value?.focusSearch())
  } else if (id === 'goHome') sessionStore.focus('')
  else if (id === 'closeTab') {
    if (!sessionStore.activeId) return false
    sessionStore.close(sessionStore.activeId)
  } else if (id === 'previousTab' || id === 'nextTab') {
    const ids = ['', ...sessionStore.tabs.map(tab => tab.id)]
    const index = ids.indexOf(sessionStore.activeId)
    sessionStore.focus(ids[(index + (id === 'nextTab' ? 1 : -1) + ids.length) % ids.length])
  } else {
    const files = fileBridges.get(sessionStore.activeId)
    if (!files || activeTab.value?.kind !== 'files') return false
    if (id === 'refreshFiles') files.refresh()
    else files.openSelected()
  }
  return true
}

function requestCommand(command: TerminalCommand): boolean {
  const tab = activeTab.value
  const bridge = tab && terminalBridges.get(tab.id)
  if (!tab || tab.kind !== 'terminal' || !bridge?.ready() || confirmingCommand.value || !command.enabled || !validCommand(command.command)) return false
  const text = command.command
  const host = hostStore.byId(tab.hostId)
  let cancelled = false
  const stop = watch(() => [sessionStore.activeId, bridge.ready(), sessionStore.tabs.includes(tab)], () => { cancelled = true }, { flush: 'sync' })
  confirmingCommand.value = true
  void (async () => {
    try {
      await ElMessageBox.confirm(`目标：${host?.name || tab.title} · ${host ? hostAddress(host) : ''}\n命令：${text}\n仅插入，不自动执行；请检查已有输入并自行按 Enter。`, '确认插入终端命令', {
        confirmButtonText: '插入终端', cancelButtonText: '取消', type: 'warning'
      })
      if (cancelled || sessionStore.activeId !== tab.id || terminalBridges.get(tab.id) !== bridge || !bridge.insert(text)) {
        ElMessage.warning('目标已切换、关闭或断开，已取消插入')
      }
    } catch { /* 用户取消。 */ }
    finally { stop(); confirmingCommand.value = false }
  })()
  return true
}

async function openStartupLogs(): Promise<void> {
  try {
    await window.shellHelper.openStorageLocation('logs')
  } catch (error) {
    ElMessage.error((error as Error).message || '无法打开日志目录')
  }
}

function startupErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '未知错误')
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^Error:\s*/, '')
}

async function restoreSavedTabs(): Promise<void> {
  if (!savedTabs.length) return
  try {
    await ElMessageBox.confirm(`恢复上次打开的 ${savedTabs.length} 个标签？`, '恢复会话', { confirmButtonText: '恢复', cancelButtonText: '不恢复' })
    for (const item of savedTabs) {
      const before = sessionStore.tabs.length
      if (!item.hostId && item.kind === 'terminal') await sessionStore.openLocalTerminal()
      else if (item.kind === 'files') await sessionStore.openFiles(item.hostId)
      else if (item.hostId) await sessionStore.openTerminal(item.hostId)
      // 只有确实新建了标签才改名，避免打开失败时改到上一个标签
      if (sessionStore.tabs.length > before) {
        const tab = sessionStore.tabs.at(-1)
        if (tab && item.title) sessionStore.rename(tab.id, item.title)
      }
    }
  } catch { /* 不恢复 */ }
}

async function initializeApp(): Promise<void> {
  if (initializing) return
  initializing = true
  const startedAt = Date.now()
  startup.state = 'loading'
  startup.message = '正在准备界面…'
  startup.detail = ''
  startup.error = ''
  startup.step = 0
  startup.done = false
  backendReady.value = false
  try {
    startup.message = '正在读取应用设置…'
    await settings.load()
    await lan.initialize()
    remoteAssist.initialize()
    transfers.initialize()

    startup.step = 1
    startup.message = '正在恢复编辑草稿…'
    if (!editsInitialized) {
      editsInitialized = true
      try { disposeEdits = await external.initialize() }
      catch (error) { ElMessage.error(`草稿恢复失败：${(error as Error).message}`) }
    }

    startup.step = 2
    startup.message = '正在启动本地服务…'
    startup.detail = '本地 Python 服务正在启动，首次启动可能需要几秒钟。'
    await ensureConn()

    startup.step = 3
    startup.message = '正在加载连接…'
    startup.detail = ''
    try {
      await hostStore.refresh()
      reloadRecents()
    } catch (error) {
      ElMessage.error(`连接加载失败：${(error as Error).message}`)
    }

    try {
      version.value = await window.shellHelper.getVersion()
    } catch {
      /* 版本号不影响启动 */
    }

    // 给启动界面一个最短展示时间，避免一闪而过
    const remaining = 1600 - (Date.now() - startedAt)
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
    backendReady.value = true
    startup.done = true
    await nextTick()
    await restoreSavedTabs()
    persistTabs = true
  } catch (error) {
    console.error('启动失败', error)
    startup.state = 'error'
    startup.error = startupErrorMessage(error)
  } finally {
    initializing = false
  }
}

function retryStartup(): void {
  if (!initializing) void initializeApp()
}

onMounted(async () => {
  applyAppearance()
  themeQuery.addEventListener('change', applyAppearance)
  loadSidebarPrefs()
  disposeShortcuts = installShortcuts({
    settings: () => settings.value, mac: settings.mac,
    blocked: () => !settings.ready || settings.recording || settings.visible || formVisible.value || external.visible || confirmingCommand.value || paletteOpen.value || !startup.done,
    action, command: requestCommand
  })
  await initializeApp()
})

function onPaletteKey(event: KeyboardEvent): void {
  if (event.repeat || event.isComposing || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) return
  const target = event.target as HTMLElement | null
  if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return
  if (settings.recording || hasDialog() || paletteOpen.value || confirmingCommand.value) return
  event.preventDefault()
  paletteOpen.value = true
}

watch(() => sessionStore.tabs.map(tab => ({ hostId: tab.hostId, kind: tab.kind, title: tab.title })), (items) => {
  if (!persistTabs) return
  try { localStorage.setItem('shell-helper:open-tabs', JSON.stringify(items)) } catch { /* 隐私模式写入失败不阻断 */ }
}, { deep: true })
onMounted(() => window.addEventListener('keydown', onPaletteKey, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onPaletteKey, true))

onBeforeUnmount(() => { themeQuery.removeEventListener('change', applyAppearance); disposeShortcuts?.(); disposeEdits?.() })
watch(() => settings.value.appearance, applyAppearance)

// 回到欢迎页(无活动会话)时刷新最近连接
watch(
  () => sessionStore.activeId,
  (id) => {
    if (!id) reloadRecents()
  }
)
</script>

<template>
  <div class="sh-app" :class="{ 'is-inset': insetTitlebar }">
    <!-- 顶部应用栏 -->
    <header class="sh-header">
      <div class="brand">
        <div class="brand-logo" aria-hidden="true">›_</div>
        <span class="brand-name">Shell Helper</span>
      </div>
      <div class="header-actions">
        <el-dropdown v-if="commandAvailable" trigger="click" @command="(id: string) => { const cmd = settings.value.commands.find(c => c.id === id); if (cmd) requestCommand(cmd) }">
          <button class="header-new" aria-label="终端命令">终端命令 <el-icon><ArrowDown /></el-icon></button>
          <template #dropdown><el-dropdown-menu>
            <el-dropdown-item v-for="cmd in settings.value.commands.filter(c => c.enabled)" :key="cmd.id" :command="cmd.id">{{ cmd.name }}</el-dropdown-item>
            <el-dropdown-item v-if="!settings.value.commands.some(c => c.enabled)" disabled>请在设置中添加命令</el-dropdown-item>
          </el-dropdown-menu></template>
        </el-dropdown>
        <button v-if="!sidebarVisible" class="icon-btn" aria-label="新建连接" :title="`新建连接 ${settings.hint('newConnection')}`" @click="openForm()"><el-icon><Plus /></el-icon></button>
        <button class="icon-btn" aria-label="打开工作区" title="工作区" @click="workspaceVisible = true"><el-icon><FolderOpened /></el-icon></button>
        <button v-if="canSplit || splitEnabled" class="icon-btn" :class="{ 'split-active': splitEnabled }" aria-label="切换终端分屏" :title="splitEnabled ? '退出终端分屏' : '终端分屏'" @click="toggleSplit"><el-icon><Grid /></el-icon></button>
        <el-tooltip :content="`局域网 · ${lan.onlineCount} 人在线`">
          <button class="icon-btn lan-trigger" aria-label="打开局域网面板" :title="`局域网 · ${lan.onlineCount} 人在线`" @click="lanVisible = true">
            <el-icon><Connection /></el-icon>
            <span v-if="lan.onlineCount" class="lan-count">{{ lan.onlineCount > 9 ? '9+' : lan.onlineCount }}</span>
            <span v-if="lan.unread" class="lan-unread" aria-hidden="true"></span>
          </button>
        </el-tooltip>
        <el-tooltip :content="transfers.activeCount ? `传输 · ${transfers.activeCount} 个进行中` : '传输中心'">
          <button class="icon-btn transfer-trigger" aria-label="打开传输中心" :title="transfers.activeCount ? `传输 · ${transfers.activeCount} 个进行中` : '传输中心'" @click="transferCenterVisible = true">
            <el-icon><Download /></el-icon>
            <span v-if="transfers.activeCount" class="transfer-count">{{ transfers.activeCount > 9 ? '9+' : transfers.activeCount }}</span>
          </button>
        </el-tooltip>
        <button class="header-new" aria-label="外部编辑" @click="external.visible = true"><el-icon><EditPen /></el-icon>外部编辑{{ external.pending.length ? ` · ${external.pending.length}` : '' }}</button>
        <button class="icon-btn" aria-label="打开本地终端" title="打开本地终端" :disabled="!backendReady" @click="sessionStore.openLocalTerminal()"><el-icon><Monitor /></el-icon></button>
        <button class="icon-btn" aria-label="打开设置" :title="`设置 ${settings.hint('openSettings')}`" @click="settings.visible = true"><el-icon><Setting /></el-icon></button>
        <el-tooltip :content="`${sidebarVisible ? '隐藏侧栏' : '显示侧栏'} ${settings.hint('toggleSidebar')}`">
          <button class="icon-btn" :aria-label="sidebarVisible ? '隐藏侧栏' : '显示侧栏'" :aria-pressed="sidebarVisible" @click="toggleSidebar">
            <el-icon><Fold v-if="sidebarVisible" /><Expand v-else /></el-icon>
          </button>
        </el-tooltip>
      </div>
    </header>

    <div class="sh-body">
      <!-- 侧边主机栏 -->
      <aside
        v-show="sidebarVisible"
        class="sh-sidebar"
        :style="{ width: sidebarWidth + 'px' }"
      >
        <HostPanel
          @share-host="openShareHost"
          @tunnel-host="openTunnelHost"
          ref="hostPanel"
          @new-host="openForm()"
          @edit-host="openForm"
          @open-terminal="(id: string) => sessionStore.openTerminal(id)"
          @open-files="(id: string) => sessionStore.openFiles(id)"
          @open-default="(id: string) => sessionStore.openDefault(id)"
        />
        <div
          class="sidebar-resizer"
          :class="{ active: resizing }"
          @mousedown="onResizeStart"
        ></div>
      </aside>

      <!-- 主内容区 -->
      <main class="sh-main" :class="{ 'sidebar-hidden': !sidebarVisible }">
        <header class="main-header">
          <div class="main-heading">
            <span class="main-title" :title="workspaceName">{{ workspaceName }}</span>
            <span class="main-subtitle" :title="activeSubtitle">{{ activeSubtitle }}</span>
          </div>
          <div class="main-status">
            <template v-if="activeTab">
              <span class="main-chip proto-chip" :class="activeHost ? `proto-${activeHost.protocol}` : 'proto-local'">{{ activeProtocolLabel }}</span>
              <span class="main-chip state-chip" :class="`state-${activeStateTone}`"><i aria-hidden="true"></i>{{ activeState }}</span>
              <span v-if="activeDetail" class="main-chip detail-chip" :title="`${activeDetail.label}：${activeDetail.value}`">
                <span>{{ activeDetail.label }}</span><b>{{ activeDetail.value }}</b>
              </span>
            </template>
            <template v-else>
              <span class="main-chip">连接库 {{ hostStore.hosts.length }}</span>
              <span class="main-chip state-chip" :class="`state-${backendReady ? 'ok' : 'err'}`"><i aria-hidden="true"></i>{{ backendReady ? '本地服务已就绪' : '本地服务未连接' }}</span>
            </template>
          </div>
        </header>
        <TabBar />

        <!-- 起始页 / 工作台(无活动会话) -->
        <section id="panel-home" v-show="!sessionStore.activeId" class="workbench" role="tabpanel" aria-labelledby="tab-home">
          <div class="wb-scroll">
            <div class="wb-inner">
              <div class="wb-hero">
                <div class="wb-eyebrow"><span class="wb-eyebrow-dot"></span>SHELL HELPER <span>/</span> 工作台</div>
                <h1 class="wb-title">今天要连接哪里？</h1>
                <p class="wb-description">输入主机地址，或从最近连接继续。</p>
                            <div class="wb-composer-wrap">
              <div class="wb-composer" :class="{ focused: composerFocused }">
                <div v-if="composerOpen" id="composer-suggestions" class="composer-suggest" role="listbox" aria-label="匹配的连接">
                  <button
                    v-for="(host, index) in composerMatches"
                    :id="`composer-option-${host.id}`"
                    :key="host.id"
                    type="button"
                    role="option"
                    :aria-selected="index === composerActive"
                    :class="{ active: index === composerActive }"
                    @mousedown.prevent="chooseComposer(host)"
                  >
                    <span class="suggest-icon" :class="`proto-${host.protocol}`"><el-icon><FolderOpened v-if="['sftp', 'ftp'].includes(host.protocol)" /><Monitor v-else /></el-icon></span>
                    <span class="suggest-body"><strong>{{ host.name }}</strong><small>{{ hostAddress(host) }}</small></span>
                    <span class="suggest-proto">{{ host.protocol.toUpperCase() }}</span>
                  </button>
                  <p v-if="!composerMatches.length" class="suggest-empty">没有匹配的连接，按 Enter 用「{{ composerQuery.trim() }}」新建</p>
                </div>
                <div class="composer-input-row">
                  <el-icon class="composer-search"><Search /></el-icon>
                  <input
                    ref="composerInput"
                    v-model="composerQuery"
                    role="combobox"
                    aria-label="搜索主机或输入地址快速连接"
                    aria-autocomplete="list"
                    :aria-expanded="composerOpen"
                    aria-controls="composer-suggestions"
                    :aria-activedescendant="composerActiveId"
                    placeholder="搜索主机，或输入 IP / 域名快速连接"
                    @focus="composerFocused = true"
                    @blur="composerFocused = false"
                    @keydown="onComposerKey"
                  />
                  <button class="composer-send" type="button" :disabled="!composerQuery.trim()" aria-label="连接" @click="submitComposer"><el-icon><Top /></el-icon></button>
                </div>
                <div class="composer-tools">
                  <button class="composer-tool" type="button" @click="openForm(null, 'sftp')"><el-icon><FolderOpened /></el-icon><span>文件</span></button>
                  <button class="composer-tool composer-local" type="button" :disabled="!backendReady" @click="sessionStore.openLocalTerminal()"><el-icon><Monitor /></el-icon><span>本地终端</span></button>
                  <span class="composer-hint">{{ composerQuery.trim() ? 'Enter 连接' : '输入主机名 / 地址，或搜索已保存连接' }}</span>
                </div>
              </div>
            </div>
              </div>

              <div v-if="hostStore.loading || hostStore.error || startConnections.length" class="wb-block">
                <div class="wb-block-title">
                  <span>{{ recents.length ? '最近连接' : '从已保存的连接开始' }}</span>
                  <span class="wb-block-hint">点击即可连接 <el-icon><Right /></el-icon></span>
                </div>
                <div v-if="hostStore.loading" class="wb-empty">正在载入连接…</div>
                <div v-else-if="hostStore.error" class="wb-empty">
                  <el-icon><Warning /></el-icon>
                  <span>暂时无法加载连接，请在侧栏重试。</span>
                  <button v-if="!sidebarVisible" class="text-action" @click="toggleSidebar">显示侧栏</button>
                </div>
                <div v-else-if="startConnections.length" class="connection-list">
                  <div
                    v-for="r in startConnections"
                    :key="r.host.id"
                    class="connection-row"
                    role="button"
                    tabindex="0"
                    :title="hostAddress(r.host)"
                    @click="sessionStore.openDefault(r.host.id)"
                    @keydown.enter.prevent="sessionStore.openDefault(r.host.id)"
                    @keydown.space.prevent="sessionStore.openDefault(r.host.id)"
                  >
                    <span class="connection-icon" :class="`proto-${r.host.protocol}`">
                      <el-icon><FolderOpened v-if="['sftp', 'ftp'].includes(r.host.protocol)" /><Monitor v-else /></el-icon>
                    </span>
                    <span class="connection-body">
                      <span class="cc-name">{{ r.host.name }}</span>
                      <span class="cc-addr">{{ hostAddress(r.host) }}</span>
                    </span>
                    <span class="proto-tag">{{ r.host.protocol.toUpperCase() }}</span>
                    <span class="cc-time">{{ r.ts ? relTime(r.ts) : r.host.group }}</span>
                    <span class="connection-actions" @click.stop>
                      <button v-if="isTerminalProto(r.host.protocol)" type="button" @click="sessionStore.openTerminal(r.host.id)">终端</button>
                      <button v-if="isFileProto(r.host.protocol)" type="button" @click="sessionStore.openFiles(r.host.id)">文件</button>
                    </span>
                  </div>
                </div>
              </div>

              <div v-if="!startConnections.length && !hostStore.loading && !hostStore.error" class="wb-quick">
                <div class="wb-block-title"><span>快速开始</span><span class="wb-block-hint">选择一种方式进入工作</span></div>
                <div class="wb-start-grid">
                  <button class="wb-start-card" type="button" @click="openForm(null, 'ssh')">
                    <span class="wb-start-icon"><el-icon><Plus /></el-icon></span>
                    <strong>SSH 会话</strong>
                    <small>连接一台远程主机</small>
                  </button>
                  <button class="wb-start-card" type="button" @click="openForm(null, 'sftp')">
                    <span class="wb-start-icon"><el-icon><FolderOpened /></el-icon></span>
                    <strong>文件连接</strong>
                    <small>浏览 SFTP / FTP 文件</small>
                  </button>
                  <button class="wb-start-card" type="button" :disabled="!backendReady" @click="sessionStore.openLocalTerminal()">
                    <span class="wb-start-icon"><el-icon><Monitor /></el-icon></span>
                    <strong>本地终端</strong>
                    <small>直接打开本机 Shell</small>
                  </button>
                </div>
              </div>

              <div class="wb-footnote">
                <span><span class="footnote-prompt">›_</span> 所有连接，都在左侧触手可及</span>
                <button class="sidebar-shortcut" @click="toggleSidebar"><kbd v-if="settings.hint('toggleSidebar')">{{ settings.hint('toggleSidebar') }}</kbd> {{ sidebarVisible ? '收起侧栏' : '显示侧栏' }}</button>
              </div>
            </div>
          </div>
        </section>

        <!-- 会话内容 -->
        <section id="panel-session" v-show="!!sessionStore.activeId" class="session-area" role="tabpanel" :aria-labelledby="sessionStore.activeId ? `tab-${sessionStore.activeId}` : undefined">
          <div v-if="splitEnabled && activeTab?.kind === 'terminal'" class="split-bar">
            <span class="split-label"><el-icon><Grid /></el-icon>分屏</span>
            <el-select v-model="splitTabId" size="small" aria-label="选择分屏终端" style="width: 190px">
              <el-option v-for="tab in terminalTabs.filter(t => t.id !== sessionStore.activeId)" :key="tab.id" :label="tab.title" :value="tab.id" />
            </el-select>
            <label class="split-broadcast" title="向所有已打开终端广播输入"><el-switch v-model="terminalBus.broadcast" size="small" />广播输入</label>
            <button type="button" class="split-exit" @click="toggleSplit">退出分屏</button>
          </div>
          <div v-show="activeTab?.kind === 'terminal'" class="session-panes" :class="{ split: splitEnabled }">
            <div v-for="tab in terminalTabs" :key="tab.id" v-show="tab.id === sessionStore.activeId || (splitEnabled && tab.id === splitTabId)" class="session-pane">
              <TerminalView
                :tab="tab"
                :visible="tab.id === sessionStore.activeId || (splitEnabled && tab.id === splitTabId)"
                :focus="tab.id === sessionStore.activeId"
              />
            </div>
          </div>
          <FileManager
            v-for="tab in fileTabs"
            :key="tab.id"
            :tab="tab"
            :visible="tab.id === sessionStore.activeId"
          />
        </section>
      </main>
    </div>

    <LanPanel v-model="lanVisible" @share="openShareHost(null)" @open-terminal="openSharedTerminal" @assist="startRemoteAssist" />
    <TransferCenter v-model="transferCenterVisible" />
    <ShareLanDialog v-model="shareVisible" :host="shareHost" />
    <TunnelDialog v-model="tunnelVisible" :host="tunnelHost" />
    <SharedTerminalDialog v-model="sharedTerminalVisible" :terminal="sharedTerminal" />
    <WorkspaceDialog v-model="workspaceVisible" />
    <RemoteAssistDialog v-if="remoteAssist.call" />
    <CommandPalette v-model="paletteOpen" @connect="sessionStore.openDefault" @command="requestCommand" />
    <ExternalEdits :blocked="formVisible || settings.visible || confirmingCommand" />

    <!-- 底部状态栏 -->
    <footer class="sh-statusbar">
      <span class="status-item" :title="backendReady ? '本地服务已启动' : '本地服务未连接'">
        <i class="status-dot" :class="backendReady ? 'ok' : 'err'"></i>
        {{ backendReady ? '已就绪' : '未连接' }}
      </span>
      <span class="status-item">
        <el-icon><Monitor /></el-icon>
        标签 {{ sessionStore.tabs.length }}
      </span>
      <span class="status-item">
        <el-icon><Connection /></el-icon>
        {{ hostStore.hosts.length }} 个连接
      </span>
      <span class="spacer"></span>
      <span v-if="version" class="status-item ver" title="应用版本">v{{ version }}</span>
    </footer>

    <HostFormDialog v-model="formVisible" :edit-host="editingHost" :initial-protocol="initialProtocol" :initial-host="initialHostAddress" />
    <SettingsDialog />
    <Transition name="startup-fade">
      <StartupScreen
        v-if="!startup.done"
        :state="startup.state"
        :message="startup.message"
        :step="startup.step"
        :detail="startup.detail"
        :error="startup.error"
        @retry="retryStartup"
        @logs="openStartupLogs"
      />
    </Transition>
  </div>
</template>

<style scoped>
/* ---- 顶部应用栏 ---- */
.sh-app.is-inset .sh-header { padding-left: 86px; }
.sh-header {
  height: var(--sh-header-h);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 16px;
  padding: 0 16px;
  background: var(--sh-bg-sidebar);
  border-bottom: 1px solid var(--sh-border);
  -webkit-app-region: drag;
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.brand-logo {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  background: var(--sh-ink);
  color: var(--sh-logo-fg);
  font: 700 18px var(--sh-font-mono);
  flex-shrink: 0;
}
.brand-name {
  font-family: var(--sh-font-brand);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.075em;
  text-transform: uppercase;
  color: var(--sh-text);
  white-space: nowrap;
}
.ws-name {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: center;
  height: 18px;
  padding-left: 16px;
  border-left: 1px solid var(--sh-border);
  font-size: 13px;
  font-weight: 500;
  color: var(--sh-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.header-actions {
  display: flex;
  flex-shrink: 0;
  gap: 6px;
  align-items: center;
  margin-left: auto;
  -webkit-app-region: no-drag;
}
.lan-trigger { position: relative; }
.transfer-trigger { position: relative; }
.transfer-count { min-width: 14px; height: 14px; padding: 0 3px; display: inline-flex; align-items: center; justify-content: center; border-radius: 999px; background: var(--sh-accent); color: #fff; font: 600 8px var(--sh-font-mono); position: absolute; top: 2px; right: 1px; }
.lan-count { min-width: 14px; height: 14px; padding: 0 3px; display: inline-flex; align-items: center; justify-content: center; border-radius: 999px; background: var(--sh-accent); color: #fff; font: 600 8px var(--sh-font-mono); position: absolute; top: 2px; right: 1px; }
.lan-unread { position: absolute; top: 4px; right: 3px; width: 5px; height: 5px; border-radius: 50%; background: var(--sh-warning); border: 1px solid var(--sh-bg); }
.header-new {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--sh-radius-sm);
  background: transparent;
  color: var(--sh-text-secondary);
  font-size: 12px;
  cursor: pointer;
}
.header-new:hover { background: var(--sh-bg-hover); color: var(--sh-text); }
.header-new.is-primary { background: var(--sh-ink); color: var(--sh-on-ink); }
.header-new.is-primary:hover { background: var(--sh-ink-hover); }
.sh-main.sidebar-hidden { margin-left: 0; border-left: 0; }
.icon-btn {
  width: 30px;
  height: 30px;
  border: none;
  border-radius: var(--sh-radius-sm);
  display: grid;
  place-items: center;
  background: transparent;
  color: var(--sh-text-secondary);
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease;
}
.icon-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.icon-btn:hover:not(:disabled) {
  background: var(--sh-bg-hover);
  color: var(--sh-text);
}

/* ---- 会话区 ---- */
.session-area {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.split-bar { min-height: 36px; flex-shrink: 0; display: flex; align-items: center; gap: 10px; padding: 4px 14px; border-bottom: 1px solid var(--sh-border); background: var(--sh-bg-elevated); }
.split-label { display: inline-flex; align-items: center; gap: 5px; color: var(--sh-text-secondary); font-size: 11px; }
.split-label .el-icon { color: var(--sh-accent); }
.split-broadcast { display: inline-flex; align-items: center; gap: 6px; color: var(--sh-text-muted); font-size: 11px; }
.split-exit { margin-left: auto; padding: 0; border: 0; background: transparent; color: var(--sh-accent); font-size: 11px; cursor: pointer; }
.session-panes { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.session-panes.split { flex-direction: row; }
.session-pane { flex: 1; min-width: 0; min-height: 0; display: flex; }
.session-pane + .session-pane { border-left: 1px solid var(--sh-border); }
.split-active { color: var(--sh-accent) !important; }

/* ---- 主内容标题/状态栏 ---- */
.main-header {
  height: 54px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 24px;
  background: var(--sh-bg-elevated);
}
.main-heading {
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1px;
}
.main-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
  color: var(--sh-text);
}
.main-subtitle {
  min-width: 0;
  max-width: 560px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  line-height: 16px;
  color: var(--sh-text-muted);
}
.main-status {
  margin-left: auto;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  overflow: hidden;
}
.main-chip {
  height: 22px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  padding: 0 8px;
  border: 1px solid var(--sh-border);
  border-radius: 6px;
  background: var(--sh-bg);
  color: var(--sh-text-secondary);
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
}
.main-chip.proto-chip {
  border-color: transparent;
  background: transparent;
  font: 600 10px var(--sh-font-mono);
  letter-spacing: 0.04em;
}
.state-chip i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--sh-text-muted);
}
.state-chip.state-ok i { background: var(--sh-success); }
.state-chip.state-pending i { background: var(--sh-warning); }
.state-chip.state-err i { background: var(--sh-danger); }
.state-chip.state-off i { background: var(--sh-text-muted); }
.detail-chip {
  min-width: 0;
  max-width: 240px;
  overflow: hidden;
}
.detail-chip span { flex-shrink: 0; color: var(--sh-text-muted); }
.detail-chip b {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font: 10px var(--sh-font-mono);
  font-weight: 400;
  color: var(--sh-text-secondary);
}

/* ---- 起始页 / 工作台 ---- */
.workbench {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background:
    radial-gradient(720px 300px at 50% -90px, var(--sh-accent-soft), transparent 72%),
    var(--sh-bg-elevated);
}
.wb-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.wb-inner {
  max-width: 760px;
  margin: 0 auto;
  padding: clamp(34px, 6vh, 58px) 40px 28px;
}
.wb-hero { margin-bottom: 30px; }
.wb-eyebrow {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 14px;
  color: var(--sh-text-muted);
  font: 10px var(--sh-font-mono);
  letter-spacing: 1.1px;
}
.wb-eyebrow-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--sh-accent); }
.wb-eyebrow span:not(.wb-eyebrow-dot) { opacity: 0.5; }
.wb-head { margin-bottom: 28px; }
.wb-head.compact { margin-bottom: 16px; }
.wb-head.compact .wb-mark,
.wb-head.compact .wb-eyebrow,
.wb-head.compact .wb-description { display: none; }
.wb-head.compact .wb-title { font-size: 22px; letter-spacing: -0.6px; }
.wb-mark {
  width: 56px;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 22px;
  border: 1px solid transparent;
  border-radius: 18px;
  background: var(--sh-ink);
  color: var(--sh-on-ink);
  font: 500 42px var(--sh-font-mono);
  letter-spacing: -5px;
}
.wb-mark span { font-size: 32px; padding-right: 5px; }
.wb-eyebrow {
  margin-bottom: 12px;
  font: 10px var(--sh-font-mono);
  letter-spacing: 1.6px;
  color: var(--sh-text-muted);
}
.wb-title {
  margin: 0;
  font-size: clamp(26px, 2.8vw, 34px);
  font-weight: 600;
  letter-spacing: -1.2px;
  color: var(--sh-text);
}
.wb-description {
  margin: 10px 0 0;
  font-size: 13px;
  line-height: 1.75;
  color: var(--sh-text-secondary);
}
.quick-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin-bottom: 32px;
}
.quick-action {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 19px 18px;
  text-align: left;
  border: 1px solid var(--sh-border);
  border-radius: var(--sh-radius-lg);
  background: transparent;
  color: var(--sh-text);
  cursor: pointer;
  transition: background 0.16s ease, border-color 0.16s ease, transform 0.16s ease;
}
.quick-action:hover:not(:disabled) {
  border-color: var(--sh-accent-border);
  background: var(--sh-accent-soft);
  transform: translateY(-2px);
}
.quick-action:disabled { opacity: 0.5; cursor: not-allowed; }
.quick-action.local { grid-column: 1 / -1; padding: 14px 18px; }
.quick-action.primary { background: var(--sh-ink); border-color: var(--sh-ink); color: var(--sh-on-ink); }
.quick-action.primary:hover { background: var(--sh-ink-hover); }
.qa-icon { font-size: 22px; flex-shrink: 0; }
.qa-text { flex: 1; display: flex; flex-direction: column; gap: 7px; }
.qa-text strong { font-size: 13px; font-weight: 500; }
.qa-text small { font-size: 11px; color: var(--sh-text-muted); }
.primary .qa-text small { color: var(--sh-on-ink-muted); }
.primary kbd { background: var(--sh-kbd-on-ink); border-color: var(--sh-kbd-on-ink-border); color: var(--sh-kbd-on-ink-text); white-space: nowrap; }
.qa-arrow { color: var(--sh-text-muted); }
.wb-block { margin-top: 2px; }
.wb-quick { margin-top: 2px; }
.wb-block-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  font-weight: 500;
  color: var(--sh-text-secondary);
  padding: 0 2px 13px;
  border-bottom: 1px solid var(--sh-border);
}
.wb-block-hint { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--sh-text-muted); }
.connection-list { padding-top: 7px; }
.connection-row {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 12px 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--sh-text);
  text-align: left;
  cursor: pointer;
  transition: background 0.14s ease;
}
.connection-row:hover { background: var(--sh-accent-soft); }
.connection-icon {
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border: 1px solid var(--sh-border);
  border-radius: 9px;
  background: var(--sh-bg-panel);
  font-size: 16px;
}
.connection-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.cc-name { font-size: 13px; font-weight: 500; }
.cc-addr { font: 11px var(--sh-font-mono); color: var(--sh-text-muted); }
.cc-name, .cc-addr { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cc-time { width: 72px; font-size: 11px; text-align: right; color: var(--sh-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.proto-tag { font: 10px var(--sh-font-mono); color: var(--sh-text-muted); }
.connection-actions { display: flex; gap: 4px; }
.connection-actions button { border: 0; border-radius: 6px; padding: 4px 8px; background: var(--sh-bg-panel); color: var(--sh-text-secondary); font-size: 11px; cursor: pointer; }
.connection-actions button:hover { color: var(--sh-accent); }
.wb-start-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 9px; margin-top: 10px; }
.wb-quick .wb-block-title { margin-bottom: 2px; }
.wb-start-card { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 13px; border: 1px solid var(--sh-border); border-radius: 10px; background: var(--sh-bg-panel); color: var(--sh-text); text-align: left; cursor: pointer; transition: border-color .14s ease, background .14s ease, transform .14s ease; }
.wb-start-card:hover:not(:disabled) { border-color: var(--sh-accent-border); background: var(--sh-accent-soft); transform: translateY(-1px); }
.wb-start-card:disabled { opacity: .5; cursor: default; }
.wb-start-icon { width: 28px; height: 28px; display: grid; place-items: center; margin-bottom: 5px; border-radius: 7px; background: var(--sh-bg); color: var(--sh-accent); font-size: 15px; }
.wb-start-card strong { font-size: 12px; font-weight: 500; color: var(--sh-text); }
.wb-start-card small { color: var(--sh-text-muted); font-size: 10px; line-height: 1.4; }
.wb-empty {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  min-height: 90px;
  padding: 8px;
  font-size: 12px;
  color: var(--sh-text-muted);
}
.text-action { border: 0; background: transparent; color: var(--sh-accent); font-size: 12px; cursor: pointer; }
/* ---- 聊天式 composer ---- */
.wb-composer-wrap {
  flex-shrink: 0;
  padding: 20px 0 2px;
  background: transparent;
}
.wb-composer {
  position: relative;
  width: 100%;
  margin: 0 auto;
  padding: 10px 12px 9px;
  border: 1px solid var(--sh-border-strong);
  border-radius: 16px;
  background: var(--sh-bg-panel);
  box-shadow: 0 10px 30px rgba(15, 17, 21, 0.06), 0 1px 2px rgba(15, 17, 21, 0.04);
  transition: border-color 0.16s ease, box-shadow 0.16s ease;
}
.wb-composer:focus-within {
  border-color: var(--sh-accent);
  box-shadow: 0 0 0 3px var(--sh-accent-soft), var(--sh-shadow-pop);
}
.composer-input-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 3px 3px 2px;
}
.composer-search { color: var(--sh-text-muted); font-size: 15px; }
.composer-input-row input {
  flex: 1;
  min-width: 0;
  height: 28px;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--sh-text);
  font: 13px var(--sh-font-ui);
}
.composer-input-row input::placeholder { color: var(--sh-text-muted); }
.composer-send {
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 50%;
  background: var(--sh-accent);
  color: #fff;
  cursor: pointer;
  transition: background 0.14s ease, opacity 0.14s ease;
}
.composer-send:hover:not(:disabled) { background: var(--el-color-primary-dark-2); }
.composer-send:disabled { opacity: 0.35; cursor: default; }
.composer-tools {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 7px 1px 1px;
  border-top: 1px solid var(--sh-border);
}
.composer-tool {
  height: 28px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--sh-text-secondary);
  font-size: 12px;
  cursor: pointer;
}
.composer-tool:hover:not(:disabled) { background: var(--sh-bg-hover); color: var(--sh-text); }
.composer-tool:disabled { opacity: 0.45; cursor: not-allowed; }
.composer-hint { margin-left: auto; color: var(--sh-text-muted); font-size: 11px; white-space: nowrap; }
.composer-suggest {
  position: absolute;
  left: 0;
  right: 0;
  top: calc(100% + 8px);
  bottom: auto;
  z-index: 30;
  max-height: 300px;
  overflow-y: auto;
  padding: 5px;
  border: 1px solid var(--sh-border);
  border-radius: var(--sh-radius);
  background: var(--sh-bg-panel);
  box-shadow: var(--sh-shadow-pop);
}
.composer-suggest button {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--sh-text);
  text-align: left;
  cursor: pointer;
}
.composer-suggest button:hover,
.composer-suggest button.active { background: var(--sh-bg-hover); }
.suggest-icon {
  width: 27px;
  height: 27px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border: 1px solid var(--sh-border);
  border-radius: 7px;
  background: var(--sh-bg);
  font-size: 14px;
}
.suggest-body { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.suggest-body strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 500; }
.suggest-body small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 10px var(--sh-font-mono); color: var(--sh-text-muted); }
.suggest-proto { flex-shrink: 0; font: 600 9px var(--sh-font-mono); color: var(--sh-text-muted); }
.suggest-empty { margin: 8px 10px 9px; font-size: 12px; line-height: 1.6; color: var(--sh-text-muted); }
.wb-footnote {
  margin-top: 22px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-top: 24px;
  padding-top: 20px;
  border-top: 1px solid var(--sh-border);
  font-size: 11px;
  color: var(--sh-text-muted);
}
.footnote-prompt { margin-right: 7px; font: 13px var(--sh-font-mono); }
.sidebar-shortcut { display: flex; align-items: center; gap: 7px; border: 0; background: transparent; color: var(--sh-text-muted); font-size: 11px; cursor: pointer; }
@media (max-width: 1080px) {
  .main-header { padding: 0 18px; }
  .main-subtitle { max-width: 360px; }
  .wb-inner { padding: 26px 24px 18px; }
  .wb-hero { margin-bottom: 22px; }
  .wb-footnote { flex-wrap: wrap; }
  .cc-time { width: 58px; }
  .wb-composer-wrap { padding: 8px 16px 14px; }
  .composer-hint { display: none; }
}
@media (max-height: 700px) {
  .wb-inner { padding-top: 20px; }
  .wb-mark { width: 48px; height: 48px; margin-bottom: 18px; font-size: 34px; }
  .wb-head { margin-bottom: 20px; }
  .main-header { height: 50px; }
}
.spacer {
  flex: 1;
}
.status-path {
  min-width: 0;
  max-width: 42%;
  overflow: hidden;
  white-space: nowrap;
}
.status-label {
  flex-shrink: 0;
  color: var(--sh-text-muted);
}
.status-value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--sh-font-mono);
}
.ver {
  color: var(--sh-text-muted);
}

.startup-fade-enter-active { transition: opacity .22s ease; }
.startup-fade-enter-from { opacity: 0; }
.startup-fade-leave-active { transition: opacity .24s ease, transform .24s ease; }
.startup-fade-leave-to { opacity: 0; transform: scale(.995); }
@media (prefers-reduced-motion: reduce) {
  .startup-fade-enter-active, .startup-fade-leave-active { transition: none; }
}
</style>
