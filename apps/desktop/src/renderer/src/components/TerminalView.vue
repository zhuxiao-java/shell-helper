<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { getWsUrl } from '@renderer/api/client'
import type { Tab } from '@renderer/stores/session'
import { useSessionStore } from '@renderer/stores/session'
import { useSettingsStore } from '@renderer/stores/settings'
import { sessionMeta, terminalBridges } from '@renderer/utils/workspace'
import { dispatchShortcut, hasDialog } from '@renderer/utils/shortcuts'
import { validCommand } from '../../../shared/settings'

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
let resizeObserver: ResizeObserver | null = null

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

function cleanupTerm(): void {
  terminalBridges.delete(props.tab.id)
  delete sessionMeta.terminal[props.tab.id]
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
    fontFamily: "Menlo, Monaco, 'JetBrains Mono', 'Courier New', monospace",
    lineHeight: 1.4,
    scrollback: 5000,
    theme: {
      background: '#16181d',
      foreground: '#e6e9ef',
      cursor: '#a8c5a4',
      cursorAccent: '#16181d',
      selectionBackground: 'rgba(134, 171, 143, 0.28)',
      black: '#3a404b',
      red: '#f0616d',
      green: '#46b58f',
      yellow: '#d6a34a',
      blue: '#5aa2e6',
      magenta: '#d17fb0',
      cyan: '#4bb6c4',
      white: '#c0c7d1',
      brightBlack: '#69717f',
      brightRed: '#ff7b86',
      brightGreen: '#5cd1a4',
      brightYellow: '#eab85a',
      brightBlue: '#7bb8f5',
      brightMagenta: '#e296c2',
      brightCyan: '#63d0dd',
      brightWhite: '#e6e9ef'
    },
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

  ws.onopen = () => {
    connected.value = true
    ended.value = false
    sendResize()
    if (props.visible && !hasDialog()) term!.focus()
  }
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      term!.write(new Uint8Array(ev.data))
    } else {
      term!.write(String(ev.data))
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

  const send = (data: string): boolean => {
    if (!connected.value || ws?.readyState !== WebSocket.OPEN) return false
    ws.send(new TextEncoder().encode(data))
    return true
  }
  term.onData(send)
  terminalBridges.set(props.tab.id, {
    sessionId,
    ready: () => connected.value,
    insert: command => {
      if (!props.visible || props.tab.session?.session_id !== sessionId || !validCommand(command)) return false
      const sent = send(command)
      if (sent) term?.focus()
      return sent
    }
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
