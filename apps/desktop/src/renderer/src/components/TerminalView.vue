<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { getWsUrl } from '@renderer/api/client'
import type { Tab } from '@renderer/stores/session'
import { terminalBridges } from '@renderer/utils/workspace'
import { dispatchShortcut, hasDialog } from '@renderer/utils/shortcuts'
import { validCommand } from '../../../shared/settings'

const props = defineProps<{ tab: Tab; visible: boolean }>()

const container = ref<HTMLDivElement>()
let term: Terminal | null = null
let fit: FitAddon | null = null
let ws: WebSocket | null = null
const connected = ref(false)
let resizeTimer: ReturnType<typeof setTimeout> | null = null
let resizeObserver: ResizeObserver | null = null

// 监听容器尺寸变化,重新 fit 终端(窗口缩放/侧栏拖拽均可自适应)
function observeResize(): void {
  if (!container.value || resizeObserver) return
  resizeObserver = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      fit?.fit()
      sendResize()
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

function openTerminal(): void {
  const sessionId = props.tab.session?.session_id
  if (!sessionId || term) return

  term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
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
  term.loadAddon(fit)
  term.open(container.value!)
  term.attachCustomKeyEventHandler(event => !dispatchShortcut(event))
  fit.fit()
  observeResize()

  ws = new WebSocket(getWsUrl(`/api/terminals/${sessionId}/ws`))
  ws.binaryType = 'arraybuffer'

  ws.onopen = () => {
    connected.value = true
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
    if (props.tab.session) props.tab.session.status = 'closed'
    term?.writeln(event.code === 1000
      ? '\r\n\x1b[90m[终端已结束]\x1b[0m'
      : '\r\n\x1b[31m[连接已断开]\x1b[0m')
  }
  ws.onerror = () => {
    connected.value = false
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
  })
}

function sendResize(cols?: number, rows?: number): void {
  if (!ws || ws.readyState !== WebSocket.OPEN || !term) return
  ws.send(JSON.stringify({ type: 'resize', cols: cols ?? term.cols, rows: rows ?? term.rows }))
}

function destroy(): void {
  terminalBridges.delete(props.tab.id)
  if (resizeTimer) clearTimeout(resizeTimer)
  resizeObserver?.disconnect()
  resizeObserver = null
  disconnectWs(false)
  term?.dispose()
  term = null
  fit = null
}

watch(
  () => [props.visible, props.tab.session, props.tab.connecting] as const,
  async ([vis]) => {
    if (props.tab.session && !props.tab.connecting) {
      await nextTick()
      if (vis && container.value && !term) openTerminal()
      if (vis) {
        // 首次可能因隐藏导致尺寸为 0,延迟再 fit
        resizeTimer = setTimeout(() => fit?.fit(), 50)
      }
    }
  },
  { immediate: true }
)

watch(
  () => props.visible,
  async (vis) => {
    if (vis) {
      await nextTick()
      fit?.fit()
      if (!hasDialog() && !document.activeElement?.matches('[role="tab"]:focus-visible')) term?.focus()
    }
  }
)

onBeforeUnmount(destroy)
</script>

<template>
  <div v-show="visible" class="terminal-host" :data-session-id="tab.session?.session_id">
    <div v-if="tab.connecting" class="term-connecting">
      <el-icon class="is-loading"><Loading /></el-icon>
      <span>正在连接 {{ tab.title }}…</span>
    </div>
    <div v-show="!tab.connecting" ref="container" class="term-container"></div>
  </div>
</template>

<style scoped>
.term-container {
  width: 100%;
  height: 100%;
}
/* 连接中提示使用终端专属深色配色 */
.term-connecting {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 4px;
  color: var(--sh-terminal-muted);
  font-size: 13px;
  font-family: Menlo, Monaco, monospace;
}
.xterm-viewport::-webkit-scrollbar {
  width: 10px;
}
</style>
