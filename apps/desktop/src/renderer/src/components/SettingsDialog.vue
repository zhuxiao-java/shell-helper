<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useSettingsStore } from '@renderer/stores/settings'
import ShortcutRecorder from './ShortcutRecorder.vue'
import { ACTIONS, defaults, validateSettings, type StorageLocationId, type StorageLocations } from '../../../shared/settings'
const store = useSettingsStore()
const draft = ref(defaults())
const section = ref('shortcuts')
const saving = ref(false)
const storage = ref<StorageLocations>({ locations: [] })
const storageLoading = ref(false)
const storageAction = ref('')
const storageLabels: Record<StorageLocationId, { title: string; description: string; icon: string }> = {
  drafts: { title: '临时文件与编辑草稿', description: '远程文本的本地副本。每个文件独立存放，退出后保留，确认回传前请勿清理。', icon: 'DocumentCopy' },
  database: { title: '连接数据库', description: '保存主机、分组和加密凭据。备份或查看前请先退出应用，勿直接修改运行中的数据库。', icon: 'Coin' },
  settings: { title: '应用设置', description: '保存快捷键、终端命令和编辑器偏好。', icon: 'Setting' },
  logs: { title: '运行日志', description: '后端运行记录，用于定位连接与文件传输问题。', icon: 'Tickets' }
}
watch(() => [store.visible, section.value] as const, ([visible, active]) => {
  if (visible && active === 'storage') void loadStorage()
})
async function loadStorage(): Promise<void> {
  if (storageLoading.value) return
  storageLoading.value = true
  try { storage.value = await window.shellHelper.readStorageLocations() }
  catch { storage.value = { locations: [], warning: '无法读取存储位置，请重试。' } }
  finally { storageLoading.value = false }
}
async function storageOperation(id: StorageLocationId, action: 'open' | 'copy'): Promise<void> {
  storageAction.value = `${action}:${id}`
  try {
    if (action === 'open') await window.shellHelper.openStorageLocation(id)
    else { await window.shellHelper.copyStorageLocation(id); ElMessage.success('路径已复制') }
  } catch (error) { ElMessage.error((error as Error).message) }
  finally { storageAction.value = '' }
}
watch(() => store.visible, visible => {
  if (visible) draft.value = JSON.parse(JSON.stringify(store.value))
  else store.recording = false
})
const validation = computed(() => {
  try { validateSettings(draft.value); return '' } catch (error) { return (error as Error).message }
})
async function save(): Promise<void> {
  saving.value = true
  try { await store.save(draft.value); store.visible = false; ElMessage.success('设置已保存') }
  catch (error) { ElMessage.error((error as Error).message) }
  finally { saving.value = false }
}
async function chooseEditor(): Promise<void> {
  try {
    const file = await window.shellHelper.chooseEditor()
    if (file) { draft.value.editor.path = file; draft.value.editor.mode = 'custom' }
  } catch (error) { ElMessage.error((error as Error).message) }
}
async function reset(): Promise<void> {
  try {
    await ElMessageBox.confirm('恢复所有快捷键、终端命令和编辑器设置？保存后生效。', '恢复默认', { confirmButtonText: '恢复默认', cancelButtonText: '取消' })
    draft.value = defaults()
  } catch { /* 用户取消。 */ }
}
function addCommand(): void {
  draft.value.commands.push({ id: crypto.randomUUID(), name: '', command: '', shortcut: '', enabled: true })
}
</script>

<template>
  <el-dialog v-model="store.visible" title="设置" width="760px" top="7vh" :close-on-click-modal="false" :close-on-press-escape="!store.recording" destroy-on-close>
    <el-tabs v-model="section">
      <el-tab-pane label="快捷键" name="shortcuts">
        <p class="setting-note">快捷键仅在应用内生效。输入框、弹窗和输入法优先；终端保留 Ctrl 控制键，请使用带 Shift/Alt 的组合。</p>
        <div v-for="(label, id) in ACTIONS" :key="id" class="binding-row">
          <span>{{ label }}</span>
          <ShortcutRecorder v-model="draft.bindings[id].shortcut" :label="label" />
          <el-switch v-model="draft.bindings[id].enabled" :aria-label="`启用${label}`" />
        </div>
      </el-tab-pane>
      <el-tab-pane label="终端命令" name="commands">
        <p class="setting-note">确认目标后仅插入当前终端，由你按 Enter 执行。不支持自动连接、群发或本机执行。请勿在命令中保存密码或密钥。</p>
        <div v-for="(command, index) in draft.commands" :key="command.id" class="command-card">
          <div class="command-heading">
            <el-input v-model="command.name" placeholder="命令名称" aria-label="命令名称" maxlength="100" />
            <el-switch v-model="command.enabled" aria-label="启用命令" />
            <el-button text type="danger" @click="draft.commands.splice(index, 1)">删除</el-button>
          </div>
          <el-input v-model="command.command" placeholder="单行命令，例如 git status" aria-label="单行命令" maxlength="4096" />
          <ShortcutRecorder v-model="command.shortcut" :label="command.name || '命令'" />
        </div>
        <el-button :disabled="draft.commands.length >= 100" @click="addCommand">添加终端命令</el-button>
      </el-tab-pane>
      <el-tab-pane label="外部编辑器" name="editor">
        <p class="setting-note">仅支持 10 MiB 以内的普通文本文件，保持原始编码和换行。修改后需要明确确认才会回传远程。</p>
        <el-radio-group v-model="draft.editor.mode" class="editor-options">
          <el-radio value="default">系统默认文本应用（安全 .txt 副本）</el-radio>
          <el-radio value="custom">指定文本编辑器（保留原始扩展名）</el-radio>
        </el-radio-group>
        <div class="editor-path">
          <el-input :model-value="draft.editor.path" readonly placeholder="选择 Notepad++、Sublime Text 等编辑器" aria-label="编辑器路径" />
          <el-button @click="chooseEditor">选择程序…</el-button>
        </div>
        <p class="setting-note">macOS 支持 .app 或可执行程序；Windows 支持 .exe；Linux 支持可执行程序。编辑器不可用时可从外部编辑列表改用默认应用。</p>
        <el-button text :icon="'FolderOpened'" @click="section = 'storage'">查看临时文件存储位置</el-button>
      </el-tab-pane>
      <el-tab-pane label="存储位置" name="storage">
        <div class="storage-intro"><div><h3>你的数据，存在哪里</h3><p>以下为当前实际使用的位置，可复制完整路径或在系统文件管理器中查看。</p></div><el-button text :icon="'Refresh'" :loading="storageLoading" @click="loadStorage">刷新</el-button></div>
        <p v-if="storage.warning" class="storage-warning" role="alert">{{ storage.warning }}</p>
        <p v-if="storageLoading && !storage.locations.length" class="setting-note" role="status">正在读取存储位置…</p>
        <article v-for="item in storage.locations" :key="item.id" class="storage-card" :data-storage-id="item.id">
          <div class="storage-heading"><span class="storage-icon"><el-icon><component :is="storageLabels[item.id].icon" /></el-icon></span><div><h4>{{ storageLabels[item.id].title }}</h4><p>{{ storageLabels[item.id].description }}</p></div></div>
          <code v-if="item.path" class="storage-path">{{ item.path }}</code>
          <p v-else class="storage-unavailable">{{ item.unavailable }}</p>
          <div class="storage-actions"><el-button size="small" text :icon="'CopyDocument'" :disabled="!item.path || !!storageAction" :loading="storageAction === `copy:${item.id}`" @click="storageOperation(item.id, 'copy')">复制路径</el-button><el-button size="small" :icon="'FolderOpened'" :disabled="!item.path || !!storageAction" :loading="storageAction === `open:${item.id}`" @click="storageOperation(item.id, 'open')">{{ item.id === 'database' || item.id === 'settings' ? '打开所在目录' : '打开目录' }}</el-button></div>
        </article>
        <p class="storage-safety"><el-icon><Lock /></el-icon>草稿可能包含远程文件的敏感内容；数据库和日志请勿随意分享。</p>
      </el-tab-pane>
    </el-tabs>
    <p v-if="validation" class="validation-error" role="alert">{{ validation }}</p>
    <template #footer>
      <div class="settings-footer">
        <el-button text @click="reset">恢复默认</el-button>
        <span></span>
        <el-button @click="store.visible = false">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="!!validation || !store.ready" @click="save">保存设置</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.setting-note { font-size: 12px; line-height: 1.8; color: var(--sh-text-muted); margin: 0 0 18px; }
.binding-row { display: grid; grid-template-columns: 1fr 300px 40px; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--sh-border); font-size: 13px; }
.command-card { padding: 16px; margin-bottom: 14px; border: 1px solid var(--sh-border); border-radius: 10px; display: grid; gap: 12px; background: var(--sh-bg-elevated); }
.command-heading, .editor-path, .settings-footer { display: flex; align-items: center; gap: 12px; }
.settings-footer > span { flex: 1; }
.editor-options { display: flex; align-items: flex-start; flex-direction: column; margin-bottom: 20px; }
.editor-path { margin-bottom: 18px; }
.validation-error { color: var(--sh-danger); font-size: 12px; }
.storage-intro { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin: 8px 0 20px; }
.storage-intro h3 { font-size: 17px; font-weight: 600; margin: 0 0 8px; color: var(--sh-text); }
.storage-intro p, .storage-heading p { font-size: 12px; line-height: 1.7; color: var(--sh-text-muted); margin: 0; }
.storage-card { padding: 16px 18px; margin-bottom: 12px; border: 1px solid var(--sh-border); border-radius: 10px; background: #fcfcfa; }
.storage-heading { display: flex; gap: 12px; align-items: flex-start; }
.storage-icon { width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center; flex-shrink: 0; color: var(--sh-accent); background: #eaf0e6; font-size: 18px; }
.storage-heading h4 { font-size: 13px; font-weight: 600; margin: 0 0 4px; color: var(--sh-text); }
.storage-path { display: block; margin: 12px 0 10px; padding: 10px 12px; border: 1px solid #eceee7; border-radius: 6px; background: #f3f5f0; color: #56634f; font: 11px/1.7 var(--sh-font-mono); white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; cursor: text; }
.storage-actions { display: flex; justify-content: flex-end; gap: 8px; }
.storage-actions :deep(.el-button + .el-button) { margin-left: 0; }
.storage-warning { padding: 10px 12px; background: #faf2e4; color: #856837; border-radius: 6px; font-size: 12px; line-height: 1.7; }
.storage-unavailable { font-size: 12px; color: var(--sh-text-muted); }
.storage-safety { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--sh-text-muted); line-height: 1.7; }
</style>
