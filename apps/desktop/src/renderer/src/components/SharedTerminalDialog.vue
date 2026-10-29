<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useSettingsStore } from '@renderer/stores/settings'
import { useLanStore } from '@renderer/stores/lan'
import type { SharedTerminal } from '../../../shared/lan'

const open = defineModel<boolean>({ required: true })
const props = defineProps<{ terminal: SharedTerminal | null }>()
const settings = useSettingsStore()
const lan = useLanStore()
const host = ref<HTMLDivElement>()
let term: Terminal | null = null
let fit: FitAddon | null = null
let unsubscribe: (() => void) | undefined
let observer: ResizeObserver | null = null

const themes = {
  dark: { background: '#0f1115', foreground: '#f9fafb', cursor: '#7aaaff', selectionBackground: 'rgba(86, 134, 254, 0.28)' },
  light: { background: '#f9fafb', foreground: '#0f1115', cursor: '#3468d8', selectionBackground: 'rgba(52, 104, 216, 0.18)' }
}

function setup(): void {
  if (!host.value || term) return
  term = new Terminal({
    cursorBlink: false,
    disableStdin: true,
    fontSize: settings.value.terminal.fontSize,
    fontFamily: settings.value.terminal.fontFamily,
    lineHeight: 1.4,
    scrollback: 5000,
    theme: settings.value.terminal.theme === 'light' ? themes.light : themes.dark
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.open(host.value)
  fit.fit()
  observer = new ResizeObserver(() => fit?.fit())
  observer.observe(host.value)
  unsubscribe = lan.onTerminalOutput(payload => {
    if (payload.id === props.terminal?.id) term?.write(payload.data)
  })
}

function teardown(): void {
  unsubscribe?.()
  unsubscribe = undefined
  observer?.disconnect()
  observer = null
  term?.dispose()
  term = null
  fit = null
}

watch(open, async value => {
  if (value) {
    await nextTick()
    setup()
  } else {
    if (props.terminal && !props.terminal.self) void lan.leaveTerminal(props.terminal.id)
    teardown()
  }
}, { immediate: true })
watch(() => props.terminal?.id, async () => {
  teardown()
  if (open.value) { await nextTick(); setup() }
})
watch(() => lan.terminals.some(item => item.id === props.terminal?.id), exists => {
  if (!exists && open.value) open.value = false
})
onBeforeUnmount(teardown)
</script>

<template>
  <el-dialog v-model="open" :title="terminal?.title || '共享终端'" width="820px" append-to-body class="shared-terminal-dialog">
    <div class="shared-head">
      <span class="shared-live"></span>
      <span>只读共享</span>
      <span class="shared-sep">·</span>
      <span>{{ terminal?.ownerName || '局域网用户' }} 的终端</span>
      <span v-if="terminal?.hostName" class="shared-host">{{ terminal.hostName }}</span>
    </div>
    <div ref="host" class="shared-term"></div>
    <p class="shared-note">这是对方终端的实时只读副本，不包含输入控制。输出通过局域网传输，可能包含敏感信息。</p>
  </el-dialog>
</template>

<style scoped>
.shared-head { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; color: var(--sh-text-muted); font-size: 11px; }
.shared-live { width: 6px; height: 6px; border-radius: 50%; background: var(--sh-success); }
.shared-sep { opacity: 0.5; }
.shared-host { margin-left: auto; color: var(--sh-text-muted); font: 10px var(--sh-font-mono); }
.shared-term { height: 430px; padding: 10px; border-radius: 8px; background: #0f1115; overflow: hidden; }
.shared-note { margin: 8px 0 0; color: var(--sh-text-muted); font-size: 10px; line-height: 1.6; }
</style>
