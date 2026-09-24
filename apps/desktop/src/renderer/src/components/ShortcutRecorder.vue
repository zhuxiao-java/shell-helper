<script setup lang="ts">
import { ref, onBeforeUnmount } from 'vue'
import { useSettingsStore } from '@renderer/stores/settings'
import { fromKey, shortcutError, displayShortcut } from '../../../shared/settings'
const value = defineModel<string>({ required: true })
const props = defineProps<{ label: string }>()
const settings = useSettingsStore()
const active = ref(false)
const error = ref('')
function stop(): void { active.value = false; settings.recording = false }
function capture(event: KeyboardEvent): void {
  if (!active.value) return
  event.preventDefault()
  event.stopPropagation()
  if (event.repeat || event.isComposing || event.keyCode === 229) return
  if (event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.altKey) { stop(); return }
  const shortcut = fromKey(event, settings.mac)
  if (!shortcut) { error.value = '请继续按下非修饰键'; return }
  error.value = shortcutError(shortcut) || ''
  if (error.value) return
  value.value = shortcut
  stop()
}
onBeforeUnmount(stop)
</script>

<template>
  <div class="shortcut-recorder">
    <button class="record-key" :aria-label="`${props.label}快捷键`" :aria-pressed="active" @click="active = true; settings.recording = true; error = ''" @keydown="capture" @blur="stop">
      {{ active ? '按下组合键…（Esc 取消）' : displayShortcut(value, settings.mac) || '未绑定 · 点击录制' }}
    </button>
    <el-button text size="small" :aria-label="`清除${props.label}快捷键`" @click="value = ''; stop()">清除</el-button>
    <small v-if="error" role="alert">{{ error }}</small>
  </div>
</template>

<style scoped>
.shortcut-recorder { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; }
.record-key { min-width: 180px; padding: 8px 12px; border: 1px solid var(--sh-border); border-radius: 7px; background: var(--sh-bg); color: var(--sh-text-secondary); font: 12px var(--sh-font-mono); cursor: pointer; }
.record-key[aria-pressed="true"] { border-color: var(--sh-accent); color: var(--sh-accent); }
small { width: 100%; color: var(--sh-danger); }
</style>
