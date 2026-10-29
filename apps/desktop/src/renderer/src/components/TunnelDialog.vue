<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import * as tunnelApi from '@renderer/api/tunnels'
import type { TunnelRule } from '@renderer/api/tunnels'
import type { Host } from '@renderer/api/types'

const open = defineModel<boolean>({ required: true })
const props = defineProps<{ host?: Host | null }>()
const rules = ref<TunnelRule[]>([])
const loading = ref(false)
const busy = ref('')
const form = reactive({ name: '本地转发', local_port: 8080, remote_host: '127.0.0.1', remote_port: 80 })
const title = computed(() => props.host ? `${props.host.name} · 端口转发` : '端口转发')

async function load(): Promise<void> {
  if (!props.host) { rules.value = []; return }
  loading.value = true
  try { rules.value = await tunnelApi.listTunnels(props.host.id) }
  catch (error) { ElMessage.error((error as Error).message || '读取转发规则失败') }
  finally { loading.value = false }
}

watch(open, value => {
  if (!value) return
  form.name = '本地转发'
  form.local_port = 8080
  form.remote_host = '127.0.0.1'
  form.remote_port = 80
  void load()
})
watch(() => props.host, () => { if (open.value) void load() })

async function add(): Promise<void> {
  if (!props.host) return
  if (!form.remote_host.trim()) { ElMessage.warning('请输入远端主机'); return }
  busy.value = 'add'
  try {
    await tunnelApi.createTunnel({ host_id: props.host.id, ...form, name: form.name.trim() || '本地转发' })
    ElMessage.success('已添加转发规则')
    await load()
  } catch (error) { ElMessage.error((error as Error).message || '添加失败') }
  finally { busy.value = '' }
}

async function start(rule: TunnelRule): Promise<void> {
  busy.value = `start:${rule.id}`
  try {
    const updated = await tunnelApi.startTunnel(rule.id)
    rules.value = rules.value.map(item => item.id === rule.id ? updated : item)
    ElMessage.success('端口转发已启动')
  } catch (error) { ElMessage.error((error as Error).message || '启动失败') }
  finally { busy.value = '' }
}

async function stop(rule: TunnelRule): Promise<void> {
  busy.value = `stop:${rule.id}`
  try {
    const updated = await tunnelApi.stopTunnel(rule.id)
    rules.value = rules.value.map(item => item.id === rule.id ? updated : item)
    ElMessage.success('端口转发已停止')
  } catch (error) { ElMessage.error((error as Error).message || '停止失败') }
  finally { busy.value = '' }
}

async function remove(rule: TunnelRule): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除转发规则「${rule.name}」？`, '删除规则', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' })
  } catch { return }
  busy.value = `delete:${rule.id}`
  try {
    await tunnelApi.deleteTunnel(rule.id)
    ElMessage.success('已删除')
    await load()
  } catch (error) { ElMessage.error((error as Error).message || '删除失败') }
  finally { busy.value = '' }
}

async function copyAddress(rule: TunnelRule): Promise<void> {
  const port = rule.bound_port || rule.local_port
  if (!port) { ElMessage.warning('规则尚未绑定本地端口'); return }
  try { await window.shellHelper.copyText(`127.0.0.1:${port}`); ElMessage.success('本地地址已复制') }
  catch (error) { ElMessage.error((error as Error).message || '复制失败') }
}
</script>

<template>
  <el-dialog v-model="open" :title="title" width="620px" append-to-body class="tunnel-dialog">
    <div class="tunnel-body">
      <div class="tunnel-host"><el-icon><Connection /></el-icon><span>{{ props.host ? `${props.host.username}@${props.host.host}:${props.host.port}` : '未选择主机' }}</span></div>
      <p class="tunnel-note">在当前电脑的 <code>127.0.0.1</code> 上监听，通过 SSH 转发到远端。关闭应用会停止所有转发；不支持远程转发和 SOCKS。</p>

      <section class="tunnel-section">
        <div class="tunnel-section-head"><h3>规则</h3><span>{{ rules.length }} 条</span><button class="tunnel-refresh" type="button" :disabled="loading" title="刷新状态" aria-label="刷新转发状态" @click="load"><el-icon :class="{ 'is-loading': loading }"><Refresh /></el-icon></button></div>
        <div v-if="rules.length" class="tunnel-list">
          <article v-for="rule in rules" :key="rule.id" class="tunnel-card">
            <div class="tunnel-card-main">
              <div class="tunnel-card-title">
                <span class="tunnel-status" :class="rule.status"></span>
                <strong>{{ rule.name }}</strong>
                <span class="tunnel-badge">{{ rule.status === 'running' ? '运行中' : rule.status === 'error' ? '异常' : '已停止' }}</span>
              </div>
              <button class="tunnel-address" type="button" :title="`复制 127.0.0.1:${rule.bound_port || rule.local_port}`" @click="copyAddress(rule)">
                <el-icon><CopyDocument /></el-icon>
                <code>127.0.0.1:{{ rule.bound_port || rule.local_port || '自动' }}</code>
                <span>→</span>
                <code>{{ rule.remote_host }}:{{ rule.remote_port }}</code>
              </button>
              <p v-if="rule.error" class="tunnel-error">{{ rule.error }}</p>
            </div>
            <div class="tunnel-card-actions">
              <el-button v-if="rule.status !== 'running'" size="small" :loading="busy === `start:${rule.id}`" @click="start(rule)">启动</el-button>
              <el-button v-else size="small" :loading="busy === `stop:${rule.id}`" @click="stop(rule)">停止</el-button>
              <button class="tunnel-delete" type="button" :disabled="!!busy" title="删除规则" :aria-label="`删除 ${rule.name}`" @click="remove(rule)"><el-icon><Delete /></el-icon></button>
            </div>
          </article>
        </div>
        <div v-else class="tunnel-empty"><el-icon><Connection /></el-icon><span>还没有转发规则。添加一条本地端口转发开始。</span></div>
      </section>

      <section class="tunnel-section tunnel-add">
        <div class="tunnel-section-head"><h3>添加规则</h3><span>本地转发</span></div>
        <div class="tunnel-form">
          <label><span>名称</span><el-input v-model="form.name" maxlength="200" placeholder="例如：内网 Web" /></label>
          <label><span>本地端口</span><el-input-number v-model="form.local_port" :min="0" :max="65535" controls-position="right" /></label>
          <label><span>远端主机</span><el-input v-model="form.remote_host" placeholder="127.0.0.1" /></label>
          <label><span>远端端口</span><el-input-number v-model="form.remote_port" :min="1" :max="65535" controls-position="right" /></label>
        </div>
        <div class="tunnel-add-footer"><span>本地端口填 0 时自动分配；同名主机可保存多条规则。</span><el-button type="primary" :icon="'Plus'" :loading="busy === 'add'" @click="add">添加规则</el-button></div>
      </section>
    </div>
  </el-dialog>
</template>

<style scoped>
.tunnel-body { display: flex; flex-direction: column; gap: 14px; }
.tunnel-host { display: flex; align-items: center; gap: 7px; color: var(--sh-text-secondary); font: 11px var(--sh-font-mono); }
.tunnel-host .el-icon { color: var(--sh-accent); }
.tunnel-note { margin: 0; padding: 9px 10px; border-radius: 7px; background: var(--sh-bg); color: var(--sh-text-muted); font-size: 11px; line-height: 1.6; }
.tunnel-note code { color: var(--sh-text-secondary); font: 10px var(--sh-font-mono); }
.tunnel-section { padding-top: 2px; }
.tunnel-section + .tunnel-section { border-top: 1px solid var(--sh-border); padding-top: 14px; }
.tunnel-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.tunnel-section-head h3 { margin: 0; font-size: 12px; font-weight: 600; color: var(--sh-text); }
.tunnel-section-head span { margin-left: auto; color: var(--sh-text-muted); font-size: 10px; }
.tunnel-refresh { width: 22px; height: 22px; display: grid; place-items: center; border: 0; border-radius: 5px; background: transparent; color: var(--sh-text-muted); font-size: 12px; cursor: pointer; }
.tunnel-refresh:hover:not(:disabled) { background: var(--sh-bg-hover); color: var(--sh-text); }
.tunnel-list { display: flex; flex-direction: column; gap: 7px; }
.tunnel-card { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 10px; border: 1px solid var(--sh-border); border-radius: 9px; background: var(--sh-bg); }
.tunnel-card-main { min-width: 0; flex: 1; }
.tunnel-card-title { display: flex; align-items: center; gap: 6px; min-width: 0; }
.tunnel-card-title strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 500; color: var(--sh-text); }
.tunnel-status { width: 6px; height: 6px; flex-shrink: 0; border-radius: 50%; background: var(--sh-text-muted); }
.tunnel-status.running { background: var(--sh-success); }
.tunnel-status.error { background: var(--sh-danger); }
.tunnel-badge { flex-shrink: 0; padding: 1px 4px; border-radius: 3px; background: var(--sh-bg-panel); color: var(--sh-text-muted); font-size: 9px; }
.tunnel-address { display: flex; align-items: center; gap: 5px; min-width: 0; margin-top: 4px; padding: 0; border: 0; background: transparent; color: var(--sh-text-muted); font-size: 10px; cursor: pointer; }
.tunnel-address code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 10px var(--sh-font-mono); }
.tunnel-address:hover code { color: var(--sh-accent); }
.tunnel-error { margin: 5px 0 0; color: var(--sh-danger); font-size: 10px; line-height: 1.5; overflow-wrap: anywhere; }
.tunnel-card-actions { flex-shrink: 0; display: flex; align-items: center; gap: 3px; }
.tunnel-delete { width: 26px; height: 26px; display: grid; place-items: center; border: 0; border-radius: 5px; background: transparent; color: var(--sh-text-muted); font-size: 12px; cursor: pointer; }
.tunnel-delete:hover { background: var(--sh-bg-hover); color: var(--sh-danger); }
.tunnel-delete:disabled { opacity: 0.35; cursor: default; }
.tunnel-empty { display: flex; align-items: flex-start; gap: 7px; padding: 13px 9px; color: var(--sh-text-muted); font-size: 11px; line-height: 1.6; }
.tunnel-empty .el-icon { margin-top: 1px; font-size: 14px; }
.tunnel-form { display: grid; grid-template-columns: 1fr 120px; gap: 9px; }
.tunnel-form label { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.tunnel-form label:nth-child(3) { grid-column: 1; }
.tunnel-form label:nth-child(4) { grid-column: 2; }
.tunnel-form label > span { color: var(--sh-text-muted); font-size: 10px; }
.tunnel-form :deep(.el-input-number) { width: 100%; }
.tunnel-add-footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 9px; }
.tunnel-add-footer > span { color: var(--sh-text-muted); font-size: 10px; line-height: 1.5; }
</style>
