<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useLanStore } from '@renderer/stores/lan'
import { useHostStore } from '@renderer/stores/host'
import type { Host } from '@renderer/api/types'
import type { SharedHost } from '../../../shared/lan'

const open = defineModel<boolean>({ required: true })
const props = defineProps<{ host?: Host | null }>()
const lan = useLanStore()
const hosts = useHostStore()
const hostId = ref('')
const targetId = ref('')
const sending = ref(false)

const peers = computed(() => lan.peers)
const hostOptions = computed(() => hosts.hosts.filter(host => host.protocol !== 'local'))
const selectedHost = computed(() => props.host || hosts.byId(hostId.value))
const selectedPeer = computed(() => peers.value.find(peer => peer.id === targetId.value))
const sharedHost = computed<SharedHost | null>(() => {
  const host = selectedHost.value
  if (!host) return null
  return {
    name: host.name,
    protocol: host.protocol,
    host: host.host,
    port: host.port,
    username: host.username,
    group: host.group,
    tags: host.tags,
    remoteCwd: host.remote_cwd
  }
})

watch(open, value => {
  if (!value) return
  hostId.value = props.host?.id || hostOptions.value[0]?.id || ''
  targetId.value = ''
  sending.value = false
})
watch(() => props.host, host => { if (open.value) hostId.value = host?.id || hostOptions.value[0]?.id || '' })

function initial(name: string): string {
  return (name || '?').trim().slice(0, 1).toUpperCase()
}

async function send(): Promise<void> {
  if (!sharedHost.value || !targetId.value || sending.value) return
  sending.value = true
  try {
    const result = await lan.shareHost(targetId.value, sharedHost.value)
    if (!result.ok) { ElMessage.error(result.error || '分享失败'); return }
    ElMessage.success(`已向 ${selectedPeer.value?.name || '对方'} 分享「${sharedHost.value.name}」`)
    open.value = false
  } finally { sending.value = false }
}
</script>

<template>
  <el-dialog v-model="open" title="分享连接" width="540px" append-to-body class="share-lan-dialog">
    <div class="share-body">
      <div class="share-field">
        <span>选择连接</span>
        <div v-if="props.host" class="share-host-preview">
          <span class="share-host-icon"><el-icon><Connection /></el-icon></span>
          <div><strong>{{ props.host.name }}</strong><small>{{ props.host.protocol.toUpperCase() }} · {{ props.host.username }}@{{ props.host.host }}:{{ props.host.port }}</small></div>
        </div>
        <el-select v-else v-model="hostId" placeholder="选择要分享的连接" aria-label="选择要分享的连接">
          <el-option v-for="host in hostOptions" :key="host.id" :label="`${host.name} · ${host.protocol.toUpperCase()}`" :value="host.id" />
        </el-select>
      </div>

      <div class="share-peer-head"><span>发送给在线用户</span><small>{{ peers.length }} 在线</small></div>
      <div v-if="peers.length" class="share-peer-list" role="listbox" aria-label="在线用户">
        <button v-for="peer in peers" :key="peer.id" type="button" class="share-peer" :class="{ active: peer.id === targetId }" role="option" :aria-selected="peer.id === targetId" @click="targetId = peer.id">
          <span class="share-avatar">{{ initial(peer.name) }}</span>
          <span class="share-peer-copy"><strong>{{ peer.name }}</strong><small>{{ peer.device }} · {{ peer.address }}</small></span>
          <span v-if="peer.id === targetId" class="share-peer-check">✓</span>
        </button>
      </div>
      <div v-else class="share-empty">
        <el-icon><Connection /></el-icon>
        <p>暂无在线用户。请确认对方开启了局域网发现，且处于同一网络。</p>
      </div>

      <div class="share-note"><el-icon><Lock /></el-icon><span>只分享名称、协议、地址、端口、用户名、分组和标签。密码、密钥和跳板配置不会离开本机；导入后需补充凭据。</span></div>
    </div>
    <template #footer>
      <el-button @click="open = false">取消</el-button>
      <el-button type="primary" :disabled="!sharedHost || !selectedPeer" :loading="sending" @click="send">发送配置</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.share-body { display: flex; flex-direction: column; gap: 16px; }
.share-field { display: flex; flex-direction: column; gap: 7px; }
.share-field > span, .share-peer-head > span { font-size: 12px; font-weight: 500; color: var(--sh-text); }
.share-field :deep(.el-select) { width: 100%; }
.share-host-preview { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--sh-border); border-radius: 10px; background: var(--sh-bg); }
.share-host-icon { width: 30px; height: 30px; flex-shrink: 0; display: grid; place-items: center; border-radius: 8px; background: var(--sh-accent-soft); color: var(--sh-accent); font-size: 15px; }
.share-host-preview strong { display: block; font-size: 12px; font-weight: 500; color: var(--sh-text); }
.share-host-preview small { display: block; margin-top: 2px; color: var(--sh-text-muted); font: 10px var(--sh-font-mono); }
.share-peer-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.share-peer-head small { color: var(--sh-text-muted); font-size: 10px; }
.share-peer-list { display: flex; flex-direction: column; gap: 4px; max-height: 210px; overflow: auto; }
.share-peer { display: flex; align-items: center; gap: 9px; width: 100%; padding: 8px; border: 1px solid var(--sh-border); border-radius: 8px; background: var(--sh-bg-panel); text-align: left; cursor: pointer; }
.share-peer:hover { background: var(--sh-bg-hover); }
.share-peer.active { border-color: var(--sh-accent); background: var(--sh-accent-soft); }
.share-avatar { width: 28px; height: 28px; flex-shrink: 0; display: grid; place-items: center; border-radius: 50%; background: var(--sh-bg); color: var(--sh-accent); font-size: 11px; font-weight: 600; }
.share-peer-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.share-peer-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 500; color: var(--sh-text); }
.share-peer-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--sh-text-muted); font-size: 10px; }
.share-peer-check { width: 18px; height: 18px; flex-shrink: 0; display: grid; place-items: center; border-radius: 50%; background: var(--sh-accent); color: #fff; font-size: 11px; }
.share-empty { display: flex; align-items: flex-start; gap: 8px; padding: 14px; border: 1px dashed var(--sh-border); border-radius: 9px; color: var(--sh-text-muted); font-size: 11px; line-height: 1.6; }
.share-empty p { margin: 0; }
.share-note { display: flex; align-items: flex-start; gap: 7px; padding: 9px 10px; border-radius: 7px; background: var(--sh-bg); color: var(--sh-text-muted); font-size: 10px; line-height: 1.6; }
.share-note .el-icon { flex-shrink: 0; margin-top: 1px; color: var(--sh-accent); }
</style>
