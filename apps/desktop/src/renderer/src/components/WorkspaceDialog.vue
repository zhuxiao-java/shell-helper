<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useWorkspacesStore, type Workspace, type WorkspaceEntry } from '@renderer/stores/workspaces'
import { useHostStore } from '@renderer/stores/host'
import { useSessionStore } from '@renderer/stores/session'
import { isFileProto } from '@renderer/api/types'

const open = defineModel<boolean>({ required: true })
const workspaces = useWorkspacesStore()
const hosts = useHostStore()
const session = useSessionStore()
const creating = ref(false)
const form = reactive({ name: '', selected: [] as string[], startupCommand: '', localPath: '' })
const busy = ref('')

const hostMap = computed(() => new Map(hosts.hosts.map(host => [host.id, host])))
const availableHosts = computed(() => hosts.hosts.filter(host => host.protocol !== 'local'))
const currentEntries = computed<WorkspaceEntry[]>(() => session.tabs
  .filter(tab => tab.hostId && hostMap.value.has(tab.hostId))
  .map(tab => ({ hostId: tab.hostId, kind: tab.kind, startupCommand: tab.kind === 'terminal' ? tab.startupCommand : '' })))

function entryLabel(entry: WorkspaceEntry): string {
  const host = hostMap.value.get(entry.hostId)
  return host ? `${host.name} · ${entry.kind === 'files' ? '文件' : '终端'}` : '主机已删除'
}

function clearForm(): void {
  form.name = ''
  form.selected = []
  form.startupCommand = ''
  form.localPath = ''
}

async function chooseLocal(): Promise<void> {
  try { const path = await window.shellHelper.chooseDirectory(); if (path) form.localPath = path }
  catch (error) { ElMessage.error((error as Error).message || '无法选择目录') }
}

function add(): void {
  if (!form.selected.length) { ElMessage.warning('请选择至少一个主机'); return }
  const name = form.name.trim() || `工作区 ${new Date().toLocaleDateString('zh-CN')}`
  workspaces.create({
    name,
    localPath: form.localPath,
    entries: form.selected.map(hostId => {
      const host = hostMap.value.get(hostId)
      const kind: WorkspaceEntry['kind'] = host && isFileProto(host.protocol) ? 'files' : 'terminal'
      return { hostId, kind, startupCommand: kind === 'terminal' ? form.startupCommand.trim() : '' }
    })
  })
  ElMessage.success('工作区已创建')
  clearForm()
  creating.value = false
}

function saveCurrent(): void {
  if (!currentEntries.value.length) { ElMessage.info('当前没有可保存的主机标签'); return }
  const name = form.name.trim() || `工作区 ${new Date().toLocaleDateString('zh-CN')}`
  workspaces.create({ name, entries: currentEntries.value, localPath: form.localPath })
  ElMessage.success(`已保存 ${currentEntries.value.length} 个标签为工作区`)
  clearForm()
  creating.value = false
}

function hostKind(hostId: string): string {
  const host = hostMap.value.get(hostId)
  if (!host) return '主机已删除'
  return isFileProto(host.protocol) ? '文件' : '终端'
}

async function launch(workspace: Workspace): Promise<void> {
  const entries = workspace.entries.filter(entry => hostMap.value.has(entry.hostId))
  if (!entries.length) { ElMessage.warning('工作区里的主机都已删除'); return }
  busy.value = workspace.id
  try {
    if (workspace.localPath) localStorage.setItem('shell-helper-local-pane', workspace.localPath)
    for (const entry of entries) {
      if (entry.kind === 'files') await session.openFiles(entry.hostId)
      else await session.openTerminal(entry.hostId, entry.startupCommand || '')
    }
    ElMessage.success(`已打开工作区「${workspace.name}」`)
    open.value = false
  } catch (error) {
    ElMessage.error((error as Error).message || '打开工作区失败')
  } finally { busy.value = '' }
}

async function remove(workspace: Workspace): Promise<void> {
  try { await ElMessageBox.confirm(`删除工作区「${workspace.name}」？`, '删除工作区', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }) }
  catch { return }
  workspaces.remove(workspace.id)
  ElMessage.success('已删除')
}
</script>

<template>
  <el-dialog v-model="open" title="工作区" width="680px" append-to-body class="workspace-dialog">
    <div class="ws-head">
      <div><strong>把主机、文件页和启动命令打包</strong><p>一键恢复标签；工作区只保存在本机浏览器存储，不包含密码或密钥。</p></div>
      <el-button size="small" @click="creating = !creating">{{ creating ? '取消新建' : '新建工作区' }}</el-button>
    </div>

    <div v-if="creating" class="ws-create">
      <div class="ws-row">
        <label>名称<el-input v-model="form.name" maxlength="80" placeholder="例如：支付服务排障" /></label>
        <label>本地目录（可选）<div class="ws-path"><el-input v-model="form.localPath" readonly placeholder="选择本地项目目录" /><el-button size="small" @click="chooseLocal">选择</el-button></div></label>
      </div>
      <label class="ws-field">主机<el-select v-model="form.selected" multiple filterable collapse-tags placeholder="选择要一起打开的主机" style="width:100%"><el-option v-for="host in availableHosts" :key="host.id" :label="`${host.name} · ${hostKind(host.id)}`" :value="host.id" /></el-select></label>
      <label class="ws-field">终端启动命令（可选）<el-input v-model="form.startupCommand" placeholder="例如：cd /srv/app && make dev" /></label>
      <div class="ws-create-actions">
        <el-button size="small" :disabled="!currentEntries.length" @click="saveCurrent">保存当前 {{ currentEntries.length }} 个标签</el-button>
        <el-button size="small" type="primary" @click="add">创建工作区</el-button>
      </div>
    </div>

    <div v-if="workspaces.items.length" class="ws-list">
      <article v-for="workspace in workspaces.items" :key="workspace.id" class="ws-card">
        <div class="ws-card-main">
          <div class="ws-card-title"><strong>{{ workspace.name }}</strong><span>{{ workspace.entries.length }} 个标签</span></div>
          <p class="ws-entry-line">{{ workspace.entries.map(entryLabel).join(' · ') }}</p>
          <p v-if="workspace.localPath" class="ws-local" :title="workspace.localPath"><el-icon><FolderOpened /></el-icon>{{ workspace.localPath }}</p>
        </div>
        <div class="ws-card-actions">
          <el-button size="small" type="primary" :loading="busy === workspace.id" @click="launch(workspace)">打开</el-button>
          <button type="button" class="ws-delete" title="删除工作区" @click="remove(workspace)"><el-icon><Delete /></el-icon></button>
        </div>
      </article>
    </div>
    <div v-else class="ws-empty"><el-icon><FolderOpened /></el-icon><span>还没有工作区。把常用的主机和启动方式保存下来，下次一键进入。</span></div>
  </el-dialog>
</template>

<style scoped>
.ws-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; margin-bottom: 14px; }
.ws-head strong { display: block; font-size: 12px; color: var(--sh-text); }
.ws-head p { margin: 3px 0 0; color: var(--sh-text-muted); font-size: 10px; line-height: 1.6; }
.ws-create { padding: 12px; margin-bottom: 14px; border: 1px solid var(--sh-border); border-radius: 10px; background: var(--sh-bg); }
.ws-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.ws-create label, .ws-field { display: flex; flex-direction: column; gap: 5px; color: var(--sh-text-muted); font-size: 10px; }
.ws-field { margin-top: 10px; }
.ws-path { display: flex; gap: 4px; }
.ws-path .el-input { min-width: 0; }
.ws-create-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 11px; }
.ws-list { display: flex; flex-direction: column; gap: 7px; }
.ws-card { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 11px; border: 1px solid var(--sh-border); border-radius: 9px; background: var(--sh-bg); }
.ws-card-main { min-width: 0; flex: 1; }
.ws-card-title { display: flex; align-items: center; gap: 8px; }
.ws-card-title strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--sh-text); font-weight: 600; }
.ws-card-title span { flex-shrink: 0; padding: 1px 5px; border-radius: 4px; background: var(--sh-bg-panel); color: var(--sh-text-muted); font-size: 9px; }
.ws-entry-line { margin: 4px 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--sh-text-secondary); font-size: 10px; }
.ws-local { display: flex; align-items: center; gap: 4px; margin: 3px 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--sh-text-muted); font: 9px var(--sh-font-mono); }
.ws-card-actions { flex-shrink: 0; display: flex; align-items: center; gap: 3px; }
.ws-delete { width: 26px; height: 26px; display: grid; place-items: center; border: 0; border-radius: 5px; background: transparent; color: var(--sh-text-muted); font-size: 12px; cursor: pointer; }
.ws-delete:hover { background: var(--sh-bg-hover); color: var(--sh-danger); }
.ws-empty { display: flex; align-items: flex-start; gap: 8px; padding: 16px 10px; color: var(--sh-text-muted); font-size: 11px; line-height: 1.6; }
.ws-empty .el-icon { margin-top: 1px; font-size: 15px; }
</style>
