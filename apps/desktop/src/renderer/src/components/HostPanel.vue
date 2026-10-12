<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useHostStore } from '@renderer/stores/host'
import * as hostApi from '@renderer/api/hosts'
import type { Host, HostInput, Protocol } from '@renderer/api/types'
import { isTerminalProto, isFileProto } from '@renderer/api/types'

const emit = defineEmits<{
  (e: 'new-host'): void
  (e: 'edit-host', host: Host): void
  (e: 'open-terminal', id: string): void
  (e: 'open-files', id: string): void
  (e: 'open-default', id: string): void
}>()

const hostStore = useHostStore()
const { grouped, loading, keyword, error, hosts } = storeToRefs(hostStore)

// 单击选中 / 双击连接
const selectedId = ref('')
function onSelect(h: Host): void {
  selectedId.value = h.id
}

// 加载失败后重试
function retryLoad(): void {
  hostStore.refresh().catch(() => undefined)
}

const COLLAPSE_KEY = 'shell-helper:collapsed-groups'
const collapsed = ref<Set<string>>(new Set())
function rememberGroups(): void {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed.value])) } catch { /* 隐私模式写入失败不阻断 */ }
}
function toggleGroup(g: string): void {
  const next = new Set(collapsed.value)
  next.has(g) ? next.delete(g) : next.add(g)
  collapsed.value = next
  rememberGroups()
}
function visibleHosts(): Host[] {
  return grouped.value.flatMap((group) => collapsed.value.has(group.group) ? [] : group.items)
}
function moveSelection(delta: number): void {
  const rows = visibleHosts()
  if (!rows.length) return
  const index = Math.max(0, rows.findIndex((item) => item.id === selectedId.value))
  const next = rows[Math.min(rows.length - 1, Math.max(0, index + delta))]
  selectedId.value = next.id
  void nextTick(() => document.querySelector<HTMLElement>(`[data-host-id="${next.id}"]`)?.focus())
}

function hostIcon(protocol: Protocol): string {
  if (protocol === 'local') return 'Monitor'
  if (protocol === 'telnet') return 'Connection'
  if (protocol === 'ftp' || protocol === 'sftp') return 'FolderOpened'
  return 'Cpu'
}

function protoLabel(h: Host): string {
  return h.protocol.toUpperCase()
}

const canTerminal = (h: Host): boolean => isTerminalProto(h.protocol)
const canFiles = (h: Host): boolean => isFileProto(h.protocol)
const searchInput = ref<{ focus(): void }>()
defineExpose({ focusSearch: () => searchInput.value?.focus() })

function toInput(host: Host, group = host.group): HostInput {
  return {
    name: host.name, group, protocol: host.protocol, host: host.host, port: host.port,
    username: host.username, auth_type: host.auth_type, key_path: host.key_path,
    jump_host_ids: [...host.jump_host_ids], tags: host.tags, remote_cwd: host.remote_cwd, password: null
  }
}

const importInput = ref<HTMLInputElement>()
const dropGroup = ref('')

function onDragStart(event: DragEvent, host: Host): void {
  event.dataTransfer?.setData('text/plain', host.id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

async function onDropGroup(event: DragEvent, group: string): Promise<void> {
  dropGroup.value = ''
  const id = event.dataTransfer?.getData('text/plain') || ''
  const host = hostStore.byId(id)
  if (!host || host.group === group) return
  try { await hostStore.update(id, toInput(host, group)) }
  catch (error) { ElMessage.error((error as Error).message || '无法移动分组') }
}

async function duplicate(host: Host): Promise<void> {
  try {
    await hostStore.create({ ...toInput(host), name: `${host.name} 副本`.slice(0, 200) })
    ElMessage.success('已复制连接，密码需要重新填写')
  } catch (error) { ElMessage.error((error as Error).message || '复制失败') }
}

async function exportHosts(): Promise<void> {
  try {
    const data = await hostApi.exportHosts()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = 'shell-helper-hosts.json'
    link.click()
    URL.revokeObjectURL(link.href)
  } catch (error) { ElMessage.error((error as Error).message || '导出失败') }
}

async function onImport(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    const parsed = JSON.parse(await file.text()) as unknown
    if (!Array.isArray(parsed) || !parsed.length) throw new Error('请选择导出的连接 JSON')
    const items = parsed.map((item) => {
      const host = item as Partial<Host>
      if (!host.name || !host.protocol) throw new Error('连接缺少名称或协议')
      return toInput({
        id: '', name: host.name, group: host.group || '默认分组', protocol: host.protocol,
        host: host.host || '', port: host.port || 22, username: host.username || '',
        auth_type: host.auth_type || 'password', credential_id: null, key_path: host.key_path || '',
        jump_host_ids: Array.isArray(host.jump_host_ids) ? host.jump_host_ids : [],
        tags: host.tags || '', remote_cwd: host.remote_cwd || '~'
      })
    })
    await hostApi.importHosts(items)
    await hostStore.refresh()
    ElMessage.success(`已导入 ${items.length} 条连接，密码需要重新填写`)
  } catch (error) { ElMessage.error((error as Error).message || '导入失败') }
}

async function onRowCommand(cmd: string, host: Host): Promise<void> {
  if (cmd === 'terminal' && canTerminal(host)) emit('open-terminal', host.id)
  else if (cmd === 'files' && canFiles(host)) emit('open-files', host.id)
  else if (cmd === 'edit') emit('edit-host', host)
  else if (cmd === 'duplicate') await duplicate(host)
  else if (cmd === 'del') {
    try {
      await ElMessageBox.confirm(`确认删除主机「${host.name}」？`, '删除确认', {
        type: 'warning',
        confirmButtonText: '删除',
        cancelButtonText: '取消'
      })
      if (selectedId.value === host.id) selectedId.value = ''
      await hostStore.remove(host.id)
    } catch {
      /* 用户取消 */
    }
  }
}

onMounted(() => {
  try {
    const saved = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]') as unknown
    if (Array.isArray(saved)) collapsed.value = new Set(saved.filter((item): item is string => typeof item === 'string'))
  } catch { /* 忽略损坏的折叠记录 */ }
  hostStore.refresh().catch(() => undefined)
})
</script>

<template>
  <div class="host-panel">
    <div class="panel-heading">
      <span>连接库 <span class="library-count">{{ hosts.length }}</span></span>
      <el-tooltip content="新建连接">
        <button class="panel-add" aria-label="新建连接" @click="emit('new-host')"><el-icon><Plus /></el-icon></button>
      </el-tooltip>
    </div>
    <div class="panel-tools">
      <button type="button" @click="exportHosts">导出</button>
      <button type="button" @click="importInput?.click()">导入</button>
      <input ref="importInput" class="upload-input" type="file" accept="application/json,.json" aria-label="导入连接" @change="onImport" />
    </div>
    <div class="panel-toolbar">
      <el-input
        ref="searchInput"
        v-model="keyword"
        placeholder="搜索连接…"
        aria-label="搜索主机、IP 或标签"
        clearable
        :prefix-icon="'Search'"
      />
    </div>

    <el-scrollbar class="panel-scroll" v-loading="loading">
      <!-- 加载失败 -->
      <div v-if="error" class="panel-empty">
        <el-icon :size="34"><WarningFilled /></el-icon>
        <p>主机列表加载失败</p>
        <span class="empty-sub">{{ error }}</span>
        <el-button size="small" @click="retryLoad">重试</el-button>
      </div>

      <!-- 暂无主机 -->
      <div v-else-if="!hosts.length" class="panel-empty">
        <el-icon :size="28"><Connection /></el-icon>
        <p>把常用的连接放在这里</p>
        <span class="empty-sub">常用主机与远程文件，随时切换。</span>
        <el-button text size="small" :icon="'Plus'" @click="emit('new-host')">添加连接</el-button>
      </div>

      <!-- 搜索无匹配 -->
      <div v-else-if="!grouped.length" class="panel-empty">
        <el-icon :size="34"><Search /></el-icon>
        <p>没有匹配「{{ keyword }}」的主机</p>
        <el-button size="small" text @click="keyword = ''">清除搜索</el-button>
      </div>

      <div v-for="g in grouped" v-else :key="g.group" class="group-block">
        <button class="group-title" :class="{ drop: dropGroup === g.group }" :aria-expanded="!collapsed.has(g.group)" @click="toggleGroup(g.group)" @dragover.prevent="dropGroup = g.group" @dragleave="dropGroup = ''" @drop.prevent="onDropGroup($event, g.group)">
          <el-icon class="caret" :class="{ collapsed: collapsed.has(g.group) }"><ArrowDown /></el-icon>
          <span class="g-name">{{ g.group }}</span>
          <span class="g-count">{{ g.items.length }}</span>
        </button>

        <div v-show="!collapsed.has(g.group)">
          <div
            v-for="h in g.items"
            :key="h.id"
            class="host-row"
            :class="{ selected: selectedId === h.id }"
            tabindex="0"
            role="group"
            :data-host-id="h.id"
            draggable="true"
            :aria-label="h.name"
            :title="h.protocol === 'local' ? '此电脑 · 默认 Shell' : `${h.username}@${h.host}:${h.port}`"
            @click="onSelect(h)"
            @dblclick="emit('open-default', h.id)"
            @keydown.enter.self.prevent="emit('open-default', h.id)"
            @keydown.up.self.prevent="moveSelection(-1)"
            @keydown.down.self.prevent="moveSelection(1)"
            @keydown.space.self.prevent="onSelect(h)"
            @dragstart="onDragStart($event, h)"
          >
          <div class="host-icon" :class="`proto-${h.protocol}`">
            <el-icon><component :is="hostIcon(h.protocol)" /></el-icon>
          </div>
          <div class="host-body">
            <span class="host-name">{{ h.name }}</span>
            <span v-if="h.tags" class="host-tags">{{ h.tags.split(',').map(tag => tag.trim()).filter(Boolean).slice(0, 3).join(' · ') }}</span>
            <span class="host-addr">{{ h.protocol === 'local' ? '此电脑 · 默认 Shell' : `${h.username}@${h.host}:${h.port}` }}</span>
          </div>
          <span class="proto-tag" :class="`proto-${h.protocol}`">{{ protoLabel(h) }}</span>
          <div class="host-actions" @dblclick.stop>
            <button class="act" title="连接" :aria-label="`连接 ${h.name}`" @click.stop="emit('open-default', h.id)"><el-icon><Right /></el-icon></button>
            <el-dropdown trigger="click" @command="(c: string) => onRowCommand(c, h)">
              <button class="act" :aria-label="`${h.name} 的更多操作`" title="更多操作" @click.stop><el-icon><MoreFilled /></el-icon></button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item v-if="canTerminal(h)" command="terminal" :icon="'Cellphone'">打开终端</el-dropdown-item>
                  <el-dropdown-item v-if="canFiles(h)" command="files" :icon="'FolderOpened'">文件管理</el-dropdown-item>
                  <el-dropdown-item command="edit" :icon="'Edit'">编辑</el-dropdown-item>
                  <el-dropdown-item command="duplicate" :icon="'CopyDocument'">复制连接</el-dropdown-item>
                  <el-dropdown-item command="del" divided :icon="'Delete'" class="is-danger">
                    删除
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </div>
        </div>
      </div>
    </el-scrollbar>
    <div class="panel-footer"><el-icon><Pointer /></el-icon><span>方向键移动，Enter 或双击连接</span></div>
  </div>
</template>

<style scoped>
.host-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.panel-heading {
  height: 44px;
  padding: 0 16px 0 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 600;
}
.library-count { margin-left: 7px; font: 11px var(--sh-font-mono); color: var(--sh-text-muted); }
.panel-add {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--sh-text-secondary);
  cursor: pointer;
}
.panel-add:hover { background: var(--sh-bg-active); color: var(--sh-text); }
.panel-toolbar {
  display: flex;
  padding: 8px 14px 14px;
}
.panel-tools { display: flex; gap: 8px; padding: 0 16px 2px; }
.panel-tools button { border: 0; background: transparent; color: var(--sh-text-secondary); font-size: 11px; cursor: pointer; padding: 0; }
.panel-tools .upload-input { display: none; }
.panel-toolbar :deep(.el-input__wrapper) {
  background: var(--sh-bg-panel) !important;
  box-shadow: none !important;
  font-size: 12px;
}
.group-title.drop { background: var(--sh-bg-active); }
.host-tags { display: block; color: var(--sh-text-muted); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.panel-toolbar :deep(.el-input__wrapper.is-focus) { box-shadow: 0 0 0 1px var(--sh-accent-border) inset !important; }
.panel-toolbar .el-input {
  flex: 1;
}
.panel-footer {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 16px 20px;
  font-size: 10px;
  color: var(--sh-text-muted);
}
.panel-scroll {
  flex: 1;
  min-height: 0;
}
.panel-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 48px 16px;
  color: var(--sh-text-muted);
}
.panel-empty p {
  margin: 0;
  font-size: 13px;
}
.empty-sub {
  font-size: 12px;
  color: var(--sh-text-muted);
  max-width: 220px;
  text-align: center;
  word-break: break-all;
}

/* 分组 */
.group-block {
  padding: 0 10px 12px;
}
.group-title {
  width: 100%;
  border: 0;
  background: transparent;
  text-align: left;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 8px;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.4px;
  color: var(--sh-text-muted);
  text-transform: uppercase;
  cursor: pointer;
  user-select: none;
  border-radius: var(--sh-radius-sm);
}
.group-title:hover {
  color: var(--sh-text-secondary);
}
.caret {
  font-size: 10px;
  transition: transform 0.16s ease;
}
.caret.collapsed {
  transform: rotate(-90deg);
}
.g-name {
  flex: 1;
}
.g-count {
  color: var(--sh-text-muted);
  padding: 0 4px;
  font-size: 10px;
  line-height: 16px;
}

/* 主机行 */
.host-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 8px;
  margin-bottom: 2px;
  border-radius: var(--sh-radius);
  cursor: pointer;
  position: relative;
  border: 1px solid transparent;
  transition: background 0.14s ease, border-color 0.14s ease;
}
.host-row:hover {
  background: var(--sh-bg-hover);
}
.host-row.selected {
  background: var(--sh-bg-selected);
  border-color: transparent;
}
.host-row:hover .host-actions,
.host-row:focus-within .host-actions,
.host-row.selected .host-actions {
  opacity: 1;
}
.host-icon {
  width: 24px;
  height: 28px;
  flex-shrink: 0;
  border-radius: var(--sh-radius);
  display: grid;
  place-items: center;
  background: transparent;
  font-size: 16px;
}
.host-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  line-height: 1.35;
}
.host-name {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.host-addr {
  margin-top: 3px;
  font: 10px var(--sh-font-mono);
  color: var(--sh-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.proto-tag {
  flex-shrink: 0;
  font: 9px var(--sh-font-mono);
  letter-spacing: 0.3px;
  padding: 2px 3px;
  color: var(--sh-text-muted);
  transition: opacity 0.14s ease;
}
.host-actions {
  display: flex;
  flex-shrink: 0;
  gap: 2px;
}
.act {
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--sh-radius-sm);
  display: grid;
  place-items: center;
  background: transparent;
  color: var(--sh-text-secondary);
  cursor: pointer;
  transition: all 0.12s ease;
}
.act:hover {
  background: var(--sh-accent-soft);
  color: var(--sh-accent);
}

:deep(.el-dropdown-menu__item.is-danger) {
  color: var(--sh-danger);
}
</style>
