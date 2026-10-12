<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { getWsUrl } from '@renderer/api/client'
import { localCwd } from '@renderer/api/sessions'
import type { Tab } from '@renderer/stores/session'
import { useSessionStore } from '@renderer/stores/session'
import { useSettingsStore } from '@renderer/stores/settings'
import { sessionMeta, terminalBridges } from '@renderer/utils/workspace'
import { dispatchShortcut, hasDialog } from '@renderer/utils/shortcuts'
import { validCommand, type TerminalTheme } from '../../../shared/settings'

const props = defineProps<{ tab: Tab; visible: boolean }>()
const sessionStore = useSessionStore()
const settings = useSettingsStore()

const container = ref<HTMLDivElement>()
const host = ref<HTMLDivElement>()
const searchInput = ref<HTMLInputElement>()
const searchOpen = ref(false)
const searchQuery = ref('')
const menu = ref<{ x: number; y: number } | null>(null)
let term: Terminal | null = null
let fit: FitAddon | null = null
let search: SearchAddon | null = null
let ws: WebSocket | null = null
const connected = ref(false)
const ended = ref(false)
let resizeTimer: ReturnType<typeof setTimeout> | null = null
let cwdTimer: ReturnType<typeof setTimeout> | null = null
let resizeObserver: ResizeObserver | null = null
let oscBuffer = ''
const outputDecoder = new TextDecoder('utf-8')

const TERMINAL_THEMES: Record<TerminalTheme, NonNullable<Terminal['options']['theme']>> = {
  dark: { background: '#16181d', foreground: '#e6e9ef', cursor: '#a8c5a4', cursorAccent: '#16181d', selectionBackground: 'rgba(134, 171, 143, 0.28)', black: '#3a404b', red: '#f0616d', green: '#46b58f', yellow: '#d6a34a', blue: '#5aa2e6', magenta: '#d17fb0', cyan: '#4bb6c4', white: '#c0c7d1', brightBlack: '#69717f', brightRed: '#ff7b86', brightGreen: '#5cd1a4', brightYellow: '#eab85a', brightBlue: '#7bb8f5', brightMagenta: '#e296c2', brightCyan: '#63d0dd', brightWhite: '#e6e9ef' },
  light: { background: '#f7f5f0', foreground: '#2c3138', cursor: '#3d6b4f', cursorAccent: '#f7f5f0', selectionBackground: 'rgba(61, 107, 79, 0.22)', black: '#2c3138', red: '#b94a55', green: '#2f8f6b', yellow: '#9a7430', blue: '#3d74b5', magenta: '#9a5d86', cyan: '#2f8f9a', white: '#5c6570' },
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
  search = null
  connected.value = false
}

function openTerminal(): void {
  const sessionId = props.tab.session?.session_id
  if (!sessionId || term || !container.value) return
  ended.value = false

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
    ended.value = false
    sendResize()
    if (props.visible && !hasDialog()) term!.focus()
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
      try { noteOutput(outputDecoder.decode(bytes, { stream: true })) } catch { /* 目录标记解析失败不影响输出 */ }
    } else {
      const text = String(ev.data)
      term!.write(text)
      try { noteOutput(text) } catch { /* 目录标记解析失败不影响输出 */ }
    }
  }
  ws.onclose = (event) => {
    connected.value = false
    ended.value = true
    if (props.tab.session) props.tab.session.status = 'closed'
    term?.writeln(event.code === 1000
      ? '\r\n\x1b[90m[终端已结束]\x1b[0m'
      : '\r\n\x1b[31m[连接已断开]\x1b[0m')
  }
  ws.onerror = () => {
    connected.value = false
    ended.value = true
    term?.writeln('\r\n\x1b[31m[终端连接错误]\x1b[0m')
  }

  term.onData(send)
  term.onSelectionChange(() => {
    if (!settings.value.terminal.copyOnSelect) return
    const text = term?.getSelection() || ''
    if (text) void navigator.clipboard.writeText(text).catch(() => undefined)
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

async function openSearch(): Promise<void> {
  searchOpen.value = true
  await nextTick()
  searchInput.value?.focus()
  searchInput.value?.select()
}

function runSearch(forward: boolean): void {
  if (!searchQuery.value) return
  if (forward) search?.findNext(searchQuery.value)
  else search?.findPrevious(searchQuery.value)
}

function onContextMenu(event: MouseEvent): void {
  if (!term) return
  const bounds = host.value?.getBoundingClientRect()
  menu.value = {
    x: event.clientX - (bounds?.left ?? 0),
    y: event.clientY - (bounds?.top ?? 0)
  }
}

async function copySelection(): Promise<void> {
  const text = term?.getSelection() ?? ''
  menu.value = null
  if (text) await navigator.clipboard.writeText(text)
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
      if (!hasDialog() && !document.activeElement?.matches('[role="tab"]:focus-visible')) term?.focus()
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
  <div v-show="visible" ref="host" class="terminal-host" :data-session-id="tab.session?.session_id" @contextmenu.prevent="onContextMenu">
    <div v-if="tab.connecting" class="term-connecting">
      <el-icon class="is-loading"><Loading /></el-icon>
      <span>正在连接 {{ tab.title }}…</span>
    </div>
    <div v-if="searchOpen && !tab.connecting" class="term-search">
      <input ref="searchInput" v-model="searchQuery" aria-label="搜索终端内容" placeholder="搜索终端" @keydown.enter.prevent="runSearch(!($event as KeyboardEvent).shiftKey)" @keydown.esc="searchOpen = false" />
      <button type="button" aria-label="上一处" @click="runSearch(false)">上一个</button>
      <button type="button" aria-label="下一处" @click="runSearch(true)">下一个</button>
      <button type="button" aria-label="关闭搜索" @click="searchOpen = false">关闭</button>
    </div>
    <div v-show="!tab.connecting" ref="container" class="term-container"></div>
    <div v-if="!tab.connecting && (tab.error || ended)" class="term-recovery" role="alert">
      <span>{{ tab.error || '连接已断开，输出仍保留在上方' }}</span>
      <button type="button" @click="sessionStore.reconnect(tab.id)">重新连接</button>
      <button type="button" @click="sessionStore.close(tab.id)">关闭标签</button>
    </div>
    <div v-if="menu" class="term-menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }" @click.stop>
      <button type="button" @click="copySelection">复制</button>
      <button type="button" @click="pasteClipboard">粘贴</button>
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
.term-connecting {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 4px;
  color: var(--sh-terminal-muted);
  font-size: 13px;
  font-family: Menlo, Monaco, monospace;
}
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
  border: 1px solid #3a404b;
  border-radius: 8px;
  background: #22262d;
}
.term-search input {
  width: 180px;
  border: 0;
  outline: 0;
  color: var(--sh-terminal-text);
  background: transparent;
  font: 12px var(--sh-font-mono);
}
.term-search button, .term-recovery button, .term-menu button {
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--sh-terminal-text);
  font-size: 12px;
  cursor: pointer;
}
.term-search button:hover, .term-menu button:hover { background: #31363f; }
.term-recovery {
  left: 12px;
  right: 12px;
  bottom: 12px;
  padding: 10px 12px;
  border: 1px solid #5a3036;
  border-radius: 8px;
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
  border: 1px solid #3a404b;
  border-radius: 8px;
  background: #22262d;
}
.term-menu button { display: block; width: 100%; padding: 6px 8px; text-align: left; }
.xterm-viewport::-webkit-scrollbar {
  width: 10px;
}
</style>
