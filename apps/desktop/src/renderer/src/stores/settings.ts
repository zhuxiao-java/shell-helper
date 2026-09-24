import { ref } from 'vue'
import { defineStore } from 'pinia'
import { ElMessage } from 'element-plus'
import { defaults, displayShortcut, validateSettings, type ActionId, type Settings } from '../../../shared/settings'

export const useSettingsStore = defineStore('settings', () => {
  const value = ref(defaults())
  const ready = ref(false)
  const recording = ref(false)
  const visible = ref(false)
  const mac = /Mac/i.test(navigator.platform)
  async function load(): Promise<void> {
    try {
      const result = await window.shellHelper.readSettings()
      value.value = validateSettings(result.settings)
      if (result.warning) ElMessage.warning(result.warning)
      ready.value = true
    } catch (error) { ElMessage.error(`无法读取设置：${(error as Error).message}`) }
  }
  async function save(settings: Settings): Promise<void> {
    value.value = await window.shellHelper.saveSettings(validateSettings(settings))
  }
  function hint(id: ActionId): string {
    const binding = value.value.bindings[id]
    return binding.enabled ? displayShortcut(binding.shortcut, mac) : ''
  }
  return { value, ready, recording, visible, mac, load, save, hint }
})
