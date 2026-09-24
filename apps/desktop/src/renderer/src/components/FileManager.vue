<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage, ElMessageBox, type TreeInstance } from 'element-plus'
import * as fileApi from '@renderer/api/files'
import type { FileEntry } from '@renderer/api/types'
import type { Tab } from '@renderer/stores/session'
import { useHostStore } from '@renderer/stores/host'
import { useExternalStore } from '@renderer/stores/external'
import { useSettingsStore } from '@renderer/stores/settings'
import { fileBridges } from '@renderer/utils/workspace'
import { EDIT_STATUS, MAX_FILE_BYTES } from '../../../shared/external'

const props = defineProps<{ tab: Tab; visible: boolean }>()
const external = useExternalStore()
const settings = useSettingsStore()
const hosts = useHostStore()
const selected = ref<FileEntry | null>(null)
const opening = ref(false)
const editState = computed(() => external.items.find(item => item.hostId === props.tab.hostId && item.remotePath === selected.value?.path))
fileBridges.set(props.tab.id, {
  refresh: () => { if (props.visible && !loading.value) void refresh() },
  openSelected: () => {
    if (!props.visible) return
    if (selected.value && !selected.value.is_dir) void open(selected.value)
    else ElMessage.info('请先选择普通文本文件')
  }
})
onBeforeUnmount(() => { fileBridges.delete(props.tab.id); requestId++ })

const cwd = ref('/')
const entries = ref<FileEntry[]>([])
const loading = ref(false)
// 目录加载失败信息(非空时展示错误态 + 重试)
const loadError = ref('')
const loaded = ref(false)
const attemptedPath = ref('/')
const query = ref('')
const showTree = ref(true)
const tree = ref<TreeInstance>()
const treeVersion = ref(0)
const pathEditing = ref(false)
const pathInput = ref('')
const addressInput = ref<HTMLInputElement>()
const directoryRequests = new Map<string, Promise<FileEntry[]>>()
let requestId = 0
interface FolderNode { name: string; path: string }
const breadcrumbs = computed(() => cwd.value.split('/').filter(Boolean).map((name, index, all) => ({ name, path: '/' + all.slice(0, index + 1).join('/') })))
const folderName = computed(() => breadcrumbs.value.at(-1)?.name || '根目录')
const expandedPaths = computed(() => ['/', ...breadcrumbs.value.map(segment => segment.path)])
const host = computed(() => hosts.byId(props.tab.hostId))
const visibleEntries = computed(() => entries.value.filter(e => e.name.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())).slice().sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name, undefined, { numeric: true })))
const folders = computed(() => entries.value.filter(e => e.is_dir).length)
watch(visibleEntries, list => { if (selected.value && !list.some(e => e.path === selected.value?.path)) selected.value = null })
// 首次加载标记:避免空目录时 watch 重复触发 load
let initialized = false

/** 会话创建后定位到主机配置的初始目录("~"/空视为根目录) */
function initialCwd(): string {
  const rc = (props.tab.session?.remote_cwd || '').trim()
  if (!rc || rc === '~' || rc === './') return '/'
  return rc.startsWith('/') ? rc : `/${rc}`
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function fmtTime(ts: number): string {
  return ts > 0 ? new Date(ts * 1000).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—'
}

function join(base: string, name: string): string {
  if (base === '/') return `/${name}`
  return `${base.replace(/\/$/, '')}/${name}`
}

function parent(path: string): string {
  if (path === '/' || path === '') return '/'
  const trimmed = path.replace(/\/$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx <= 0 ? '/' : trimmed.slice(0, idx)
}

function readDirectory(path: string): Promise<FileEntry[]> {
  const sid = props.tab.session?.session_id
  if (!sid) return Promise.reject(new Error('连接尚未就绪'))
  const key = `${sid}:${path}`
  if (!directoryRequests.has(key)) {
    directoryRequests.set(key, fileApi.listDir(sid, path).finally(() => directoryRequests.delete(key)))
  }
  return directoryRequests.get(key)!
}

async function loadTree(node: { level: number; data: FolderNode }, resolve: (nodes: FolderNode[]) => void, reject: () => void): Promise<void> {
  if (node.level === 0) { resolve([{ name: '根目录', path: '/' }]); return }
  try {
    const list = loaded.value && node.data.path === cwd.value ? entries.value : await readDirectory(node.data.path)
    resolve(list.filter(e => e.is_dir).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map(e => ({ name: e.name, path: e.path })))
    await nextTick()
    tree.value?.setCurrentKey(cwd.value)
  } catch (error) {
    reject()
    ElMessage.error(`无法展开目录：${(error as Error).message}，可再次点击箭头重试`)
  }
}

async function load(path = cwd.value): Promise<void> {
  const sid = props.tab.session?.session_id
  if (!sid) return
  const current = ++requestId
  attemptedPath.value = path
  loading.value = true
  loadError.value = ''
  try {
    const result = await readDirectory(path)
    if (current !== requestId || sid !== props.tab.session?.session_id) return
    entries.value = result
    selected.value = null
    if (cwd.value !== path) query.value = ''
    cwd.value = path
    loaded.value = true
    await nextTick()
    tree.value?.setCurrentKey(path)
  } catch (err) {
    if (current !== requestId) return
    loadError.value = (err as Error).message || '未知错误'
    if ((err as { response?: { status: number } }).response?.status === 410) void window.shellHelper.detachEdits(sid)
  } finally {
    if (current === requestId) loading.value = false
  }
}

async function refresh(): Promise<void> {
  await load()
  if (!loadError.value) treeVersion.value++
}

async function editPath(): Promise<void> {
  pathInput.value = cwd.value
  pathEditing.value = true
  await nextTick()
  addressInput.value?.focus()
  addressInput.value?.select()
}

function goToPath(): void {
  const value = pathInput.value.trim()
  if (!value.startsWith('/') || /[\x00-\x1f\x7f]/.test(value)) {
    ElMessage.warning('请输入以 / 开头的远程目录路径')
    return
  }
  const segments: string[] = []
  for (const segment of value.split('/')) {
    if (segment === '..') segments.pop()
    else if (segment && segment !== '.') segments.push(segment)
  }
  pathEditing.value = false
  void load('/' + segments.join('/'))
}

function fileKind(entry: FileEntry): { icon: string; tone: string; label: string } {
  if (entry.is_dir) return { icon: 'Folder', tone: 'folder', label: '文件夹' }
  if (entry.mode.startsWith('l')) return { icon: 'Link', tone: 'link', label: '符号链接' }
  const ext = entry.name.split('.').pop()?.toLowerCase() || ''
  if (['json', 'yaml', 'yml', 'toml', 'ini', 'conf', 'env'].includes(ext)) return { icon: 'Setting', tone: 'config', label: '配置文件' }
  if (['py', 'js', 'ts', 'tsx', 'vue', 'sh', 'html', 'css', 'go', 'java', 'rs'].includes(ext)) return { icon: 'Document', tone: 'code', label: '代码文件' }
  if (['zip', 'gz', 'tar', '7z'].includes(ext)) return { icon: 'Box', tone: 'archive', label: '归档文件' }
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return { icon: 'Picture', tone: 'image', label: '图片' }
  return { icon: 'Document', tone: 'document', label: '文件' }
}

function onFileKey(event: KeyboardEvent, entry: FileEntry): void {
  if (event.target !== event.currentTarget || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return
  if (event.key === 'Enter') { event.preventDefault(); void open(entry) }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const index = visibleEntries.value.findIndex(e => e.path === entry.path)
    const next = visibleEntries.value[index + (event.key === 'ArrowDown' ? 1 : -1)]
    if (!next) return
    selected.value = next
    const sibling = event.key === 'ArrowDown' ? (event.currentTarget as HTMLElement).nextElementSibling : (event.currentTarget as HTMLElement).previousElementSibling
    ;(sibling as HTMLElement | null)?.focus()
  }
}

async function open(entry: FileEntry): Promise<void> {
  selected.value = entry
  if (loading.value || loadError.value) return
  if (entry.is_dir) { await load(entry.path); return }
  const sessionId = props.tab.session?.session_id
  if (!sessionId || opening.value) return
  if (entry.mode.startsWith('l') || entry.size > MAX_FILE_BYTES) {
    ElMessage.warning('仅支持 10 MiB 以内的普通文本文件，不支持符号链接')
    return
  }
  opening.value = true
  try { await external.open({ sessionId, path: entry.path, hostName: hosts.byId(props.tab.hostId)?.name || props.tab.title }) }
  finally { opening.value = false }
}

function goUp(): void {
  load(parent(cwd.value))
}

async function onNewDir(): Promise<void> {
  const sid = props.tab.session?.session_id
  if (!sid) return
  const { value } = await ElMessageBox.prompt('目录名称', '新建目录', { inputPattern: /\S+/ })
  await fileApi.mkdir(sid, join(cwd.value, value))
  ElMessage.success('已创建')
  await refresh()
}

async function onDelete(entry: FileEntry): Promise<void> {
  const sid = props.tab.session?.session_id
  if (!sid) return
  await ElMessageBox.confirm(`确认删除「${entry.name}」？`, '删除确认', { type: 'warning' })
  await fileApi.remove(sid, entry.path)
  ElMessage.success('已删除')
  await refresh()
}

async function onRename(entry: FileEntry): Promise<void> {
  const sid = props.tab.session?.session_id
  if (!sid) return
  const { value } = await ElMessageBox.prompt('新名称', '重命名', {
    inputValue: entry.name,
    inputPattern: /\S+/
  })
  await fileApi.rename(sid, entry.path, join(cwd.value, value))
  ElMessage.success('已重命名')
  await refresh()
}

async function onRowCommand(cmd: string, row: FileEntry): Promise<void> {
  try {
    if (cmd === 'open') await open(row)
    else if (cmd === 'rename') await onRename(row)
    else if (cmd === 'delete') await onDelete(row)
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error((error as Error).message || '操作失败')
  }
}

async function createFolder(): Promise<void> {
  try { await onNewDir() }
  catch (error) { if (error !== 'cancel' && error !== 'close') ElMessage.error((error as Error).message || '创建失败') }
}

watch(
  () => [props.visible, props.tab.session] as const,
  ([vis]) => {
    if (vis && props.tab.session && !props.tab.connecting && !initialized) {
      initialized = true
      load(initialCwd())
    }
  },
  { immediate: true }
)
</script>

<template>
  <div v-show="visible" class="file-manager">
    <!-- 工具栏 -->
    <div class="fm-toolbar">
      <div class="nav-btns">
        <button class="fm-icon-button" :class="{ active: showTree }" title="切换目录树" aria-label="切换目录树" :aria-pressed="showTree" @click="showTree = !showTree"><el-icon><Fold /></el-icon></button>
        <button class="fm-icon-button" title="上一级目录" aria-label="上一级目录" :disabled="cwd === '/' || loading" @click="goUp"><el-icon><Top /></el-icon></button>
        <button class="fm-icon-button" title="刷新目录" aria-label="刷新目录" :disabled="loading" @click="refresh"><el-icon :class="{ 'is-loading': loading }"><Refresh /></el-icon></button>
      </div>
      <div class="path-box" :title="cwd">
        <el-icon class="path-icon"><FolderOpened /></el-icon>
        <form v-if="pathEditing" class="path-form" @submit.prevent="goToPath">
          <input ref="addressInput" v-model="pathInput" aria-label="远程目录路径" @keydown.esc="pathEditing = false" @blur="pathEditing = false" />
        </form>
        <nav v-else class="breadcrumbs" aria-label="目录路径" @dblclick="editPath">
          <button class="path-segment" :aria-current="cwd === '/' ? 'location' : undefined" @click="load('/')">根目录</button>
          <template v-for="segment in breadcrumbs" :key="segment.path">
            <el-icon class="path-divider"><ArrowRight /></el-icon>
            <button class="path-segment" :aria-current="cwd === segment.path ? 'location' : undefined" @click="load(segment.path)">{{ segment.name }}</button>
          </template>
        </nav>
        <button class="path-edit fm-icon-button" title="输入目录路径" aria-label="输入目录路径" @click="editPath"><el-icon><EditPen /></el-icon></button>
      </div>
    </div>

    <div class="fm-workspace">
      <aside v-show="showTree" class="directory-sidebar" aria-label="远程目录树">
        <div class="tree-heading">目录 <span>远程</span></div>
        <el-tree v-if="loaded" :key="treeVersion" ref="tree" class="directory-tree" node-key="path" lazy :load="loadTree" :props="{ label: 'name' }" :default-expanded-keys="expandedPaths" :current-node-key="cwd" :expand-on-click-node="false" highlight-current :indent="14" @node-click="(node: FolderNode) => load(node.path)">
          <template #default="{ node, data }">
            <span class="tree-label" :title="data.path"><span class="folder-glyph small" :class="{ expanded: node.expanded }" aria-hidden="true"></span><span>{{ data.name }}</span></span>
          </template>
        </el-tree>
        <p v-else class="tree-placeholder">连接后显示目录</p>
        <div class="tree-host"><el-icon><Connection /></el-icon><span :title="host?.host">{{ host?.host || '远程主机' }}</span><span class="connection-dot"></span></div>
      </aside>

      <section class="fm-content" aria-label="远程文件">
        <header class="folder-heading">
          <div class="folder-title"><span class="folder-glyph hero" aria-hidden="true"></span><div><h2 :title="folderName">{{ folderName }}</h2><p>{{ folders }} 个文件夹<span>·</span>{{ entries.length - folders }} 个文件</p></div></div>
          <div class="fm-actions">
            <el-button text :loading="opening" :disabled="!selected || selected.is_dir || loading || !!loadError" :title="settings.hint('openFile')" :icon="'TopRight'" @click="selected && open(selected)">外部打开</el-button>
            <el-button :icon="'FolderAdd'" :disabled="!loaded || loading || !!loadError" @click="createFolder">新建文件夹</el-button>
          </div>
        </header>
        <div class="file-controls">
          <span class="list-label">文件 <span>{{ visibleEntries.length }}</span></span>
          <el-input v-model="query" class="file-search" :prefix-icon="'Search'" clearable placeholder="筛选当前目录…" aria-label="筛选当前目录" />
        </div>
        <!-- 加载失败 -->
        <div v-if="loadError" class="fm-error" role="alert">
          <el-icon :size="32"><WarningFilled /></el-icon><p class="fm-error-title">无法打开此目录</p>
          <p class="fm-error-msg">{{ attemptedPath }} — {{ loadError }}</p>
          <el-button :icon="'Refresh'" @click="load(attemptedPath)">重试</el-button>
        </div>
        <!-- 文件表 -->
        <div v-else v-loading="loading" class="fm-table-wrap" :aria-busy="loading">
          <div class="file-list" role="grid" aria-label="目录内容" :aria-rowcount="visibleEntries.length + 1" :aria-colcount="4">
            <div class="file-columns" role="row"><span role="columnheader">名称 <el-icon><Top /></el-icon></span><span role="columnheader">修改时间</span><span role="columnheader" class="f-size">大小</span><span role="columnheader" aria-label="操作"></span></div>
            <div class="file-rows" role="rowgroup">
              <div v-for="(row, index) in visibleEntries" :key="row.path" class="fm-row" :class="{ selected: selected?.path === row.path, 'is-hidden': row.name.startsWith('.') }" role="row" :aria-selected="selected?.path === row.path" :tabindex="selected ? (selected.path === row.path ? 0 : -1) : (index === 0 ? 0 : -1)" :title="`${row.name}\n${row.mode}\n${fmtTime(row.mtime)}`" @click="selected = row" @focus="selected = row" @dblclick="open(row)" @keydown="onFileKey($event, row)">
                <div class="f-name" role="gridcell">
                  <span v-if="row.is_dir" class="folder-glyph" aria-hidden="true"></span>
                  <span v-else class="file-glyph" :class="fileKind(row).tone" aria-hidden="true"><el-icon><component :is="fileKind(row).icon" /></el-icon></span>
                  <span class="file-name-text">{{ row.name }}</span><el-icon v-if="row.is_dir" class="folder-arrow"><ArrowRight /></el-icon>
                </div>
                <span class="f-time" role="gridcell">{{ fmtTime(row.mtime) }}</span>
                <span class="f-size" role="gridcell">{{ row.is_dir ? '—' : fmtSize(row.size) }}</span>
                <div role="gridcell" @dblclick.stop>
                  <el-dropdown trigger="click" @command="(command: string) => onRowCommand(command, row)">
                    <button class="row-more fm-icon-button" :aria-label="`${row.name} 的更多操作`" :disabled="loading" @click.stop="selected = row"><el-icon><MoreFilled /></el-icon></button>
                    <template #dropdown><el-dropdown-menu>
                      <el-dropdown-item command="open" :icon="row.is_dir ? 'FolderOpened' : 'TopRight'">{{ row.is_dir ? '打开文件夹' : '外部打开' }}</el-dropdown-item>
                      <el-dropdown-item command="rename" :icon="'Edit'">重命名</el-dropdown-item>
                      <el-dropdown-item command="delete" divided :icon="'Delete'" style="color: var(--sh-danger)">删除</el-dropdown-item>
                    </el-dropdown-menu></template>
                  </el-dropdown>
                </div>
              </div>
            </div>
          </div>
          <div v-if="!visibleEntries.length" class="fm-blank">
            <el-icon :size="36"><component :is="query ? 'Search' : 'FolderOpened'" /></el-icon>
            <strong>{{ !loaded ? '正在连接并加载目录…' : query ? '没有匹配的文件' : '这个文件夹还是空的' }}</strong>
            <span>{{ query ? '换个关键词，或清除筛选查看全部文件' : '双击文件夹进入，双击文本文件使用外部编辑器打开' }}</span>
            <el-button v-if="query" text @click="query = ''">清除筛选</el-button>
          </div>
        </div>
      </section>
    </div>
    <!-- 底部统计 -->
    <footer class="fm-status" role="status">
      <span class="protocol-badge">{{ tab.session?.type.toUpperCase() || 'SFTP' }}</span>
      <span class="status-detail" v-if="opening">正在下载并打开…</span>
      <span class="status-detail" v-else-if="editState" :title="editState.message">{{ EDIT_STATUS[editState.status] }} {{ editState.message }}</span>
      <span class="status-detail" v-else-if="selected" :title="selected.path">{{ selected.name }} <span class="status-kind">{{ fileKind(selected).label }} · {{ selected.mode }}</span></span>
      <span class="status-detail" v-else>双击打开 · Enter 进入 · 文本修改后确认回传</span>
      <span class="status-count">{{ query ? `${visibleEntries.length} / ` : '' }}{{ entries.length }} 项</span>
    </footer>
  </div>
</template>

<style scoped>
.file-manager { flex: 1; display: flex; flex-direction: column; min-height: 0; min-width: 0; background: #fff; container-type: inline-size; }
.fm-toolbar { display: flex; align-items: center; gap: 14px; padding: 12px 18px; background: var(--sh-bg-elevated); border-bottom: 1px solid var(--sh-border); }
.nav-btns, .fm-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.fm-icon-button { display: inline-grid; place-items: center; width: 30px; height: 30px; border: 0; border-radius: 6px; background: transparent; color: var(--sh-text-secondary); cursor: pointer; flex-shrink: 0; }
.fm-icon-button:hover:not(:disabled), .fm-icon-button.active { background: var(--sh-bg-hover); color: var(--sh-accent); }
.fm-icon-button:disabled { opacity: .35; cursor: default; }
.path-box { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; height: 34px; padding: 0 5px 0 12px; border: 1px solid var(--sh-border); border-radius: 8px; background: #fff; }
.path-icon { color: var(--sh-text-muted); flex-shrink: 0; }
.breadcrumbs { display: flex; align-items: center; gap: 7px; flex: 1; overflow-x: auto; white-space: nowrap; scrollbar-width: none; }
.path-segment { border: 0; padding: 5px 4px; border-radius: 4px; background: transparent; color: var(--sh-text-secondary); font-size: 12px; cursor: pointer; flex-shrink: 0; }
.path-segment:hover { background: var(--sh-bg); color: var(--sh-accent); }
.path-segment[aria-current] { color: var(--sh-text); font-weight: 600; }
.path-divider { font-size: 10px; color: #a8aea7; flex-shrink: 0; }
.path-edit { width: 26px; height: 26px; color: var(--sh-text-muted); }
.path-form { flex: 1; min-width: 0; }
.path-form input { width: 100%; border: 0; outline: 0; color: var(--sh-text); background: transparent; font: 12px var(--sh-font-mono); user-select: text; }
.path-box:focus-within { border-color: var(--sh-accent); }
.fm-workspace { display: flex; flex: 1; min-height: 0; }
.directory-sidebar { display: flex; flex-direction: column; width: 184px; padding: 18px 10px 12px; flex-shrink: 0; background: #f6f6f2; border-right: 1px solid #ecece6; }
.tree-heading { display: flex; justify-content: space-between; padding: 0 10px 16px; font-size: 12px; font-weight: 600; color: var(--sh-text-secondary); }
.tree-heading > span { font-size: 10px; font-weight: 400; color: var(--sh-text-muted); }
.directory-tree { flex: 1; overflow: auto; background: transparent; --el-tree-node-hover-bg-color: #eaece5; --el-tree-text-color: var(--sh-text-secondary); }
.directory-tree :deep(.el-tree-node__content) { height: 34px; border-radius: 6px; margin: 2px 0; }
.directory-tree :deep(.el-tree-node.is-current > .el-tree-node__content) { background: #e3ebe1; color: #355944; font-weight: 600; }
.directory-tree :deep(.el-tree-node__expand-icon) { color: #929c90; padding: 6px; }
.directory-tree :deep(.el-tree-node__expand-icon.is-leaf) { color: transparent; }
.tree-label { display: flex; align-items: center; gap: 9px; min-width: 0; padding-right: 10px; font-size: 12px; }
.tree-label > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree-placeholder { color: var(--sh-text-muted); font-size: 12px; padding: 0 10px; flex: 1; }
.tree-host { display: flex; align-items: center; gap: 7px; color: var(--sh-text-muted); font-size: 10px; border-top: 1px solid var(--sh-border); padding: 14px 8px 0; margin-top: 12px; }
.tree-host > span:first-of-type { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.connection-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--sh-success); }
.fm-content { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; padding: 0 22px; }
.folder-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 26px 0 22px; flex-wrap: wrap; }
.folder-title { display: flex; align-items: center; gap: 14px; min-width: 0; flex: 1; }
.folder-title > div { min-width: 0; }
.folder-title h2 { margin: 0 0 6px; font-size: 21px; font-weight: 650; letter-spacing: -.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.folder-title p { margin: 0; font-size: 11px; color: var(--sh-text-muted); white-space: nowrap; }
.folder-title p span { margin: 0 7px; }
.fm-actions :deep(.el-button) { margin-left: 0; font-size: 12px; }
.file-controls { display: flex; align-items: center; justify-content: space-between; padding-bottom: 14px; gap: 12px; }
.list-label { font-size: 12px; color: var(--sh-text-secondary); font-weight: 600; white-space: nowrap; }
.list-label > span { display: inline-block; margin-left: 5px; padding: 2px 6px; background: #f0f2ed; border-radius: 5px; font-size: 10px; font-weight: 500; color: var(--sh-text-muted); }
.file-search { max-width: 218px; font-size: 12px; }
.file-search :deep(.el-input__wrapper) { background: #f7f8f5 !important; box-shadow: none !important; }
.fm-table-wrap { flex: 1; min-height: 0; overflow: auto; padding-bottom: 12px; }
.file-columns, .fm-row { display: grid; grid-template-columns: minmax(130px, 1fr) 138px 65px 28px; align-items: center; gap: 14px; padding: 0 10px; }
.file-columns { position: sticky; top: 0; z-index: 1; height: 34px; background: #fff; color: var(--sh-text-muted); border-top: 1px solid #eef0eb; border-bottom: 1px solid #eef0eb; font-size: 11px; }
.file-columns > span:first-child { display: flex; align-items: center; gap: 7px; }
.file-columns .el-icon { font-size: 10px; }
.file-rows { padding-top: 5px; }
/* 紧凑行高≈ 36px */
.fm-row { min-height: 38px; border: 1px solid transparent; border-radius: 7px; cursor: default; margin: 1px 0; transition: background .12s; }
.fm-row:hover { background: #f5f7f3; }
.fm-row.selected { background: #eaf1e7; border-color: #d9e6d4; }
.fm-row:focus-visible { outline-offset: -2px; }
.f-name { display: flex; align-items: center; gap: 12px; min-width: 0; font-size: 12px; }
.file-name-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.is-hidden .file-name-text { color: var(--sh-text-muted); }
.folder-arrow { opacity: 0; color: var(--sh-text-muted); margin-left: auto; flex-shrink: 0; font-size: 10px; }
.fm-row:hover .folder-arrow { opacity: 1; }
.folder-glyph { position: relative; display: inline-block; width: 27px; height: 19px; margin-top: 3px; border-radius: 2px 3px 4px 4px; background: linear-gradient(155deg, #ead092, #dcb267); box-shadow: inset 0 1px 0 #f7e5b9, 0 1px 1px #b99b5630; flex-shrink: 0; }
.folder-glyph::before { content: ''; position: absolute; left: 0; top: -4px; width: 12px; height: 6px; border-radius: 3px 3px 0 0; background: #d3ad66; }
.folder-glyph::after { content: ''; position: absolute; inset: 2px 0 0; border-radius: 2px 3px 4px 4px; background: linear-gradient(155deg, #f0d799, #e2bd75); border-top: 1px solid #f7e7c0; }
.folder-glyph.small { width: 17px; height: 12px; margin-top: 2px; }
.folder-glyph.small::before { width: 8px; height: 4px; top: -2px; }
.folder-glyph.expanded::after { transform: skewX(-8deg) translateX(-1px); }
.folder-glyph.hero { width: 42px; height: 30px; }
.folder-glyph.hero::before { width: 19px; top: -5px; height: 8px; }
.file-glyph { width: 27px; height: 29px; display: grid; place-items: center; border: 1px solid #dfe4e2; border-radius: 4px; color: #8b9997; background: #f7f9f8; flex-shrink: 0; font-size: 18px; box-sizing: border-box; }
.file-glyph.code { color: #6d8fa5; background: #f0f5f8; border-color: #dae6ed; }
.file-glyph.config { color: #8a87aa; background: #f4f2f9; border-color: #e3dfef; }
.file-glyph.archive { color: #ad916a; background: #faf5ec; border-color: #eae1cf; }
.file-glyph.image { color: #6b9b86; background: #f0f7f3; border-color: #d9e8e0; }
.f-size { font-size: 11px; color: var(--sh-text-muted); text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.f-time { font-size: 11px; color: var(--sh-text-muted); white-space: nowrap; }
.row-more { width: 26px; height: 26px; opacity: .25; }
.fm-row:hover .row-more, .fm-row:focus-within .row-more, .fm-row.selected .row-more { opacity: 1; }
.fm-error, .fm-blank { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 44px 16px; text-align: center; color: var(--sh-text-muted); font-size: 12px; }
.fm-error { flex: 1; }
.fm-blank > .el-icon { color: #b4bcae; margin-bottom: 4px; }
.fm-blank strong, .fm-error-title { color: var(--sh-text-secondary); font-size: 14px; font-weight: 500; margin: 0; }
.fm-error-msg { max-width: 420px; overflow-wrap: anywhere; margin: 0 0 8px; }
.fm-status { min-height: 34px; flex-shrink: 0; display: flex; align-items: center; gap: 12px; padding: 0 16px; font-size: 10px; color: var(--sh-text-muted); border-top: 1px solid var(--sh-border); background: var(--sh-bg-elevated); }
.protocol-badge { font-size: 9px; letter-spacing: .6px; font-weight: 600; color: var(--sh-sftp); }
.status-detail { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status-kind { margin-left: 10px; color: var(--sh-text-muted); }
.status-count { margin-left: auto; white-space: nowrap; }
@container (max-width: 780px) {
  .directory-sidebar { width: 150px; padding-inline: 6px; }
  .fm-content { padding: 0 14px; }
  .folder-heading { padding-block: 20px 16px; }
  .folder-title h2 { font-size: 18px; }
  .folder-glyph.hero { width: 32px; height: 23px; }
  .file-columns, .fm-row { grid-template-columns: minmax(100px, 1fr) 65px 26px; gap: 10px; }
  .f-time, .file-columns > span:nth-child(2) { display: none; }
}
@container (max-width: 540px) {
  .directory-sidebar { width: 120px; }
  .fm-toolbar { padding-inline: 10px; gap: 8px; }
  .folder-heading { align-items: flex-start; }
  .fm-actions { flex-wrap: wrap; }
  .folder-title { flex-basis: 100%; }
  .status-kind { display: none; }
}
</style>
