<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useHostStore } from '@renderer/stores/host'
import { useSettingsStore } from '@renderer/stores/settings'
import type { TerminalCommand } from '../../../shared/settings'

const open = defineModel<boolean>({ required: true })
const emit = defineEmits<{
  (e: 'connect', id: string): void
  (e: 'command', command: TerminalCommand): void
}>()
const hosts = useHostStore()
const settings = useSettingsStore()
const query = ref('')
const input = ref<HTMLInputElement>()
const active = ref(0)
const previousFocus = ref<HTMLElement | null>(null)

const items = computed(() => {
  const text = query.value.trim().toLowerCase()
  const connections = hosts.hosts
    .filter(host => !text || `${host.name} ${host.host} ${host.tags}`.toLowerCase().includes(text))
    .slice(0, 8)
    .map(host => ({ kind: 'host' as const, id: host.id, title: host.name, detail: host.protocol === 'local' ? '本地终端' : `${host.username}@${host.host}`, group: '' }))
  const commands = settings.value.commands
    .filter(command => command.enabled && (!text || `${command.name} ${command.command}`.toLowerCase().includes(text)))
    .slice(0, 8)
    .map(command => ({ kind: 'command' as const, id: command.id, title: command.name, detail: command.command, command, group: '' }))
  const result = [...connections, ...commands]
  if (result.length) {
    const firstCommand = connections.length
    result[0].group = '连接'
    if (firstCommand < result.length) result[firstCommand].group = '终端命令'
    if (!connections.length && commands.length) result[0].group = '终端命令'
  }
  return result
})

const activeId = computed(() => {
  const item = items.value[active.value]
  return item ? `palette-${item.kind}-${item.id}` : undefined
})

watch(open, async (value) => {
  if (!value) {
    await nextTick()
    if (previousFocus.value?.isConnected) previousFocus.value.focus()
    previousFocus.value = null
    return
  }
  previousFocus.value = document.activeElement as HTMLElement | null
  query.value = ''
  active.value = 0
  await nextTick()
  input.value?.focus()
})
watch(items, () => { active.value = Math.min(active.value, Math.max(0, items.value.length - 1)) })
watch(active, async () => {
  await nextTick()
  activeId.value && document.getElementById(activeId.value)?.scrollIntoView({ block: 'nearest' })
})

function choose(index = active.value): void {
  const item = items.value[index]
  if (!item) return
  open.value = false
  if (item.kind === 'host') emit('connect', item.id)
  else emit('command', item.command)
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') { event.preventDefault(); active.value = Math.min(items.value.length - 1, active.value + 1) }
  else if (event.key === 'ArrowUp') { event.preventDefault(); active.value = Math.max(0, active.value - 1) }
  else if (event.key === 'Enter') { event.preventDefault(); choose() }
  else if (event.key === 'Escape') { event.preventDefault(); open.value = false }
  else if (event.key === 'Tab') { event.preventDefault(); input.value?.focus() }
}
</script>

<template>
  <div v-if="open" class="palette-mask" @mousedown.self="open = false">
    <div class="palette" role="dialog" aria-label="命令面板" @keydown="onKey">
      <input
        ref="input"
        v-model="query"
        role="combobox"
        aria-label="搜索连接或命令"
        aria-autocomplete="list"
        aria-controls="palette-list"
        :aria-expanded="true"
        :aria-activedescendant="activeId"
        placeholder="搜索连接或终端命令"
      />
      <div id="palette-list" class="palette-list" role="listbox" aria-label="连接与终端命令">
        <template v-for="(item, index) in items" :key="`${item.kind}-${item.id}`">
          <span v-if="item.group" class="palette-group" role="presentation">{{ item.group }}</span>
          <button
            :id="`palette-${item.kind}-${item.id}`"
            type="button"
            role="option"
            :aria-selected="index === active"
            :class="{ active: index === active }"
            @click="choose(index)"
          >
            <strong>{{ item.title }}</strong>
            <span>{{ item.detail }}</span>
          </button>
        </template>
        <p v-if="!items.length">没有匹配的连接或命令</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.palette-mask { position: fixed; inset: 0; background: rgba(15, 17, 21, 0.32); display: flex; justify-content: center; padding-top: 12vh; z-index: 30; }
.palette {
  align-self: flex-start;
  width: min(520px, calc(100vw - 48px));
  max-height: min(62vh, 560px);
  overflow: hidden;
  background: var(--sh-bg-panel);
  border: 1px solid var(--sh-border);
  border-radius: var(--sh-radius-lg);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  box-shadow: var(--sh-shadow-pop);
}
.palette input, .palette button { border: 0; background: transparent; color: var(--sh-text); text-align: left; }
.palette input { flex-shrink: 0; height: 36px; padding: 0 8px; font-size: 14px; outline: none; }
.palette-list { display: flex; flex-direction: column; gap: 4px; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.palette-group { padding: 6px 8px 2px; font: 10px var(--sh-font-mono); letter-spacing: 0.8px; color: var(--sh-text-muted); text-transform: uppercase; }
.palette-list button { display: flex; justify-content: space-between; gap: 12px; padding: 8px; border-radius: 6px; cursor: pointer; }
.palette-list button.active, .palette-list button:hover { background: var(--sh-bg-active); }
.palette span, .palette p { color: var(--sh-text-muted); font-size: 12px; }
.palette strong { font-weight: 600; font-size: 13px; }
</style>
