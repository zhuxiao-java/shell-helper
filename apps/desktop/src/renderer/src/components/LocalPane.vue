<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { FileEntry } from '@renderer/api/types'

interface LocalEntry { name: string; path: string; is_dir: boolean; size: number; mtime: number }
const props = defineProps<{ remoteEntries: FileEntry[]; remotePath: string }>()
const emit = defineEmits<{
  (e: 'upload', entries: LocalEntry[]): void
  (e: 'download', entries: FileEntry[], localDirectory: string): void
  (e: 'close'): void
}>()

const STORAGE_KEY = 'shell-helper-local-pane'
const cwd = ref('')
const entries = ref<LocalEntry[]>([])
const loading = ref(false)
const error = ref('')
const selected = ref<string[]>([])

const remoteMap = computed(() => new Map(props.remoteEntries.map(entry => [entry.name, entry])))
const localOnly = computed(() => entries.value.filter(entry => !remoteMap.value.has(entry.name)))
const remoteOnly = computed(() => props.remoteEntries.filter(entry => !entries.value.some(local => local.name === entry.name)))
const selectedEntries = computed(() => entries.value.filter(entry => selected.value.includes(entry.path)))
const changedCount = computed(() => entries.value.filter(entry => statusOf(entry) === 'changed').length)

function statusOf(entry: LocalEntry): 'same' | 'changed' | 'local' {
  const remote = remoteMap.value.get(entry.name)
  if (!remote) return 'local'
  if (remote.is_dir !== entry.is_dir) return 'changed'
  if (!entry.is_dir && remote.size !== entry.size) return 'changed'
  return 'same'
}

function fmtSize(bytes: number): string {
  if (!bytes) return '—'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

async function load(directory = cwd.value): Promise<void> {
  if (!directory) return
  loading.value = true
  error.value = ''
  try {
    entries.value = await window.shellHelper.listLocalDirectory(directory)
    cwd.value = directory
    selected.value = []
    try { localStorage.setItem(STORAGE_KEY, directory) } catch { /* 忽略 */ }
  } catch (err) {
    error.value = (err as Error).message || '无法读取本地目录'
  } finally { loading.value = false }
}

async function choose(): Promise<void> {
  try {
    const directory = await window.shellHelper.chooseDirectory()
    if (directory) await load(directory)
  } catch (err) { ElMessage.error((err as Error).message || '无法选择目录') }
}

function parent(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return index <= 0 ? normalized : normalized.slice(0, index)
}

function up(): void {
  if (cwd.value) void load(parent(cwd.value))
}

function select(entry: LocalEntry, event: MouseEvent): void {
  if (entry.is_dir) { void load(entry.path); return }
  if (event.metaKey || event.ctrlKey) {
    selected.value = selected.value.includes(entry.path) ? selected.value.filter(path => path !== entry.path) : [...selected.value, entry.path]
  } else {
    selected.value = selected.value.includes(entry.path) ? [] : [entry.path]
  }
}

function sendUpload(list: LocalEntry[]): void {
  const files = list.filter(entry => !entry.is_dir)
  if (!files.length) { ElMessage.info('请选择普通文件；目录同步暂仅支持逐级打开'); return }
  emit('upload', files)
}

function openEntry(entry: LocalEntry): void {
  if (entry.is_dir) void load(entry.path)
  else select(entry, new MouseEvent('click'))
}

onMounted(() => {
  try { cwd.value = localStorage.getItem(STORAGE_KEY) || '' } catch { /* 忽略 */ }
  if (cwd.value) void load()
})
</script>

<template>
  <aside class="local-pane" aria-label="本地文件">
    <header class="local-head">
      <div class="local-title"><el-icon><Monitor /></el-icon><strong>本地</strong></div>
      <button class="local-close" type="button" aria-label="关闭本地栏" @click="emit('close')"><el-icon><Close /></el-icon></button>
    </header>
    <div class="local-path-row">
      <button class="local-path" type="button" :title="cwd || '选择本地目录'" @click="choose"><el-icon><FolderOpened /></el-icon><span>{{ cwd || '选择本地目录…' }}</span></button>
      <button class="local-icon" type="button" aria-label="上一级目录" :disabled="!cwd" @click="up"><el-icon><Top /></el-icon></button>
      <button class="local-icon" type="button" aria-label="刷新本地目录" :disabled="!cwd || loading" @click="load()"><el-icon :class="{ 'is-loading': loading }"><Refresh /></el-icon></button>
    </div>
    <div class="local-compare">
      <span v-if="cwd">仅本地 <b>{{ localOnly.length }}</b> · 仅远程 <b>{{ remoteOnly.length }}</b><template v-if="changedCount"> · 不同 <b>{{ changedCount }}</b></template></span>
      <span v-else>选择目录后与远端当前目录比较</span>
    </div>
    <div v-loading="loading" class="local-list">
      <div v-if="error" class="local-empty"><el-icon><WarningFilled /></el-icon><span>{{ error }}</span></div>
      <div v-else-if="!cwd" class="local-empty"><el-icon><FolderOpened /></el-icon><span>选择一个本地目录开始双栏浏览</span></div>
      <div v-else-if="!entries.length" class="local-empty"><span>这个目录是空的</span></div>
      <button
        v-for="entry in entries"
        :key="entry.path"
        type="button"
        class="local-row"
        :class="{ selected: selected.includes(entry.path), changed: statusOf(entry) === 'changed', 'only-local': statusOf(entry) === 'local' }"
        :title="entry.path"
        @click="select(entry, $event)"
        @dblclick="openEntry(entry)"
      >
        <el-icon class="local-folder" v-if="entry.is_dir"><FolderOpened /></el-icon>
        <el-icon class="local-file" v-else><Document /></el-icon>
        <span class="local-name">{{ entry.name }}</span>
        <span v-if="statusOf(entry) === 'local'" class="local-diff">仅本地</span>
        <span v-else-if="statusOf(entry) === 'changed'" class="local-diff changed">不同</span>
        <span v-if="!entry.is_dir" class="local-size">{{ fmtSize(entry.size) }}</span>
      </button>
    </div>
    <footer class="local-footer">
      <div class="local-selected">{{ selectedEntries.length ? `已选 ${selectedEntries.length} 项` : '单击选择，双击进入' }}</div>
      <div class="local-actions">
        <button type="button" :disabled="!selectedEntries.length" @click="sendUpload(selectedEntries)">上传选中</button>
        <button type="button" :disabled="!localOnly.length" @click="sendUpload(localOnly)">上传仅本地</button>
        <button type="button" :disabled="!remoteOnly.length || !cwd" @click="emit('download', remoteOnly, cwd)">下载仅远程</button>
      </div>
    </footer>
  </aside>
</template>

<style scoped>
.local-pane { width: 286px; flex-shrink: 0; display: flex; flex-direction: column; min-height: 0; margin: 10px 0 10px 10px; border: 1px solid var(--sh-tree-border); border-radius: 12px; background: var(--sh-bg-panel); box-shadow: 0 1px 2px rgba(15, 17, 21, 0.03); overflow: hidden; }
.local-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 10px 6px; }
.local-title { display: flex; align-items: center; gap: 6px; color: var(--sh-text); font-size: 12px; }
.local-title .el-icon { color: var(--sh-accent); }
.local-close { width: 24px; height: 24px; display: grid; place-items: center; border: 0; border-radius: 5px; background: transparent; color: var(--sh-text-muted); cursor: pointer; }
.local-close:hover { background: var(--sh-bg-hover); color: var(--sh-text); }
.local-path-row { display: flex; align-items: center; gap: 4px; padding: 0 8px 6px; }
.local-path { flex: 1; min-width: 0; height: 28px; display: flex; align-items: center; gap: 6px; padding: 0 7px; border: 1px solid var(--sh-border); border-radius: 6px; background: var(--sh-bg); color: var(--sh-text-muted); font: 10px var(--sh-font-mono); text-align: left; cursor: pointer; }
.local-path span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.local-path:hover { border-color: var(--sh-border-strong); color: var(--sh-text); }
.local-icon { width: 26px; height: 26px; flex-shrink: 0; display: grid; place-items: center; border: 0; border-radius: 5px; background: transparent; color: var(--sh-text-muted); font-size: 12px; cursor: pointer; }
.local-icon:hover:not(:disabled) { background: var(--sh-bg-hover); color: var(--sh-text); }
.local-icon:disabled { opacity: 0.35; cursor: default; }
.local-compare { padding: 0 12px 6px; color: var(--sh-text-muted); font-size: 10px; line-height: 1.5; }
.local-compare b { color: var(--sh-text-secondary); font-weight: 500; }
.local-list { flex: 1; min-height: 0; overflow: auto; padding: 3px 5px; }
.local-row { width: 100%; height: 30px; display: flex; align-items: center; gap: 7px; padding: 0 6px; border: 0; border-radius: 6px; background: transparent; color: var(--sh-text-secondary); font-size: 11px; text-align: left; cursor: pointer; }
.local-row:hover { background: var(--sh-bg-hover); color: var(--sh-text); }
.local-row.selected { background: var(--sh-tree-current); color: var(--sh-tree-current-text); }
.local-row.only-local { box-shadow: inset 2px 0 var(--sh-accent); }
.local-folder { flex-shrink: 0; color: var(--sh-accent); font-size: 14px; }
.local-file { flex-shrink: 0; color: var(--sh-text-muted); font-size: 13px; }
.local-name { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.local-size { flex-shrink: 0; color: var(--sh-text-muted); font: 9px var(--sh-font-mono); }
.local-diff { flex-shrink: 0; padding: 1px 4px; border-radius: 3px; background: var(--sh-accent-soft); color: var(--sh-accent); font-size: 8px; }
.local-diff.changed { background: var(--sh-warning-bg); color: var(--sh-warning-text); }
.local-empty { display: flex; align-items: flex-start; gap: 7px; padding: 14px 8px; color: var(--sh-text-muted); font-size: 11px; line-height: 1.6; }
.local-empty .el-icon { margin-top: 1px; font-size: 14px; }
.local-footer { flex-shrink: 0; padding: 7px 8px 8px; border-top: 1px solid var(--sh-border); }
.local-selected { margin-bottom: 6px; color: var(--sh-text-muted); font-size: 10px; }
.local-actions { display: flex; flex-wrap: wrap; gap: 4px; }
.local-actions button { height: 25px; padding: 0 6px; border: 1px solid var(--sh-border); border-radius: 5px; background: var(--sh-bg); color: var(--sh-text-secondary); font-size: 10px; cursor: pointer; }
.local-actions button:hover:not(:disabled) { border-color: var(--sh-border-strong); color: var(--sh-accent); }
.local-actions button:disabled { opacity: 0.4; cursor: default; }
</style>
