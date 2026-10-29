<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { ElMessage } from 'element-plus'
import { getWsUrl } from '@renderer/api/client'
import { localCwd } from '@renderer/api/sessions'
import type { Tab } from '@renderer/stores/session'
import { useSessionStore } from '@renderer/stores/session'
import { useSettingsStore } from '@renderer/stores/settings'
import { useTerminalBus } from '@renderer/stores/terminalBus'
import { useLanStore } from '@renderer/stores/lan'
import { sessionMeta, terminalBridges } from '@renderer/utils/workspace'
import { dispatchShortcut, hasDialog } from '@renderer/utils/shortcuts'
import { validCommand, type TerminalTheme } from '../../../shared/settings'

const props = defineProps<{ tab: Tab; visible: boolean; focus?: boolean }>()
const sessionStore = useSessionStore()
const settings = useSettingsStore()
const terminalBus = useTerminalBus()
const lan = useLanStore()

const container = ref<HTMLDivElement>()
const host = ref<HTMLDivElement>()
const searchInput = ref<HTMLInputElement>()
const searchOpen = ref(false)
const searchQuery = ref('')
const searchCase = ref(false)
const searchCount = ref(0)
const searchIndex = ref(-1)
const hasSelection = ref(false)
const menu = ref<{ x: number; y: number } | null>(null)
const recording = ref(false)
const recordParts: string[] = []
let recordBytes = 0
const shareId = ref('')
let term: Terminal | null = null
let fit: FitAddon | null = null
let search: SearchAddon | null = null
let searchResultsDisposable: { dispose(): void } | null = null
let ws: WebSocket | null = null
const connected = ref(false)
// 区分正常结束、异常断开和启动失败，避免 exit 后仍提示“连接已断开”
const endKind = ref<'ended' | 'disconnected' | ''>('')
const lightTerminal = computed(() => settings.value.terminal.theme === 'light')
const showStartupError = computed(() => !props.tab.connecting && !!props.tab.error && !props.tab.session)
const recoveryText = computed(() => {
  if (props.tab.error) return props.tab.error
  return endKind.value === 'ended' ? '终端已结束，输出保留在上方' : '连接已断开，输出保留在上方'
})
const recoveryAction = computed(() => endKind.value === 'ended' ? '重新打开' : '重新连接')
let resizeTimer: ReturnType<typeof setTimeout> | null = null
let cwdTimer: ReturnType<typeof setTimeout> | null = null
let resizeObserver: ResizeObserver | null = null
let oscBuffer = ''
const outputDecoder = new TextDecoder('utf-8')

const SEARCH_DECORATIONS = {
  matchBackground: '#f7ad31',
  matchBorder: '#f7ad31',
  matchOverviewRuler: '#f7ad31',
  activeMatchBackground: '#3468d8',
  activeMatchBorder: '#3468d8',
  activeMatchColorOverviewRuler: '#3468d8'
}
const TERMINAL_THEMES: Record<TerminalTheme, NonNullable<Terminal['options']['theme']>> = {
  dark: { background: '#0f1115', foreground: '#f9fafb', cursor: '#7aaaff', cursorAccent: '#0f1115', selectionBackground: 'rgba(86, 134, 254, 0.28)', black: '#353638', red: '#f25a5a', green: '#4ed17e', yellow: '#f7ad31', blue: '#5686fe', magenta: '#b7a6ff', cyan: '#5db0d7', white: '#cfd3d6', brightBlack: '#61666b', brightRed: '#ff7b86', brightGreen: '#69e69a', brightYellow: '#ffc45c', brightBlue: '#8fb0ff', brightMagenta: '#cbbcff', brightCyan: '#7fd0e8', brightWhite: '#ffffff' },
  light: { background: '#f9fafb', foreground: '#0f1115', cursor: '#3468d8', cursorAccent: '#f9fafb', selectionBackground: 'rgba(52, 104, 216, 0.18)', black: '#0f1115', red: '#ec1313', green: '#15803d', yellow: '#b45309', blue: '#3468d8', magenta: '#7c3aed', cyan: '#0e7490', white: '#61666b' },
  solarized: { background: '#002b36', foreground: '#839496', cursor: '#93a1a1', cursorAccent: '#002b36', selectionBackground: 'rgba(147, 161, 161, 0.28)', black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5', brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3' },
  dracula: { background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36', selectionBackground: 'rgba(68, 71, 90, 0.8)', black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2', brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff' },
  monokai: { background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0', cursorAccent: '#272822', selectionBackground: 'rgba(73, 72, 62, 0.8)', black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75', blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2', brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e', brightYellow: '#f4bf75', brightBlue: '#66d9ef', brightMagenta: '#ae81ff', brightCyan: '#a1efe4', brightWhite: '#f9f8f5' }
}

function themeOf(name: TerminalTheme) {
  return TERMINAL_THEMES[name] ?? TERMINAL_THEMES.dark
}

function noteOutput(chunk: string): void {
  oscBuffer = (oscBuffer + chunk).slice(-8192)
  const pattern = /\x1b\](?:7;file:\/\/[^/\x07\x1b]*(\/[^ \x07\x1b]*)|1337;CurrentDir=([^\x07\x1b]+))(?:\x07|\x1b\\)/g
  let found = ''
  for (const match of oscBuffer.matchAll(pattern)) {
    const raw = match[1] || match[2] || ''
    try { found = decodeURIComponent(raw) } catch { found = raw }
  }
  if (found.startsWith('/')) sessionMeta.shellPath[props.tab.id] = found
}

function rememberSize(): void {
  if (!term) return
  sessionMeta.terminal[props.tab.id] = { cols: term.cols, rows: term.rows }
}

function observeResize(): void {
  if (!container.value || resizeObserver) return
  resizeObserver = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      fit?.fit()
      sendResize()
      rememberSize()
    }, 60)
  })
  resizeObserver.observe(container.value)
}

function disconnectWs(notify: boolean): void {
  connected.value = false
  if (ws) {
    ws.onopen = null
    ws.onmessage = null
    ws.onclose = null
    ws.onerror = null
    if (notify) term?.writeln('\r\n\x1b[31m[连接已断开]\x1b[0m')
    ws.close()
    ws = null
  }
}

function scheduleLocalCwd(): void {
  if (cwdTimer) clearTimeout(cwdTimer)
  const sessionId = props.tab.session?.session_id
  if (props.tab.hostId || !sessionId || !term) return
  cwdTimer = setTimeout(async () => {
    try {
      const path = await localCwd(sessionId)
      if (path.startsWith('/')) sessionMeta.shellPath[props.tab.id] = path
    } catch { /* 读取失败时保留上一次目录 */ }
    if (term) scheduleLocalCwd()
  }, 2000)
}

function cleanupTerm(): void {
  terminalBridges.delete(props.tab.id)
  terminalBus.unregister(props.tab.id)
  recording.value = false
  if (shareId.value) { void lan.stopTerminalShare(shareId.value).catch(() => undefined); shareId.value = '' }
  delete sessionMeta.terminal[props.tab.id]
  delete sessionMeta.shellPath[props.tab.id]
  oscBuffer = ''
  if (cwdTimer) clearTimeout(cwdTimer)
  cwdTimer = null
  if (resizeTimer) clearTimeout(resizeTimer)
  resizeObserver?.disconnect()
  resizeObserver = null
  disconnectWs(false)
  term?.dispose()
  term = null
  fit = null
  searchResultsDisposable?.dispose()
  searchResultsDisposable = null
  search = null
  connected.value = false
  endKind.value = ''
}

function openTerminal(): void {
  const sessionId = props.tab.session?.session_id
  if (!sessionId || term || !container.value) return
  endKind.value = ''

  term = new Terminal({
    cursorBlink: true,
    fontSize: settings.value.terminal.fontSize,
    fontFamily: settings.value.terminal.fontFamily,
    lineHeight: 1.4,
    scrollback: 5000,
    theme: themeOf(settings.value.terminal.theme),
    convertEol: false
  })
  fit = new FitAddon()
  search = new SearchAddon()
  term.loadAddon(fit)
  term.loadAddon(search)
  term.open(container.value)
  term.attachCustomKeyEventHandler((event) => {
    if (event.type === 'keydown' && (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f') {
      void openSearch()
      return false
    }
    return !dispatchShortcut(event)
  })
  fit.fit()
  rememberSize()
  observeResize()

  ws = new WebSocket(getWsUrl(`/api/terminals/${sessionId}/ws`))
  ws.binaryType = 'arraybuffer'
  const send = (data: string): boolean => {
    if (!connected.value || ws?.readyState !== WebSocket.OPEN) return false
    ws.send(new TextEncoder().encode(data))
    return true
  }

  ws.onopen = () => {
    connected.value = true
    endKind.value = ''
    sendResize()
    if (props.visible && props.focus !== false && !hasDialog()) term!.focus()
    const command = props.tab.startupCommand
    if (command) {
      props.tab.startupCommand = ''
      send(command)
    }
    scheduleLocalCwd()
  }
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(ev.data)
      term!.write(bytes)
      const text = outputDecoder.decode(bytes, { stream: true })
      try { noteOutput(text) } catch { /* 目录标记解析失败不影响输出 */ }
      appendRecording(text)
      if (shareId.value) lan.sendTerminalOutput(shareId.value, text)
    } else {
      const text = String(ev.data)
      term!.write(text)
      try { noteOutput(text) } catch { /* 目录标记解析失败不影响输出 */ }
      appendRecording(text)
      if (shareId.value) lan.sendTerminalOutput(shareId.value, text)
    }
  }
  ws.onclose = (event) => {
    connected.value = false
    endKind.value = event.code === 1000 ? 'ended' : 'disconnected'
    if (props.tab.session) props.tab.session.status = 'closed'
    term?.writeln(event.code === 1000
      ? '\r\n\x1b[90m[终端已结束]\x1b[0m'
      : '\r\n\x1b[31m[连接已断开]\x1b[0m')
  }
  ws.onerror = () => {
    connected.value = false
    endKind.value = 'disconnected'
    term?.writeln('\r\n\x1b[31m[终端连接错误]\x1b[0m')
  }

  terminalBus.register(props.tab.id, send)
  term.onData((data) => {
    if (!send(data)) return
    terminalBus.broadcastInput(props.tab.id, data)
  })
  term.onSelectionChange(() => {
    const text = term?.getSelection() || ''
    hasSelection.value = !!text
    if (!settings.value.terminal.copyOnSelect || !text) return
    void navigator.clipboard.writeText(text).catch(() => undefined)
  })
  terminalBridges.set(props.tab.id, {
    sessionId,
    ready: () => connected.value,
    insert: command => {
      if (!props.visible || props.tab.session?.session_id !== sessionId || !validCommand(command)) return false
      const sent = send(command)
      if (sent) term?.focus()
      return sent
    },
    queryCwd: () => props.tab.hostId ? send("printf '\\033]7;file://shell-helper%s\\007' \"$PWD\"\n") : false
  })
  term.onResize(({ cols, rows }) => {
    sendResize(cols, rows)
    rememberSize()
  })
}

function sendResize(cols?: number, rows?: number): void {
  if (!ws || ws.readyState !== WebSocket.OPEN || !term) return
  ws.send(JSON.stringify({ type: 'resize', cols: cols ?? term.cols, rows: rows ?? term.rows }))
}

async function toggleShare(): Promise<void> {
  if (shareId.value) {
    const id = shareId.value
    shareId.value = ''
    try { await lan.stopTerminalShare(id); ElMessage.info('已停止共享终端') }
    catch (error) { ElMessage.error((error as Error).message || '停止共享失败') }
    return
  }
  if (!lan.enabled) { ElMessage.warning('请先在局域网面板启用发现'); return }
  try {
    shareId.value = await lan.startTerminalShare({ title: props.tab.title, hostName: props.tab.title })
    ElMessage.success('已共享为只读终端，在线用户可在局域网面板加入')
  } catch (error) { ElMessage.error((error as Error).message || '共享终端失败') }
}

function appendRecording(text: string): void {
  if (!recording.value || !text) return
  recordParts.push(text)
  recordBytes += text.length
  if (recordBytes > 30 * 1024 * 1024) {
    recording.value = false
  if (shareId.value) { void lan.stopTerminalShare(shareId.value).catch(() => undefined); shareId.value = '' }
    void ElMessage.warning('终端录制达到 30 MiB 上限，已自动停止')
  }
}

async function toggleRecording(): Promise<void> {
  if (!recording.value) {
    recordParts.length = 0
    recordBytes = 0
    recording.value = true
    ElMessage.info('开始录制终端输出')
    return
  }
  recording.value = false
  if (shareId.value) { void lan.stopTerminalShare(shareId.value).catch(() => undefined); shareId.value = '' }
  const content = recordParts.join('')
  if (!content.trim()) { ElMessage.info('录制内容为空'); return }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  try {
    const saved = await window.shellHelper.saveRecording({ name: `${props.tab.title}-${stamp}.txt`, content })
    if (saved) ElMessage.success('终端录制已保存')
  } catch (error) {
    ElMessage.error((error as Error).message || '录制保存失败')
  }
}

async function openSearch(): Promise<void> {
  searchOpen.value = true
  await nextTick()
  searchInput.value?.focus()
  searchInput.value?.select()
}

function runSearch(forward: boolean): void {
  if (!searchQuery.value) {
    searchCount.value = 0
    searchIndex.value = -1
    search?.clearDecorations()
    return
  }
  if (forward) search?.findNext(searchQuery.value, { caseSensitive: searchCase.value, decorations: SEARCH_DECORATIONS })
  else search?.findPrevious(searchQuery.value, { caseSensitive: searchCase.value, decorations: SEARCH_DECORATIONS })
}

function toggleSearchCase(): void {
  searchCase.value = !searchCase.value
  if (searchQuery.value) runSearch(true)
}

function onContextMenu(event: MouseEvent): void {
  if (!term) return
  const bounds = host.value?.getBoundingClientRect()
  if (!bounds) return
  const width = 126
  const height = 140
  menu.value = {
    x: Math.max(4, Math.min(event.clientX - bounds.left, bounds.width - width - 4)),
    y: Math.max(4, Math.min(event.clientY - bounds.top, bounds.height - height - 4))
  }
}

async function copySelection(): Promise<void> {
  const text = term?.getSelection() ?? ''
  menu.value = null
  if (text) await navigator.clipboard.writeText(text)
}

function selectAll(): void {
  term?.selectAll()
  hasSelection.value = true
  menu.value = null
  term?.focus()
}

async function pasteClipboard(): Promise<void> {
  menu.value = null
  const text = await navigator.clipboard.readText()
  if (text) term?.paste(text)
  term?.focus()
}

function clearTerminal(): void {
  menu.value = null
  term?.clear()
  term?.focus()
}

function closeMenu(): void {
  menu.value = null
}

watch(
  () => [props.visible, props.tab.session?.session_id, props.tab.connecting] as const,
  async ([vis, sessionId, connecting]) => {
    if (!sessionId) {
      if (term) cleanupTerm()
      return
    }
    if (connecting) return
    await nextTick()
    if (vis && container.value && !term) openTerminal()
    if (vis) resizeTimer = setTimeout(() => { fit?.fit(); rememberSize() }, 50)
  },
  { immediate: true }
)

watch(
  () => props.visible,
  async (vis) => {
    if (vis) {
      await nextTick()
      fit?.fit()
      rememberSize()
      if (props.focus !== false && !hasDialog() && !document.activeElement?.matches('[role="tab"]:focus-visible')) term?.focus()
    }
  }
)

watch(() => settings.value.terminal.fontSize, (size) => {
  if (!term || !size) return
  term.options.fontSize = size
  fit?.fit()
  sendResize()
  rememberSize()
})
watch(() => settings.value.terminal.fontFamily, (family) => {
  if (!term || !family) return
  term.options.fontFamily = family
  fit?.fit()
})
watch(() => settings.value.terminal.theme, (theme) => {
  if (term) term.options.theme = themeOf(theme)
})

onBeforeUnmount(() => {
  window.removeEventListener('click', closeMenu)
  cleanupTerm()
})
window.addEventListener('click', closeMenu)
</script>

<template>
  <div v-show="visible" ref="host" class="terminal-host" :class="{ 'term-light': lightTerminal }" :data-session-id="tab.session?.session_id" @contextmenu.prevent="onContextMenu">
    <div v-if="!searchOpen" class="term-tools">
      <button type="button" aria-label="搜索终端" title="搜索终端 ⌘F" @click="openSearch"><el-icon><Search /></el-icon></button>
      <button type="button" class="term-share" :class="{ active: !!shareId }" :aria-pressed="!!shareId" :title="shareId ? '停止共享当前终端' : '共享当前终端（只读）'" @click="toggleShare"><el-icon><Share /></el-icon>{{ shareId ? '共享中' : '共享' }}</button>
      <button type="button" class="term-rec" :class="{ active: recording }" :aria-pressed="recording" :title="recording ? '停止并保存录制' : '录制终端输出'" @click="toggleRecording"><span class="rec-dot" aria-hidden="true"></span>REC</button>
    </div>
    <div v-if="tab.connecting" class="term-connecting">
      <el-icon class="is-loading"><Loading /></el-icon>
      <span>正在连接 {{ tab.title }}…</span>
    </div>
    <div v-if="searchOpen && !tab.connecting" class="term-search">
      <input ref="searchInput" v-model="searchQuery" aria-label="搜索终端内容" placeholder="搜索终端" @input="runSearch(true)" @keydown.enter.prevent="runSearch(!$event.shiftKey)" @keydown.esc="searchOpen = false" />
      <span class="term-search-count" aria-live="polite">{{ searchCount ? `${searchIndex >= 0 ? searchIndex + 1 : 0}/${searchCount}` : '0/0' }}</span>
      <button type="button" class="term-case" :class="{ active: searchCase }" aria-label="区分大小写" :aria-pressed="searchCase" @click="toggleSearchCase">Aa</button>
      <button type="button" aria-label="上一处" @click="runSearch(false)">上一个</button>
      <button type="button" aria-label="下一处" @click="runSearch(true)">下一个</button>
      <button type="button" aria-label="关闭搜索" @click="searchOpen = false">关闭</button>
    </div>
    <div v-show="!tab.connecting" ref="container" class="term-container"></div>
    <div v-if="showStartupError" class="term-startup-error" role="alert">
      <el-icon class="term-error-icon"><WarningFilled /></el-icon>
      <strong>无法打开终端</strong>
      <p>{{ tab.error }}</p>
      <div class="term-error-actions">
        <button type="button" @click="sessionStore.reconnect(tab.id)">重新连接</button>
        <button type="button" @click="sessionStore.close(tab.id)">关闭标签</button>
      </div>
    </div>
    <div v-if="!tab.connecting && (tab.error || endKind) && !showStartupError" class="term-recovery" role="alert">
      <span>{{ recoveryText }}</span>
      <button type="button" @click="sessionStore.reconnect(tab.id)">{{ recoveryAction }}</button>
      <button type="button" @click="sessionStore.close(tab.id)">关闭标签</button>
    </div>
    <div v-if="menu" class="term-menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }" @click.stop>
      <button type="button" :disabled="!hasSelection" @click="copySelection">复制</button>
      <button type="button" @click="pasteClipboard">粘贴</button>
      <button type="button" @click="selectAll">全选</button>
      <button type="button" @click="clearTerminal">清屏</button>
    </div>
  </div>
</template>

<style scoped>
.terminal-host { position: relative; }
.term-container {
  width: 100%;
  height: 100%;
}
.term-tools { position: absolute; top: 8px; right: 10px; z-index: 4; display: flex; align-items: center; gap: 2px; padding: 2px; border: 1px solid #353638; border-radius: 6px; background: rgba(27, 27, 28, 0.82); }
.term-tools button { height: 23px; display: inline-flex; align-items: center; justify-content: center; gap: 4px; padding: 0 6px; border: 0; border-radius: 4px; background: transparent; color: #adb2b8; font-size: 11px; cursor: pointer; }
.term-tools button:hover { background: #2c2c2e; color: #f9fafb; }
.term-rec.active { color: #f7ad31; }
.term-share.active { color: #7aaaff; }
.rec-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.term-rec.active .rec-dot { background: #f25a5a; animation: rec-pulse 1s ease-in-out infinite; }
@keyframes rec-pulse { 50% { opacity: 0.28; } }
.term-light .term-tools { border-color: #e1e5ee; background: rgba(255, 255, 255, 0.92); }
.term-light .term-tools button { color: #61666b; }
.term-light .term-tools button:hover { background: #f1f3f5; color: #0f1115; }
.term-connecting {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 4px;
  color: var(--sh-terminal-muted);
  font-size: 13px;
  font-family: Menlo, Monaco, monospace;
}
.term-startup-error {
  position: absolute;
  inset: 12px;
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  text-align: center;
  background: var(--sh-bg-terminal);
  color: var(--sh-terminal-text);
}
.term-startup-error strong { font-size: 14px; font-weight: 600; }
.term-startup-error p {
  max-width: 520px;
  margin: 0;
  color: var(--sh-terminal-muted);
  font: 12px/1.7 var(--sh-font-mono);
  overflow-wrap: anywhere;
  user-select: text;
}
.term-error-icon { font-size: 32px; color: var(--sh-terminal-danger); }
.term-error-actions { display: flex; gap: 8px; margin-top: 4px; }
.term-error-actions button {
  border: 0;
  border-radius: 6px;
  padding: 6px 10px;
  background: #3a404b;
  color: var(--sh-terminal-text);
  font-size: 12px;
  cursor: pointer;
}
.term-error-actions button:hover { background: #4a5563; }
.term-search, .term-recovery {
  position: absolute;
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 8px;
}
.term-search {
  top: 8px;
  right: 12px;
  padding: 6px;
  border: 1px solid #353638;
  border-radius: var(--sh-radius-sm);
  background: #1b1b1c;
}
.term-search input {
  width: 180px;
  border: 0;
  outline: 0;
  color: var(--sh-terminal-text);
  background: transparent;
  font: 12px var(--sh-font-mono);
}
.term-search-count { min-width: 38px; text-align: center; color: var(--sh-text-muted); font: 10px var(--sh-font-mono); }
.term-case.active { border-color: var(--sh-accent); color: var(--sh-accent); }
.term-search button, .term-recovery button, .term-menu button {
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--sh-terminal-text);
  font-size: 12px;
  cursor: pointer;
}
.term-search button:hover, .term-menu button:hover { background: #2c2c2e; }
.term-recovery {
  left: 12px;
  right: 12px;
  bottom: 12px;
  padding: 10px 12px;
  border: 1px solid #5a3036;
  border-radius: var(--sh-radius-sm);
  background: #2a1e22;
  color: var(--sh-terminal-text);
  font-size: 12px;
}
.term-recovery span { flex: 1; }
.term-recovery button { padding: 4px 8px; background: #3a404b; }
.term-menu {
  position: absolute;
  z-index: 5;
  min-width: 120px;
  padding: 4px;
  border: 1px solid #353638;
  border-radius: var(--sh-radius-sm);
  background: #1b1b1c;
}
.term-menu button { display: block; width: 100%; padding: 6px 8px; text-align: left; }
.term-menu button:disabled { opacity: 0.35; cursor: default; }

/* 终端切到 light 主题时，搜索条/右键菜单/错误态一起换色 */
.terminal-host.term-light { background: #f9fafb; }
.terminal-host.term-light .term-connecting { color: #61666b; }
.terminal-host.term-light .term-search,
.terminal-host.term-light .term-menu { border-color: #e1e5ee; background: #ffffff; }
.terminal-host.term-light .term-search input,
.terminal-host.term-light .term-search button,
.terminal-host.term-light .term-menu button { color: #0f1115; }
.terminal-host.term-light .term-search button:hover,
.terminal-host.term-light .term-menu button:hover { background: #f1f3f5; }
.terminal-host.term-light .term-recovery {
  border-color: #fecaca;
  background: #fef2f2;
  color: #991b1b;
}
.terminal-host.term-light .term-recovery button { background: #fee2e2; color: #991b1b; }
.terminal-host.term-light .term-startup-error { background: #f9fafb; color: #0f1115; }
.terminal-host.term-light .term-startup-error p { color: #61666b; }
.terminal-host.term-light .term-error-icon { color: #ec1313; }
.terminal-host.term-light .term-error-actions button { background: #f1f3f5; color: #0f1115; }
.terminal-host.term-light .term-error-actions button:hover { background: #e9ecf2; }

.xterm-viewport::-webkit-scrollbar {
  width: 10px;
}
</style>
