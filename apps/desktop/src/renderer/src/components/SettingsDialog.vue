<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useSettingsStore } from '@renderer/stores/settings'
import ShortcutRecorder from './ShortcutRecorder.vue'
import { ACTIONS, defaults, validateSettings, type Appearance, type StorageLocationId, type StorageLocations, type TerminalTheme } from '../../../shared/settings'
const store = useSettingsStore()
const draft = ref(defaults())
const section = ref('shortcuts')
const saving = ref(false)
const storage = ref<StorageLocations>({ locations: [], root: '' })
const storageLoading = ref(false)
const storageAction = ref('')
const themeQuery = window.matchMedia('(prefers-color-scheme: dark)')
const shortcutQuery = ref('')
const actionDescriptions: Record<keyof typeof ACTIONS, string> = {
  newConnection: '打开新建连接表单',
  searchConnections: '搜索主机或终端命令',
  toggleSidebar: '收起或显示左侧连接库',
  goHome: '回到工作台起始页',
  closeTab: '关闭当前会话标签',
  previousTab: '切换到左侧标签',
  nextTab: '切换到右侧标签',
  refreshFiles: '刷新当前文件目录',
  openFile: '用外部编辑器打开选中文件',
  openSettings: '打开设置面板'
}
const shortcutRows = computed(() => {
  const text = shortcutQuery.value.trim().toLocaleLowerCase()
  return (Object.entries(ACTIONS) as [keyof typeof ACTIONS, string][]).filter(([id, label]) => {
    if (!text) return true
    return `${label} ${actionDescriptions[id]}`.toLocaleLowerCase().includes(text)
  })
})
const editorOptions: { value: 'default' | 'custom'; title: string; description: string; icon: string }[] = [
  { value: 'default', title: '系统默认应用', description: '生成安全的 .txt 副本，交给系统默认文本应用打开。', icon: 'Document' },
  { value: 'custom', title: '指定文本编辑器', description: '保留原始扩展名，使用 Notepad++、Sublime Text 等编辑器。', icon: 'EditPen' }
]
const appearanceOptions: { value: Appearance; label: string; description: string }[] = [
  { value: 'light', label: '浅色', description: '明亮工作区' },
  { value: 'dark', label: '深色', description: '低光环境' },
  { value: 'system', label: '跟随系统', description: '随系统切换' }
]
const terminalThemeOptions: { value: TerminalTheme; label: string }[] = [
  { value: 'dark', label: '深色' },
  { value: 'light', label: '浅色' },
  { value: 'solarized', label: 'Solarized' },
  { value: 'dracula', label: 'Dracula' },
  { value: 'monokai', label: 'Monokai' }
]
const terminalPreviews: Record<TerminalTheme, { bg: string; fg: string; dim: string; green: string; blue: string; border: string; bar: string; label: string }> = {
  dark: { bg: '#0f1115', fg: '#f9fafb', dim: '#adb2b8', green: '#4ed17e', blue: '#7aaaff', border: '#353638', bar: '#1b1b1c', label: 'Dark' },
  light: { bg: '#f9fafb', fg: '#0f1115', dim: '#61666b', green: '#15803d', blue: '#3468d8', border: '#e1e5ee', bar: '#ffffff', label: 'Light' },
  solarized: { bg: '#002b36', fg: '#839496', dim: '#586e75', green: '#859900', blue: '#268bd2', border: '#0b4653', bar: '#073642', label: 'Solarized' },
  dracula: { bg: '#282a36', fg: '#f8f8f2', dim: '#6272a4', green: '#50fa7b', blue: '#bd93f9', border: '#44475a', bar: '#343746', label: 'Dracula' },
  monokai: { bg: '#272822', fg: '#f8f8f2', dim: '#75715e', green: '#a6e22e', blue: '#66d9ef', border: '#4a4b41', bar: '#34352e', label: 'Monokai' }
}
const terminalPreview = computed(() => terminalPreviews[draft.value.terminal.theme])
const terminalPreviewSize = computed(() => `${Math.min(16, Math.max(12, draft.value.terminal.fontSize))}px`)
function applyDocumentAppearance(mode: Appearance = draft.value.appearance): void {
  document.documentElement.classList.toggle('theme-dark', mode === 'dark' || (mode === 'system' && themeQuery.matches))
}
function onSystemThemeChange(): void {
  if (store.visible && draft.value.appearance === 'system') applyDocumentAppearance()
}
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
  catch { storage.value = { locations: [], root: '', warning: '无法读取存储位置，请重试。' } }
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
  if (visible) {
    draft.value = JSON.parse(JSON.stringify(store.value))
    applyDocumentAppearance(draft.value.appearance)
  } else {
    store.recording = false
    applyDocumentAppearance(store.value.appearance)
  }
})
watch(() => draft.value.appearance, () => {
  if (store.visible) applyDocumentAppearance()
})
watch(section, async () => {
  await nextTick()
  const body = document.querySelector<HTMLElement>('.el-dialog__body')
  if (body) body.scrollTop = 0
})
themeQuery.addEventListener('change', onSystemThemeChange)
onBeforeUnmount(() => {
  themeQuery.removeEventListener('change', onSystemThemeChange)
  applyDocumentAppearance(store.value.appearance)
})
const validation = computed(() => {
  try { validateSettings(draft.value); return '' } catch (error) { return (error as Error).message }
})
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(store.value))
async function requestClose(done: () => void): Promise<void> {
  if (!dirty.value) { done(); return }
  try {
    await ElMessageBox.confirm('有未保存的设置修改，确定关闭吗？', '放弃修改', {
      type: 'warning', confirmButtonText: '放弃修改', cancelButtonText: '继续编辑'
    })
    store.recording = false
    done()
  } catch { /* 继续编辑 */ }
}
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
    await ElMessageBox.confirm('恢复外观、终端、快捷键、命令和编辑器设置？保存后生效。', '恢复默认', { confirmButtonText: '恢复默认', cancelButtonText: '取消' })
    draft.value = defaults()
  } catch { /* 用户取消。 */ }
}
function addCommand(): void {
  draft.value.commands.push({ id: crypto.randomUUID(), name: '', command: '', shortcut: '', enabled: true })
}
</script>

<template>
  <el-dialog v-model="store.visible" title="设置" width="760px" top="7vh" :before-close="requestClose" :close-on-click-modal="false" :close-on-press-escape="!store.recording" destroy-on-close>
    <el-tabs v-model="section">
      <el-tab-pane label="外观" name="appearance">
        <section class="appearance-section">
          <div class="appearance-head">
            <div>
              <h3>界面主题</h3>
              <p>外观会即时预览；保存后写入设置，取消会恢复原样。</p>
            </div>
            <span class="appearance-live"><i aria-hidden="true"></i>实时预览</span>
          </div>
          <div class="appearance-grid" role="radiogroup" aria-label="界面主题">
            <button
              v-for="option in appearanceOptions"
              :key="option.value"
              type="button"
              class="appearance-card"
              :class="{ active: draft.appearance === option.value }"
              role="radio"
              :aria-checked="draft.appearance === option.value"
              @click="draft.appearance = option.value"
            >
              <span class="theme-thumb" :class="`theme-thumb-${option.value}`" aria-hidden="true">
                <span class="thumb-side"><i class="thumb-brand"></i></span>
                <span class="thumb-main"><i class="thumb-line w1"></i><i class="thumb-line w2"></i><i class="thumb-line w3"></i></span>
                <span class="thumb-accent"></span>
              </span>
              <span class="appearance-label">
                <strong>
                  <el-icon class="appearance-icon"><Sunny v-if="option.value === 'light'" /><Moon v-else-if="option.value === 'dark'" /><Monitor v-else /></el-icon>
                  {{ option.label }}
                </strong>
                <small>{{ option.description }}</small>
              </span>
              <span v-if="draft.appearance === option.value" class="appearance-check" aria-hidden="true">✓</span>
            </button>
          </div>
        </section>

        <section class="appearance-section">
          <div class="appearance-head">
            <div>
              <h3>终端外观</h3>
              <p>字号、字体与配色只作用于终端区域，不影响应用外壳。</p>
            </div>
          </div>
          <div class="terminal-card">
            <div class="terminal-preview" :style="{ background: terminalPreview.bg, color: terminalPreview.fg, fontFamily: draft.terminal.fontFamily }">
              <div class="terminal-preview-bar" :style="{ background: terminalPreview.bar, borderColor: terminalPreview.border }">
                <span class="preview-dots" aria-hidden="true"><i></i><i></i><i></i></span>
                <span class="preview-theme">{{ terminalPreview.label }}</span>
              </div>
              <div class="terminal-preview-body" :style="{ fontSize: terminalPreviewSize }">
                <div><span :style="{ color: terminalPreview.blue }">$</span> ssh deploy@web-01</div>
                <div :style="{ color: terminalPreview.dim }">Last login: Tue Oct 28 09:41:02 on ttys001</div>
                <div><span :style="{ color: terminalPreview.green }">deploy@web-01</span>:<span :style="{ color: terminalPreview.blue }">~</span>$ <span class="preview-cursor" :style="{ background: terminalPreview.fg }"></span></div>
              </div>
            </div>
            <div class="terminal-controls">
              <div class="control-row">
                <span>字号</span>
                <el-input-number v-model="draft.terminal.fontSize" :min="12" :max="24" controls-position="right" aria-label="终端字号" />
              </div>
              <div class="control-row">
                <span>字体</span>
                <el-select v-model="draft.terminal.fontFamily" aria-label="终端字体">
                  <el-option label="系统等宽" value="Menlo, Monaco, 'Courier New', monospace" />
                  <el-option label="JetBrains Mono" value="'JetBrains Mono', Menlo, monospace" />
                  <el-option label="通用等宽" value="monospace" />
                </el-select>
              </div>
              <div class="control-themes">
                <span>配色</span>
                <div class="terminal-themes" role="radiogroup" aria-label="终端配色">
                  <button
                    v-for="option in terminalThemeOptions"
                    :key="option.value"
                    type="button"
                    class="theme-chip"
                    :class="{ active: draft.terminal.theme === option.value }"
                    role="radio"
                    :aria-checked="draft.terminal.theme === option.value"
                    @click="draft.terminal.theme = option.value"
                  >
                    <i :style="{ background: terminalPreviews[option.value].bg, borderColor: terminalPreviews[option.value].border }" aria-hidden="true"></i>
                    <span>{{ option.label }}</span>
                  </button>
                </div>
              </div>
              <div class="switch-row">
                <div><strong>选中即复制</strong><small>在终端拖选文本后立即写入剪贴板</small></div>
                <el-switch v-model="draft.terminal.copyOnSelect" aria-label="选中即复制" />
              </div>
            </div>
          </div>
        </section>
      </el-tab-pane>
      <el-tab-pane label="快捷键" name="shortcuts">
        <section class="settings-section">
          <div class="settings-section-head">
            <div><h3>应用快捷键</h3><p>快捷键仅在应用内生效；输入框、弹窗和输入法优先。终端保留 Ctrl 控制键，请使用带 Shift/Alt 的组合。</p></div>
            <span class="settings-count">{{ shortcutRows.length }} 项</span>
          </div>
          <div class="settings-search">
            <el-input v-model="shortcutQuery" :prefix-icon="'Search'" clearable placeholder="搜索快捷键…" aria-label="搜索快捷键" />
          </div>
          <div class="settings-card">
            <div v-for="[id, label] in shortcutRows" :key="id" class="binding-row shortcut-row">
              <div class="shortcut-copy"><strong>{{ label }}</strong><small>{{ actionDescriptions[id] }}</small></div>
              <ShortcutRecorder v-model="draft.bindings[id].shortcut" :label="label" />
              <el-switch v-model="draft.bindings[id].enabled" :aria-label="`启用${label}`" />
            </div>
            <p v-if="!shortcutRows.length" class="settings-empty">没有匹配的快捷键</p>
          </div>
          <p class="settings-footnote">快捷键只在本应用内生效；系统级快捷键请在系统设置中调整。</p>
        </section>
      </el-tab-pane>

      <el-tab-pane label="终端命令" name="commands">
        <section class="settings-section">
          <div class="settings-section-head">
            <div><h3>命令库</h3><p>确认目标后仅插入当前终端，由你按 Enter 执行。不支持自动连接、群发或本机执行。</p></div>
            <div class="settings-head-actions">
              <span class="settings-count">{{ draft.commands.length }} 条</span>
              <el-button v-if="draft.commands.length" type="primary" :icon="'Plus'" :disabled="draft.commands.length >= 100" @click="addCommand">添加终端命令</el-button>
            </div>
          </div>
          <div v-if="!draft.commands.length" class="settings-empty-card">
            <span class="settings-empty-icon"><el-icon><Tickets /></el-icon></span>
            <strong>还没有终端命令</strong>
            <p>添加常用命令，连接终端后可从命令菜单插入，不会自动执行。</p>
            <el-button @click="addCommand">添加终端命令</el-button>
          </div>
          <article v-for="(command, index) in draft.commands" :key="command.id" class="command-card">
            <div class="command-heading">
              <span class="command-index">{{ String(index + 1).padStart(2, '0') }}</span>
              <el-input v-model="command.name" placeholder="命令名称" aria-label="命令名称" maxlength="100" />
              <el-switch v-model="command.enabled" aria-label="启用命令" />
              <button class="settings-icon-button" type="button" title="删除命令" :aria-label="`删除命令 ${command.name || index + 1}`" @click="draft.commands.splice(index, 1)"><el-icon><Delete /></el-icon></button>
            </div>
            <div class="command-line">
              <span class="command-prompt" aria-hidden="true">$</span>
              <el-input v-model="command.command" placeholder="单行命令，例如 git status" aria-label="单行命令" maxlength="4096" />
            </div>
            <div class="command-shortcut"><span>快捷键</span><ShortcutRecorder v-model="command.shortcut" :label="command.name || '命令'" /></div>
          </article>
          <p class="settings-footnote">请勿在命令中保存密码或密钥；命令只会插入终端输入框，不会自动执行。</p>
        </section>
      </el-tab-pane>

      <el-tab-pane label="外部编辑器" name="editor">
        <section class="settings-section">
          <div class="settings-section-head">
            <div><h3>打开方式</h3><p>仅支持 10 MiB 以内的普通文本文件，保持原始编码和换行；修改后需要明确确认才会回传远程。</p></div>
          </div>
          <div class="settings-choice-grid" role="radiogroup" aria-label="外部编辑器打开方式">
            <button
              v-for="option in editorOptions"
              :key="option.value"
              type="button"
              class="settings-choice"
              :class="{ active: draft.editor.mode === option.value }"
              role="radio"
              :aria-checked="draft.editor.mode === option.value"
              @click="draft.editor.mode = option.value"
            >
              <span class="settings-choice-icon"><el-icon><component :is="option.icon" /></el-icon></span>
              <span class="settings-choice-copy"><strong>{{ option.title }}</strong><small>{{ option.description }}</small></span>
              <span v-if="draft.editor.mode === option.value" class="settings-choice-check" aria-hidden="true">✓</span>
            </button>
          </div>
          <div v-if="draft.editor.mode === 'custom'" class="editor-path-card">
            <div class="settings-field-head"><span>编辑器路径</span><small>macOS 支持 .app 或可执行程序；Windows 支持 .exe；Linux 支持可执行程序。</small></div>
            <div class="editor-path-row">
              <el-input :model-value="draft.editor.path" readonly placeholder="选择 Notepad++、Sublime Text 等编辑器" aria-label="编辑器路径" />
              <el-button @click="chooseEditor">选择程序…</el-button>
            </div>
          </div>
          <div v-else class="settings-inline-note"><el-icon><Lock /></el-icon><span>使用 .txt 安全副本打开，不直接修改远端原文；需要回传时由你明确确认。</span></div>
          <button class="settings-link-row" type="button" @click="section = 'storage'">
            <span class="settings-link-icon"><el-icon><FolderOpened /></el-icon></span>
            <span class="settings-link-copy"><strong>临时文件位置</strong><small>查看外部编辑草稿与本地副本的存放目录</small></span>
            <el-icon class="settings-link-arrow"><ArrowRight /></el-icon>
          </button>
          <p class="settings-footnote">编辑器不可用时可从外部编辑列表改用默认应用；临时副本可能包含远端文件内容，请勿随意分享。</p>
        </section>
      </el-tab-pane>

      <el-tab-pane label="存储位置" name="storage">
        <section class="settings-section">
          <div class="settings-section-head storage-intro">
            <div><h3>数据文件夹</h3><p>草稿、连接数据库、设置和日志都放在这一个文件夹里。</p></div>
            <el-button text :icon="'Refresh'" :loading="storageLoading" @click="loadStorage">刷新</el-button>
          </div>
          <div v-if="storage.root" class="storage-home-card">
            <div class="storage-home-head"><span class="storage-icon"><el-icon><FolderOpened /></el-icon></span><div><strong>应用数据目录</strong><small>所有配置和草稿的根目录</small></div></div>
            <code class="storage-home-path">{{ storage.root }}</code>
            <div class="storage-home-actions"><el-button size="small" text :icon="'CopyDocument'" :disabled="!!storageAction" :loading="storageAction === 'copy:settings'" @click="storageOperation('settings', 'copy')">复制路径</el-button><el-button size="small" :icon="'FolderOpened'" :disabled="!!storageAction" :loading="storageAction === 'open:settings'" @click="storageOperation('settings', 'open')">打开数据文件夹</el-button></div>
          </div>
          <p v-if="storage.warning" class="storage-warning" role="alert">{{ storage.warning }}</p>
          <p v-if="storageLoading && !storage.locations.length" class="settings-footnote" role="status">正在读取存储位置…</p>
          <div v-else-if="!storage.locations.length" class="settings-empty-card">
            <span class="settings-empty-icon"><el-icon><FolderOpened /></el-icon></span>
            <strong>暂时没有可用的存储目录</strong>
            <p>请确认应用有权限读写数据目录后重试。</p>
          </div>
          <article v-for="item in storage.locations" :key="item.id" class="storage-card" :data-storage-id="item.id">
            <div class="storage-heading"><span class="storage-icon"><el-icon><component :is="storageLabels[item.id].icon" /></el-icon></span><div><h4>{{ storageLabels[item.id].title }}</h4><p>{{ storageLabels[item.id].description }}</p></div></div>
            <code v-if="item.path" class="storage-path">{{ item.path }}</code>
            <p v-else class="storage-unavailable">{{ item.unavailable }}</p>
            <div class="storage-actions"><el-button size="small" text :icon="'CopyDocument'" :disabled="!item.path || !!storageAction" :loading="storageAction === `copy:${item.id}`" @click="storageOperation(item.id, 'copy')">复制路径</el-button><el-button size="small" :icon="'FolderOpened'" :disabled="!item.path || !!storageAction" :loading="storageAction === `open:${item.id}`" @click="storageOperation(item.id, 'open')">{{ item.id === 'database' || item.id === 'settings' ? '打开所在目录' : '打开目录' }}</el-button></div>
          </article>
          <p class="storage-safety"><el-icon><Lock /></el-icon>草稿可能包含远程文件的敏感内容；数据库和日志请勿随意分享。</p>
        </section>
      </el-tab-pane>
    </el-tabs>
    <template #footer>
      <div class="settings-footer">
        <el-button v-if="section !== 'storage'" text @click="reset">恢复默认</el-button>
        <span class="settings-footer-spacer"></span>
        <span v-if="validation && section !== 'storage'" class="validation-error footer-validation" role="alert">{{ validation }}</span>
        <el-button @click="requestClose(() => { store.visible = false })">{{ section === 'storage' ? '关闭' : '取消' }}</el-button>
        <el-button v-if="section !== 'storage'" type="primary" :loading="saving" :disabled="!!validation || !store.ready" @click="save">保存设置</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.appearance-section + .appearance-section { margin-top: 24px; }
.appearance-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin: 0 0 12px; }
.appearance-head h3 { margin: 0 0 4px; font-size: 13px; font-weight: 600; color: var(--sh-text); }
.appearance-head p { margin: 0; font-size: 12px; line-height: 1.7; color: var(--sh-text-muted); }
.appearance-live { flex-shrink: 0; height: 22px; display: inline-flex; align-items: center; gap: 6px; padding: 0 8px; border: 1px solid var(--sh-border); border-radius: 999px; background: var(--sh-bg); color: var(--sh-text-muted); font-size: 11px; }
.appearance-live i { width: 5px; height: 5px; border-radius: 50%; background: var(--sh-success); }
.appearance-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.appearance-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 7px 7px 8px;
  border: 1px solid var(--sh-border);
  border-radius: 12px;
  background: var(--sh-bg-panel);
  color: var(--sh-text);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.14s ease, box-shadow 0.14s ease, background 0.14s ease;
}
.appearance-card:hover { border-color: var(--sh-border-strong); background: var(--sh-bg-hover); }
.appearance-card.active { border-color: var(--sh-accent); box-shadow: 0 0 0 3px var(--sh-accent-soft); }
.appearance-card:focus-visible { outline: 2px solid var(--sh-accent); outline-offset: 2px; }
.theme-thumb { position: relative; height: 66px; display: flex; overflow: hidden; border: 1px solid var(--sh-border); border-radius: 8px; background: #fff; }
.thumb-side { width: 34%; padding: 11px 8px; border-right: 1px solid rgba(15, 17, 21, 0.06); background: #f5f6f7; }
.thumb-brand { display: block; width: 22px; height: 5px; border-radius: 2px; background: #0f1115; opacity: 0.82; }
.thumb-main { flex: 1; display: flex; flex-direction: column; gap: 5px; padding: 12px 10px; background: #fff; }
.thumb-line { display: block; height: 4px; border-radius: 2px; background: #e8ebef; }
.thumb-line.w1 { width: 72%; }
.thumb-line.w2 { width: 48%; }
.thumb-line.w3 { width: 62%; background: #dfe4eb; }
.thumb-accent { position: absolute; right: 8px; bottom: 8px; width: 18px; height: 5px; border-radius: 3px; background: #3468d8; opacity: 0.9; }
.theme-thumb-dark .thumb-side { background: #151517; border-color: #2c2c2e; }
.theme-thumb-dark .thumb-brand { background: #f9fafb; opacity: 0.9; }
.theme-thumb-dark .thumb-main { background: #1b1b1c; }
.theme-thumb-dark .thumb-line { background: #353638; }
.theme-thumb-dark .thumb-line.w3 { background: #3f4043; }
.theme-thumb-dark .thumb-accent { background: #5686fe; }
.theme-thumb-system .thumb-side { background: linear-gradient(90deg, #f5f6f7 0 50%, #151517 50% 100%); border-color: transparent; }
.theme-thumb-system .thumb-main { background: linear-gradient(90deg, #fff 0 50%, #1b1b1c 50% 100%); }
.theme-thumb-system .thumb-line { background: linear-gradient(90deg, #e8ebef 0 50%, #353638 50% 100%); }
.theme-thumb-system .thumb-line.w3 { background: linear-gradient(90deg, #dfe4eb 0 50%, #3f4043 50% 100%); }
.theme-thumb-system .thumb-brand { background: linear-gradient(90deg, #0f1115 0 50%, #f9fafb 50% 100%); }
.theme-thumb-system .thumb-accent { background: linear-gradient(90deg, #3468d8 0 50%, #5686fe 50% 100%); }
.theme-thumb-system::after { content: ''; position: absolute; top: 0; bottom: 0; left: 50%; width: 1px; background: rgba(255, 255, 255, 0.35); }
.appearance-label { display: flex; flex-direction: column; gap: 1px; padding: 0 2px; min-width: 0; }
.appearance-label strong { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 500; }
.appearance-icon { font-size: 12px; color: var(--sh-text-muted); }
.appearance-card.active .appearance-icon { color: var(--sh-accent); }
.appearance-label small { font-size: 11px; color: var(--sh-text-muted); }
.appearance-check { position: absolute; top: 12px; right: 12px; width: 18px; height: 18px; display: grid; place-items: center; border-radius: 50%; background: var(--sh-accent); color: #fff; font-size: 11px; font-weight: 700; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.22); }

.terminal-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 292px;
  gap: 14px;
  padding: 12px;
  border: 1px solid var(--sh-border);
  border-radius: 12px;
  background: var(--sh-bg);
}
.terminal-preview { min-width: 0; height: 192px; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--sh-border-strong); border-radius: 9px; }
.terminal-preview-bar { height: 30px; flex-shrink: 0; display: flex; align-items: center; gap: 8px; padding: 0 10px; border-bottom: 1px solid; }
.preview-dots { display: flex; align-items: center; gap: 4px; }
.preview-dots i { width: 6px; height: 6px; border-radius: 50%; background: #ff5f57; }
.preview-dots i:nth-child(2) { background: #febc2e; }
.preview-dots i:nth-child(3) { background: #28c840; }
.preview-theme { margin-left: auto; font: 9px var(--sh-font-mono); letter-spacing: 0.04em; opacity: 0.55; text-transform: uppercase; }
.terminal-preview-body { flex: 1; min-width: 0; overflow: hidden; padding: 14px; font-family: var(--sh-font-mono); line-height: 1.9; white-space: nowrap; }
.terminal-preview-body > div { overflow: hidden; text-overflow: ellipsis; }
.preview-cursor { display: inline-block; width: 6px; height: 1em; margin-left: 2px; vertical-align: -2px; animation: preview-blink 1.1s steps(1) infinite; }
@keyframes preview-blink { 50% { opacity: 0; } }
.terminal-controls { min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 9px; }
.control-row { display: grid; grid-template-columns: 38px minmax(0, 1fr); align-items: center; gap: 8px; font-size: 12px; color: var(--sh-text-secondary); }
.control-row :deep(.el-input-number), .control-row :deep(.el-select) { width: 100%; }
.control-themes { display: grid; grid-template-columns: 38px minmax(0, 1fr); align-items: start; gap: 8px; font-size: 12px; color: var(--sh-text-secondary); }
.control-themes > span { line-height: 24px; }
.terminal-themes { display: flex; flex-wrap: wrap; gap: 4px; }
.theme-chip { height: 24px; display: inline-flex; align-items: center; gap: 5px; padding: 0 6px; border: 1px solid var(--sh-border); border-radius: 6px; background: var(--sh-bg-panel); color: var(--sh-text-secondary); font-size: 10px; cursor: pointer; }
.theme-chip:hover { border-color: var(--sh-border-strong); color: var(--sh-text); }
.theme-chip.active { border-color: var(--sh-accent); background: var(--sh-accent-soft); color: var(--sh-text); }
.theme-chip:focus-visible { outline: 2px solid var(--sh-accent); outline-offset: 1px; }
.theme-chip i { width: 10px; height: 10px; flex-shrink: 0; border: 1px solid; border-radius: 3px; }
.switch-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-top: 3px; padding-top: 10px; border-top: 1px solid var(--sh-border); }
.switch-row > div { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.switch-row strong { font-size: 12px; font-weight: 500; }
.switch-row small { font-size: 11px; line-height: 1.5; color: var(--sh-text-muted); }
.settings-section + .settings-section { margin-top: 24px; }
.settings-section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin: 0 0 14px; }
.settings-section-head h3 { margin: 0 0 5px; font-size: 13px; font-weight: 600; color: var(--sh-text); }
.settings-section-head p { margin: 0; font-size: 12px; line-height: 1.7; color: var(--sh-text-muted); }
.settings-count { flex-shrink: 0; height: 22px; display: inline-flex; align-items: center; padding: 0 8px; border: 1px solid var(--sh-border); border-radius: 999px; background: var(--sh-bg); color: var(--sh-text-muted); font-size: 11px; }
.settings-head-actions { flex-shrink: 0; display: flex; align-items: center; gap: 8px; }
.settings-search { width: min(280px, 100%); margin-bottom: 12px; }
.settings-card { border: 1px solid var(--sh-border); border-radius: 12px; background: var(--sh-bg-panel); overflow: hidden; }
.binding-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(220px, 310px) 40px; align-items: center; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--sh-border); font-size: 13px; }
.binding-row:last-child { border-bottom: 0; }
.shortcut-copy { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.shortcut-copy strong { font-size: 12px; font-weight: 500; color: var(--sh-text); }
.shortcut-copy small { font-size: 11px; line-height: 1.5; color: var(--sh-text-muted); }
.shortcut-row :deep(.shortcut-recorder) { min-width: 0; flex-wrap: nowrap; justify-content: flex-end; gap: 2px; }
.shortcut-row :deep(.record-key) { min-width: 150px; flex: 1; text-align: center; background: var(--sh-bg); }
.shortcut-row :deep(.el-button) { flex-shrink: 0; }
.settings-empty { margin: 0; padding: 22px 16px; text-align: center; font-size: 12px; color: var(--sh-text-muted); }
.settings-footnote { margin: 12px 0 0; font-size: 11px; line-height: 1.6; color: var(--sh-text-muted); }
.command-card { padding: 12px 14px; margin-bottom: 10px; border: 1px solid var(--sh-border); border-radius: 12px; display: grid; gap: 9px; background: var(--sh-bg); }
.command-heading { display: grid; grid-template-columns: 30px minmax(0, 1fr) 40px 28px; align-items: center; gap: 8px; }
.command-index { font: 600 10px var(--sh-font-mono); color: var(--sh-text-muted); text-align: center; }
.command-heading :deep(.el-input__wrapper) { background: var(--sh-bg-panel); }
.command-line { display: grid; grid-template-columns: 18px minmax(0, 1fr); align-items: center; gap: 6px; }
.command-prompt { font: 12px var(--sh-font-mono); color: var(--sh-accent); text-align: center; }
.command-line :deep(.el-input__wrapper) { background: var(--sh-bg-panel); }
.command-line :deep(.el-input__inner) { font-family: var(--sh-font-mono); font-size: 12px; }
.command-shortcut { display: flex; align-items: center; gap: 10px; padding-top: 8px; border-top: 1px solid var(--sh-border); }
.command-shortcut > span { width: 38px; flex-shrink: 0; font-size: 11px; color: var(--sh-text-muted); }
.command-shortcut :deep(.shortcut-recorder) { flex: 1; min-width: 0; flex-wrap: nowrap; }
.command-shortcut :deep(.record-key) { min-width: 150px; flex: 1; background: var(--sh-bg-panel); }
.settings-icon-button { width: 28px; height: 28px; display: grid; place-items: center; border: 0; border-radius: 6px; background: transparent; color: var(--sh-text-muted); font-size: 13px; cursor: pointer; }
.settings-icon-button:hover { background: var(--sh-bg-hover); color: var(--sh-danger); }
.settings-icon-button:focus-visible { outline: 2px solid var(--sh-accent); outline-offset: 1px; }
.settings-empty-card { display: flex; flex-direction: column; align-items: center; gap: 7px; padding: 28px 20px; border: 1px dashed var(--sh-border); border-radius: 12px; background: var(--sh-bg); text-align: center; color: var(--sh-text-muted); font-size: 12px; }
.settings-empty-icon { width: 36px; height: 36px; display: grid; place-items: center; border: 1px solid var(--sh-border); border-radius: 10px; background: var(--sh-bg-panel); color: var(--sh-accent); font-size: 18px; }
.settings-empty-card strong { font-size: 13px; font-weight: 500; color: var(--sh-text); }
.settings-empty-card p { max-width: 440px; margin: 0; line-height: 1.6; }
.settings-choice-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-bottom: 12px; }
.settings-choice { position: relative; display: flex; align-items: flex-start; gap: 10px; min-width: 0; padding: 12px; border: 1px solid var(--sh-border); border-radius: 12px; background: var(--sh-bg-panel); text-align: left; cursor: pointer; transition: border-color 0.14s ease, box-shadow 0.14s ease, background 0.14s ease; }
.settings-choice:hover { border-color: var(--sh-border-strong); background: var(--sh-bg-hover); }
.settings-choice.active { border-color: var(--sh-accent); box-shadow: 0 0 0 3px var(--sh-accent-soft); }
.settings-choice:focus-visible { outline: 2px solid var(--sh-accent); outline-offset: 2px; }
.settings-choice-icon { width: 30px; height: 30px; flex-shrink: 0; display: grid; place-items: center; border: 1px solid var(--sh-border); border-radius: 8px; background: var(--sh-bg); color: var(--sh-accent); font-size: 15px; }
.settings-choice-copy { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.settings-choice-copy strong { font-size: 12px; font-weight: 500; color: var(--sh-text); }
.settings-choice-copy small { font-size: 11px; line-height: 1.5; color: var(--sh-text-muted); }
.settings-choice-check { position: absolute; top: 9px; right: 9px; width: 18px; height: 18px; display: grid; place-items: center; border-radius: 50%; background: var(--sh-accent); color: #fff; font-size: 11px; font-weight: 700; }
.editor-path-card { padding: 12px 14px; margin-bottom: 12px; border: 1px solid var(--sh-border); border-radius: 12px; background: var(--sh-bg); }
.settings-field-head { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; }
.settings-field-head span { font-size: 12px; font-weight: 500; color: var(--sh-text); }
.settings-field-head small { font-size: 11px; line-height: 1.5; color: var(--sh-text-muted); }
.editor-path-row { display: flex; align-items: center; gap: 8px; }
.editor-path-row .el-input { flex: 1; min-width: 0; }
.settings-inline-note { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; margin-bottom: 12px; border: 1px solid var(--sh-border); border-radius: 8px; background: var(--sh-bg); color: var(--sh-text-muted); font-size: 11px; line-height: 1.6; }
.settings-inline-note .el-icon { flex-shrink: 0; margin-top: 1px; color: var(--sh-accent); }
.settings-link-row { width: 100%; display: flex; align-items: center; gap: 10px; padding: 12px 14px; margin: 4px 0 12px; border: 1px solid var(--sh-border); border-radius: 12px; background: var(--sh-bg-panel); color: var(--sh-text); text-align: left; cursor: pointer; transition: border-color 0.14s ease, background 0.14s ease; }
.settings-link-row:hover { border-color: var(--sh-border-strong); background: var(--sh-bg-hover); }
.settings-link-icon { width: 30px; height: 30px; flex-shrink: 0; display: grid; place-items: center; border: 1px solid var(--sh-border); border-radius: 8px; background: var(--sh-bg); color: var(--sh-accent); font-size: 15px; }
.settings-link-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.settings-link-copy strong { font-size: 12px; font-weight: 500; }
.settings-link-copy small { font-size: 11px; color: var(--sh-text-muted); }
.settings-link-arrow { flex-shrink: 0; color: var(--sh-text-muted); font-size: 12px; }
.settings-footer { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.settings-footer-spacer { flex: 1; }
.footer-validation { max-width: 320px; line-height: 1.5; text-align: right; }
.validation-error { color: var(--sh-danger); font-size: 12px; }
.storage-intro { margin: 0 0 14px; }
.storage-intro h3 { margin: 0 0 5px; font-size: 13px; font-weight: 600; color: var(--sh-text); }
.storage-intro p { margin: 0; font-size: 12px; line-height: 1.7; color: var(--sh-text-muted); }
.storage-home-card { padding: 12px 14px; margin-bottom: 12px; border: 1px solid var(--sh-border); border-radius: 12px; background: var(--sh-bg); }
.storage-home-head { display: flex; align-items: center; gap: 10px; }
.storage-home-head strong { display: block; font-size: 12px; font-weight: 500; color: var(--sh-text); }
.storage-home-head small { display: block; margin-top: 2px; font-size: 11px; color: var(--sh-text-muted); }
.storage-home-path { display: block; margin: 10px 0; padding: 9px 11px; border: 1px solid var(--sh-storage-path-border); border-radius: 7px; background: var(--sh-storage-path-bg); color: var(--sh-storage-path-text); font: 11px/1.7 var(--sh-font-mono); white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
.storage-home-actions { display: flex; justify-content: flex-end; gap: 8px; }
.storage-home-actions :deep(.el-button + .el-button) { margin-left: 0; }
.storage-card { padding: 14px; margin-bottom: 10px; border: 1px solid var(--sh-border); border-radius: 12px; background: var(--sh-bg-panel); }
.storage-heading { display: flex; gap: 11px; align-items: flex-start; }
.storage-icon { width: 32px; height: 32px; border-radius: 9px; display: grid; place-items: center; flex-shrink: 0; color: var(--sh-accent); background: var(--sh-storage-icon-bg); font-size: 17px; }
.storage-heading h4 { font-size: 12px; font-weight: 500; margin: 0 0 3px; color: var(--sh-text); }
.storage-heading p { font-size: 11px; line-height: 1.6; color: var(--sh-text-muted); margin: 0; }
.storage-path { display: block; margin: 10px 0 8px; padding: 9px 11px; border: 1px solid var(--sh-storage-path-border); border-radius: 7px; background: var(--sh-storage-path-bg); color: var(--sh-storage-path-text); font: 11px/1.7 var(--sh-font-mono); white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; cursor: text; }
.storage-actions { display: flex; justify-content: flex-end; gap: 8px; }
.storage-actions :deep(.el-button + .el-button) { margin-left: 0; }
.storage-warning { padding: 10px 12px; background: var(--sh-warning-bg); color: var(--sh-warning-text); border-radius: 7px; font-size: 12px; line-height: 1.7; }
.storage-unavailable { font-size: 11px; color: var(--sh-text-muted); }
.storage-safety { display: flex; align-items: center; gap: 6px; margin: 12px 0 0; font-size: 11px; color: var(--sh-text-muted); line-height: 1.7; }
</style>
