<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useHostStore } from '@renderer/stores/host'
import { useSessionStore } from '@renderer/stores/session'
import HostPanel from '@renderer/components/HostPanel.vue'
import TabBar from '@renderer/components/TabBar.vue'
import TerminalView from '@renderer/components/TerminalView.vue'
import FileManager from '@renderer/components/FileManager.vue'
import HostFormDialog from '@renderer/components/HostFormDialog.vue'
import { ensureConn } from '@renderer/api/client'
import { getRecents } from '@renderer/utils/recent'
import type { Host, Protocol } from '@renderer/api/types'
import { useSettingsStore } from '@renderer/stores/settings'
import { useExternalStore } from '@renderer/stores/external'
import SettingsDialog from '@renderer/components/SettingsDialog.vue'
import ExternalEdits from '@renderer/components/ExternalEdits.vue'
import { installShortcuts } from '@renderer/utils/shortcuts'
import { fileBridges, terminalBridges } from '@renderer/utils/workspace'
import { validCommand, type ActionId, type TerminalCommand } from '../../shared/settings'

const hostStore = useHostStore()
const sessionStore = useSessionStore()
const backendReady = ref(false)
const formVisible = ref(false)
const editingHost = ref<Host | null>(null)
const version = ref('')
const initialProtocol = ref<Protocol>('ssh')
const settings = useSettingsStore()
const external = useExternalStore()
const hostPanel = ref<InstanceType<typeof HostPanel>>()
const confirmingCommand = ref(false)
const commandAvailable = computed(() => activeTab.value?.kind === 'terminal' && !!terminalBridges.get(sessionStore.activeId)?.ready())
let disposeShortcuts: (() => void) | undefined
let disposeEdits: (() => void) | undefined

const activeTab = computed(() => sessionStore.active())
const terminalTabs = computed(() => sessionStore.tabs.filter((t) => t.kind === 'terminal'))
const fileTabs = computed(() => sessionStore.tabs.filter((t) => t.kind === 'files'))

// 当前工作区标题(无活动会话时为“工作台”)
const workspaceName = computed(() => activeTab.value?.title ?? '个人工作空间')

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

function relTime(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

function openForm(host: Host | null = null, protocol: Protocol = 'ssh'): void {
  editingHost.value = host
  initialProtocol.value = protocol
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

onMounted(async () => {
  loadSidebarPrefs()
  disposeShortcuts = installShortcuts({
    settings: () => settings.value, mac: settings.mac,
    blocked: () => !settings.ready || settings.recording || settings.visible || formVisible.value || external.visible || confirmingCommand.value,
    action, command: requestCommand
  })
  await settings.load()
  try { disposeEdits = await external.initialize() } catch (error) { ElMessage.error(`草稿恢复失败：${(error as Error).message}`) }
  try {
    await ensureConn()
    backendReady.value = true
    await hostStore.refresh()
    reloadRecents()
  } catch (err) {
    console.error('后端启动失败', err)
  }
  try {
    version.value = await window.shellHelper.getVersion()
  } catch {
    /* noop */
  }
})

onBeforeUnmount(() => { disposeShortcuts?.(); disposeEdits?.() })

// 回到欢迎页(无活动会话)时刷新最近连接
watch(
  () => sessionStore.activeId,
  (id) => {
    if (!id) reloadRecents()
  }
)
</script>

<template>
  <div class="sh-app">
    <!-- 顶部应用栏 -->
    <header class="sh-header">
      <div class="brand">
        <div class="brand-logo" aria-hidden="true">›_</div>
        <span class="brand-name">Shell Helper</span>
      </div>
      <span class="ws-name">{{ workspaceName }}</span>
      <div class="header-actions">
        <el-dropdown v-if="commandAvailable" trigger="click" @command="(id: string) => { const cmd = settings.value.commands.find(c => c.id === id); if (cmd) requestCommand(cmd) }">
          <button class="header-new" aria-label="终端命令">终端命令 <el-icon><ArrowDown /></el-icon></button>
          <template #dropdown><el-dropdown-menu>
            <el-dropdown-item v-for="cmd in settings.value.commands.filter(c => c.enabled)" :key="cmd.id" :command="cmd.id">{{ cmd.name }}</el-dropdown-item>
            <el-dropdown-item v-if="!settings.value.commands.some(c => c.enabled)" disabled>请在设置中添加命令</el-dropdown-item>
          </el-dropdown-menu></template>
        </el-dropdown>
        <button class="header-new" @click="external.visible = true">外部编辑{{ external.pending.length ? ` · ${external.pending.length}` : '' }}</button>
        <button class="icon-btn" aria-label="打开本地终端" title="打开本地终端" :disabled="!backendReady" @click="sessionStore.openLocalTerminal()"><el-icon><Monitor /></el-icon></button>
        <button class="icon-btn" aria-label="打开设置" :title="`设置 ${settings.hint('openSettings')}`" @click="settings.visible = true"><el-icon><Setting /></el-icon></button>
        <button class="header-new" @click="openForm()" aria-label="新建连接">
          <el-icon><Plus /></el-icon>
          <span>新建连接</span>
        </button>
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
        <TabBar @new-host="openForm()" />

        <!-- 起始页 / 工作台(无活动会话) -->
        <section v-show="!sessionStore.activeId" class="workbench">
          <div class="wb-inner">
            <div class="wb-head">
              <div class="wb-mark" aria-hidden="true">›<span>_</span></div>
              <div class="wb-eyebrow">SHELL HELPER / 你的连接，从这里开始</div>
              <h1 class="wb-title">连接，然后专注。</h1>
              <p class="wb-description">远程终端与文件浏览，让工作在一处自然衔接。</p>
            </div>

            <div class="quick-actions">
              <button class="quick-action primary" @click="openForm()">
                <el-icon class="qa-icon"><Plus /></el-icon>
                <span class="qa-text"><strong>新建连接</strong><small>连接一台远程主机</small></span>
                <kbd v-if="settings.hint('newConnection')">{{ settings.hint('newConnection') }}</kbd>
              </button>
              <button class="quick-action" @click="openForm(null, 'sftp')">
                <el-icon class="qa-icon"><FolderOpened /></el-icon>
                <span class="qa-text"><strong>文件连接</strong><small>通过 SFTP 浏览远程文件</small></span>
                <el-icon class="qa-arrow"><TopRight /></el-icon>
              </button>
              <button class="quick-action local" :disabled="!backendReady" @click="sessionStore.openLocalTerminal()">
                <el-icon class="qa-icon"><Monitor /></el-icon>
                <span class="qa-text"><strong>本地终端</strong><small>在此电脑打开默认 Shell，无需配置连接</small></span>
                <el-icon class="qa-arrow"><TopRight /></el-icon>
              </button>
            </div>

            <!-- 最近连接 -->
            <div class="wb-block">
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
                <button
                  v-for="r in startConnections"
                  :key="r.host.id"
                  class="connection-row"
                  :title="hostAddress(r.host)"
                  @click="sessionStore.openDefault(r.host.id)"
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
                  <el-icon class="connect-arrow"><Right /></el-icon>
                </button>
              </div>
              <div v-else class="wb-empty">
                <el-icon><Connection /></el-icon>
                <span>还没有连接，添加你的第一台主机吧。</span>
                <button class="text-action" @click="openForm()">添加连接 <span aria-hidden="true">↗</span></button>
              </div>
            </div>

            <!-- 已保存连接 -->
            <div class="wb-footnote">
              <span><span class="footnote-prompt">›_</span> 所有连接，都在左侧触手可及</span>
              <button class="sidebar-shortcut" @click="toggleSidebar"><kbd v-if="settings.hint('toggleSidebar')">{{ settings.hint('toggleSidebar') }}</kbd> {{ sidebarVisible ? '收起侧栏' : '显示侧栏' }}</button>
            </div>
          </div>
        </section>

        <!-- 会话内容 -->
        <section v-show="!!sessionStore.activeId" class="session-area">
          <TerminalView
            v-for="tab in terminalTabs"
            :key="tab.id"
            :tab="tab"
            :visible="tab.id === sessionStore.activeId"
          />
          <FileManager
            v-for="tab in fileTabs"
            :key="tab.id"
            :tab="tab"
            :visible="tab.id === sessionStore.activeId"
          />
        </section>
      </main>
    </div>

    <!-- 底部状态栏 -->
    <footer class="sh-statusbar">
      <span class="status-item">
        <i class="status-dot" :class="backendReady ? 'ok' : 'err'"></i>
        {{ backendReady ? '服务就绪' : '服务未连接' }}
      </span>
      <span class="status-item">
        <el-icon><Monitor /></el-icon>
        会话 {{ sessionStore.tabs.length }}
      </span>
      <span class="status-item">
        <el-icon><Connection /></el-icon>
        {{ hostStore.hosts.length }} 个连接
      </span>
      <span v-if="activeTab" class="status-item active-info">
        <el-icon><Connection /></el-icon>
        {{ activeTab.title }}
      </span>
      <span class="spacer"></span>
      <span v-if="version" class="status-item ver">v{{ version }}</span>
    </footer>

    <HostFormDialog v-model="formVisible" :edit-host="editingHost" :initial-protocol="initialProtocol" />
    <SettingsDialog />
    <ExternalEdits :blocked="formVisible || settings.visible || confirmingCommand" />
  </div>
</template>

<style scoped>
/* ---- 顶部应用栏 ---- */
.sh-header {
  height: var(--sh-header-h);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 0 18px;
  background: var(--sh-bg-sidebar);
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
  color: #e6efdf;
  font: 700 18px var(--sh-font-mono);
  flex-shrink: 0;
}
.brand-name {
  font-size: 13px;
  font-weight: 700;
  color: var(--sh-text);
}
.ws-name {
  min-width: 0;
  font-size: 12px;
  color: var(--sh-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.header-actions {
  display: flex;
  flex-shrink: 0;
  gap: 12px;
  align-items: center;
  -webkit-app-region: no-drag;
}
.header-new {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 9px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--sh-text-secondary);
  font-size: 12px;
  cursor: pointer;
}
.header-new:hover { background: var(--sh-bg-active); }
.sh-main.sidebar-hidden { margin-left: 10px; }
.icon-btn {
  width: 30px;
  height: 30px;
  border: none;
  border-radius: var(--sh-radius);
  display: grid;
  place-items: center;
  background: transparent;
  color: var(--sh-text-secondary);
  cursor: pointer;
  transition: background 0.14s ease;
}
.icon-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.icon-btn:hover:not(:disabled) {
  background: var(--sh-bg-active);
  color: var(--sh-text);
}

/* ---- 会话区 ---- */
.session-area {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* ---- 起始页 / 工作台 ---- */
.workbench {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: var(--sh-bg-elevated);
}
.wb-inner {
  max-width: 680px;
  margin: 0 auto;
  padding: clamp(32px, 5vh, 48px) 40px 28px;
}
.wb-head { margin-bottom: 28px; }
.wb-mark {
  width: 56px;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 22px;
  border: 1px solid #cbd8c8;
  border-radius: 18px;
  background: #e7eddf;
  color: var(--sh-accent);
  font: 500 42px var(--sh-font-mono);
  letter-spacing: -5px;
  transform: rotate(-5deg);
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
  font-size: clamp(28px, 3.2vw, 38px);
  font-weight: 600;
  letter-spacing: -1.5px;
  color: var(--sh-text);
}
.wb-description {
  margin: 14px 0 0;
  font-size: 13px;
  line-height: 1.8;
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
  border-radius: 12px;
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
.quick-action.primary { background: var(--sh-ink); border-color: var(--sh-ink); color: #f5f7ef; }
.quick-action.primary:hover { background: #354e43; }
.qa-icon { font-size: 22px; flex-shrink: 0; }
.qa-text { flex: 1; display: flex; flex-direction: column; gap: 7px; }
.qa-text strong { font-size: 13px; font-weight: 500; }
.qa-text small { font-size: 11px; color: var(--sh-text-muted); }
.primary .qa-text small { color: #b9cabd; }
.primary kbd { background: #3a5044; border-color: #526756; color: #d3ded2; white-space: nowrap; }
.qa-arrow { color: var(--sh-text-muted); }
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
.connect-arrow { font-size: 13px; opacity: 0; color: var(--sh-accent); }
.connection-row:hover .connect-arrow, .connection-row:focus-visible .connect-arrow { opacity: 1; }
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
.wb-footnote {
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
  .wb-inner { padding: 32px 28px 24px; }
  .quick-actions { gap: 10px; }
  .quick-action { padding: 16px 12px; gap: 8px; }
  .qa-icon { font-size: 18px; }
  .wb-footnote { flex-wrap: wrap; }
  .cc-time { width: 58px; }
}
@media (max-height: 700px) {
  .wb-inner { padding-top: 26px; }
  .wb-mark { width: 48px; height: 48px; margin-bottom: 18px; font-size: 34px; }
  .wb-head { margin-bottom: 24px; }
  .quick-actions { margin-bottom: 28px; }
}
.spacer {
  flex: 1;
}
.active-info {
  color: var(--sh-text);
  font-weight: 500;
}
.ver {
  color: var(--sh-text-muted);
}
</style>
