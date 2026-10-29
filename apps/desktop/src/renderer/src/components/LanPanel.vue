<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useLanStore } from '@renderer/stores/lan'
import { useHostStore } from '@renderer/stores/host'
import type { LanEvent, LanPeer, SharedTerminal } from '../../../shared/lan'

const open = defineModel<boolean>({ required: true })
const emit = defineEmits<{ (e: 'share'): void; (e: 'open-terminal', terminal: SharedTerminal): void; (e: 'assist', peer: LanPeer): void }>()
const lan = useLanStore()
const hosts = useHostStore()
const displayName = ref('')
const savingName = ref(false)
const avatarInput = ref<HTMLInputElement>()
const avatarBusy = ref(false)

const peers = computed(() => lan.peers)
const events = computed(() => lan.events)
const terminals = computed(() => lan.terminals)
const profile = computed(() => lan.profile)
const enabled = computed(() => lan.enabled)
const unread = computed(() => lan.unread)

watch(() => profile.value.name, name => { if (!savingName.value) displayName.value = name }, { immediate: true })
watch(open, value => { if (value) displayName.value = profile.value.name })

function initial(name: string): string {
  return (name || '?').trim().slice(0, 1).toUpperCase()
}

function avatarTone(id: string): Record<string, string> {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0
  return { background: `hsl(${Math.abs(hash) % 360} 45% 42%)`, color: '#fff' }
}

async function onAvatarFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (!file.type.startsWith('image/')) { ElMessage.warning('请选择图片文件'); return }
  if (file.size > 8 * 1024 * 1024) { ElMessage.warning('图片不能超过 8 MiB'); return }
  avatarBusy.value = true
  try {
    const dataUrl = await resizeAvatar(file)
    await lan.setAvatar(dataUrl)
    ElMessage.success('头像已更新')
  } catch (error) {
    ElMessage.error((error as Error).message || '头像处理失败')
  } finally { avatarBusy.value = false }
}

function resizeAvatar(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      try {
        const size = 64
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('无法绘制头像')
        const scale = Math.max(size / image.width, size / image.height)
        const width = image.width * scale
        const height = image.height * scale
        ctx.drawImage(image, (size - width) / 2, (size - height) / 2, width, height)
        let data = canvas.toDataURL('image/webp', 0.72)
        if (data.length > 3000) {
          canvas.width = 48; canvas.height = 48
          const small = canvas.getContext('2d')
          if (!small) throw new Error('无法绘制头像')
          small.drawImage(image, (48 - width * 48 / 64) / 2, (48 - height * 48 / 64) / 2, width * 48 / 64, height * 48 / 64)
          data = canvas.toDataURL('image/webp', 0.62)
        }
        if (data.length > 3200) throw new Error('头像压缩后仍然过大，请换一张更简单的图片')
        resolve(data)
      } catch (error) { reject(error) } finally { URL.revokeObjectURL(url) }
    }
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法读取图片')) }
    image.src = url
  })
}
function relTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return new Date(ts).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

function actionLabel(event: LanEvent): string {
  return { created: '新建了', modified: '修改了', renamed: '重命名了', deleted: '删除了' }[event.action || 'modified'] || '修改了'
}

async function saveName(): Promise<void> {
  const name = displayName.value.trim()
  if (!name || name === profile.value.name) { displayName.value = profile.value.name; return }
  savingName.value = true
  try { await lan.setName(name) }
  finally { savingName.value = false }
}

async function toggleEnabled(value: boolean | string | number): Promise<void> {
  await lan.setEnabled(Boolean(value))
}

async function joinTerminal(terminal: SharedTerminal): Promise<void> {
  try { await lan.joinTerminal(terminal.id); emit('open-terminal', { ...terminal, joined: true }) }
  catch (error) { ElMessage.error((error as Error).message || '无法加入共享终端') }
}

async function leaveTerminal(terminal: SharedTerminal): Promise<void> {
  try { await lan.leaveTerminal(terminal.id) }
  catch (error) { ElMessage.error((error as Error).message || '无法离开共享终端') }
}

async function stopOwnShare(terminal: SharedTerminal): Promise<void> {
  try { await lan.stopTerminalShare(terminal.id); ElMessage.success('已停止共享') }
  catch (error) { ElMessage.error((error as Error).message || '无法停止共享') }
}

async function importSharedHost(event: LanEvent): Promise<void> {
  if (!event.host) return
  try {
    await hosts.create({
      name: event.host.name,
      group: '局域网分享',
      protocol: event.host.protocol as 'ssh' | 'sftp' | 'ftp' | 'telnet',
      host: event.host.host,
      port: event.host.port,
      username: event.host.username,
      auth_type: 'password',
      key_path: '',
      jump_host_ids: [],
      tags: event.host.tags,
      remote_cwd: event.host.remoteCwd || '/',
      password: null
    })
    ElMessage.success(`已导入「${event.host.name}」，请编辑并补充凭据`)
  } catch (error) {
    ElMessage.error((error as Error).message || '导入连接失败')
  }
}

async function markRead(): Promise<void> {
  await lan.markRead()
}
</script>

<template>
  <el-drawer v-model="open" :with-header="false" size="390px" append-to-body destroy-on-close class="lan-drawer">
    <div class="lan-panel">
      <header class="lan-head">
        <div>
          <h2>局域网</h2>
          <p>发现同一网络中的 Shell Helper 用户</p>
        </div>
        <button class="lan-close" type="button" aria-label="关闭局域网面板" title="关闭" @click="open = false"><el-icon><Close /></el-icon></button>
      </header>

      <section class="lan-profile-card">
        <button class="lan-avatar lan-avatar-self lan-avatar-button" :style="profile.avatar ? undefined : avatarTone(profile.id)" type="button" title="设置我的头像" aria-label="设置我的头像" :disabled="avatarBusy" @click="avatarInput?.click()">
          <img v-if="profile.avatar" :src="profile.avatar" alt="我的头像" />
          <template v-else>{{ initial(profile.name) }}</template>
          <span class="avatar-edit"><el-icon><Picture /></el-icon></span>
        </button>
        <input ref="avatarInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden @change="onAvatarFile" />
        <div class="lan-profile-main">
          <input v-model="displayName" class="lan-name-input" aria-label="局域网显示名" maxlength="40" @blur="saveName" @keydown.enter.prevent="saveName" />
          <small>{{ profile.device }} · {{ enabled ? '正在广播' : '未启用发现' }}</small>
        </div>
        <el-switch :model-value="enabled" aria-label="启用局域网发现" @change="toggleEnabled" />
      </section>
      <p v-if="lan.error" class="lan-error" role="alert">{{ lan.error }}</p>
      <p v-else-if="!enabled" class="lan-hint">开启后会在当前局域网广播显示名和设备名，不会上传任何连接或文件内容。</p>

      <section class="lan-section">
        <div class="lan-section-head"><h3>在线用户</h3><span class="lan-count">{{ peers.length }} 在线</span></div>
        <div v-if="peers.length" class="lan-peer-list">
          <div v-for="peer in peers" :key="peer.id" class="lan-peer">
            <span class="lan-avatar" :style="peer.avatar ? undefined : avatarTone(peer.id)">
              <img v-if="peer.avatar" :src="peer.avatar" alt="" />
              <template v-else>{{ initial(peer.name) }}</template>
            </span>
            <div class="lan-peer-copy"><strong>{{ peer.name }}</strong><small>{{ peer.device }} · {{ peer.address }}</small></div>
            <button class="lan-peer-assist" type="button" title="共享屏幕给此用户" @click="emit('assist', peer)"><el-icon><Share /></el-icon>屏幕</button>
            <span class="lan-online-dot" title="在线"></span>
          </div>
        </div>
        <div v-else class="lan-empty">
          <el-icon><Connection /></el-icon>
          <span>{{ enabled ? '未发现在线用户，确认对方也开启了局域网发现。' : '启用局域网发现后，其他用户会出现在这里。' }}</span>
        </div>
      </section>

      <section class="lan-section">
        <div class="lan-section-head"><h3>共享终端</h3><span class="lan-count">{{ terminals.length }} 个</span></div>
        <div v-if="terminals.length" class="lan-terminal-list">
          <article v-for="terminal in terminals" :key="terminal.id" class="lan-terminal">
            <span class="lan-terminal-icon"><el-icon><Monitor /></el-icon></span>
            <div class="lan-terminal-body">
              <strong>{{ terminal.title }}</strong>
              <small>{{ terminal.self ? '我的共享' : terminal.ownerName }}<template v-if="terminal.hostName"> · {{ terminal.hostName }}</template></small>
            </div>
            <button v-if="terminal.self" class="lan-terminal-action" type="button" @click="stopOwnShare(terminal)">停止</button>
            <button v-else-if="terminal.joined" class="lan-terminal-action" type="button" @click="leaveTerminal(terminal)">离开</button>
            <button v-else class="lan-terminal-action primary" type="button" @click="joinTerminal(terminal)">加入</button>
          </article>
        </div>
        <div v-else class="lan-empty"><el-icon><Monitor /></el-icon><span>在终端右上角点击「共享」，其他在线用户就能在这里加入只读查看。</span></div>
      </section>

      <section class="lan-section">
        <div class="lan-section-head">
          <h3>动态</h3>
          <button v-if="unread" class="lan-text-button" type="button" @click="markRead">全部已读</button>
        </div>
        <div v-if="events.length" class="lan-event-list">
          <article v-for="event in events" :key="event.id" class="lan-event" :class="{ unread: !event.read }">
            <span class="lan-event-icon" :class="`is-${event.kind}`"><el-icon><Share v-if="event.kind === 'share'" /><Document v-else /></el-icon></span>
            <div class="lan-event-body">
              <p v-if="event.kind === 'share'">
                <strong>{{ event.fromName }}</strong> 分享了连接 <b>{{ event.host?.name || '未命名连接' }}</b>
              </p>
              <p v-else><strong>{{ event.fromName }}</strong> {{ actionLabel(event) }} <b>{{ event.hostName }}</b> 上的文件</p>
              <small v-if="event.kind === 'share'" class="lan-path">{{ event.host?.protocol.toUpperCase() }} · {{ event.host?.username }}@{{ event.host?.host }}:{{ event.host?.port }}</small>
              <small v-else class="lan-path" :title="event.path">{{ event.path }}</small>
              <div class="lan-event-meta"><span>{{ event.fromDevice }} · {{ relTime(event.at) }}</span><button v-if="event.kind === 'share'" class="lan-import" type="button" @click="importSharedHost(event)">导入连接</button></div>
            </div>
          </article>
        </div>
        <div v-else class="lan-empty">
          <el-icon><Document /></el-icon>
          <span>文件修改和连接分享会显示在这里。</span>
        </div>
      </section>

      <button class="lan-share-action" type="button" :disabled="!peers.length" @click="emit('share')"><el-icon><Share /></el-icon><span>分享连接给在线用户</span></button>

      <p class="lan-privacy"><el-icon><Lock /></el-icon>仅广播显示名、设备名和操作提示；连接分享不包含密码、密钥或跳板配置。</p>
    </div>
  </el-drawer>
</template>

<style scoped>
.lan-drawer :deep(.el-drawer__body) { padding: 0; overflow: auto; }
.lan-panel { min-height: 100%; display: flex; flex-direction: column; gap: 14px; padding: 18px 18px 20px; background: var(--sh-bg-panel); color: var(--sh-text); }
.lan-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.lan-head h2 { margin: 0 0 3px; font-size: 19px; font-weight: 600; letter-spacing: -0.3px; }
.lan-head p { margin: 0; color: var(--sh-text-muted); font-size: 11px; }
.lan-close { width: 28px; height: 28px; display: grid; place-items: center; border: 0; border-radius: 6px; background: transparent; color: var(--sh-text-muted); cursor: pointer; }
.lan-close:hover { background: var(--sh-bg-hover); color: var(--sh-text); }
.lan-profile-card { display: flex; align-items: center; gap: 10px; padding: 11px; border: 1px solid var(--sh-border); border-radius: 12px; background: var(--sh-bg); }
.lan-avatar { position: relative; width: 32px; height: 32px; flex-shrink: 0; display: grid; place-items: center; border-radius: 50%; overflow: hidden; background: var(--sh-accent-soft); color: #fff; font-size: 13px; font-weight: 600; }
.lan-avatar img { width: 100%; height: 100%; object-fit: cover; }
.lan-avatar-button { padding: 0; border: 0; cursor: pointer; }
.lan-avatar-button:hover .avatar-edit { opacity: 1; }
.avatar-edit { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(0,0,0,.42); color: #fff; font-size: 12px; opacity: 0; transition: opacity .15s; }
.lan-avatar-self { background: var(--sh-ink); color: var(--sh-on-ink); }
.lan-profile-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.lan-name-input { width: 100%; padding: 0; border: 0; outline: 0; background: transparent; color: var(--sh-text); font: 500 13px var(--sh-font-ui); }
.lan-name-input:focus { text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--sh-accent); }
.lan-profile-main small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--sh-text-muted); font-size: 10px; }
.lan-hint, .lan-error { margin: 0; padding: 9px 10px; border-radius: 7px; background: var(--sh-bg); color: var(--sh-text-muted); font-size: 11px; line-height: 1.6; }
.lan-error { background: var(--sh-warning-bg); color: var(--sh-warning-text); }
.lan-section { min-height: 0; }
.lan-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 7px; }
.lan-section-head h3 { margin: 0; font-size: 12px; font-weight: 600; color: var(--sh-text); }
.lan-count { color: var(--sh-text-muted); font-size: 10px; }
.lan-text-button { padding: 0; border: 0; background: transparent; color: var(--sh-accent); font-size: 11px; cursor: pointer; }
.lan-peer-list { display: flex; flex-direction: column; gap: 2px; }
.lan-peer { display: flex; align-items: center; gap: 9px; padding: 7px; border-radius: 8px; }
.lan-peer:hover { background: var(--sh-bg-hover); }
.lan-peer-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.lan-peer-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 500; }
.lan-peer-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--sh-text-muted); font-size: 10px; }
.lan-peer-assist { flex-shrink: 0; display: inline-flex; align-items: center; gap: 3px; padding: 2px 5px; border: 0; border-radius: 4px; background: transparent; color: var(--sh-text-muted); font-size: 9px; cursor: pointer; }
.lan-peer-assist:hover { background: var(--sh-bg-panel); color: var(--sh-accent); }
.lan-online-dot { width: 6px; height: 6px; flex-shrink: 0; border-radius: 50%; background: var(--sh-success); box-shadow: 0 0 0 3px var(--sh-success-soft, transparent); }
.lan-empty { display: flex; align-items: flex-start; gap: 8px; padding: 12px 9px; color: var(--sh-text-muted); font-size: 11px; line-height: 1.6; }
.lan-empty .el-icon { margin-top: 1px; font-size: 14px; }
.lan-terminal-list { display: flex; flex-direction: column; gap: 4px; }
.lan-terminal { display: flex; align-items: center; gap: 8px; padding: 7px; border-radius: 8px; background: var(--sh-bg); }
.lan-terminal-icon { width: 25px; height: 25px; flex-shrink: 0; display: grid; place-items: center; border-radius: 7px; background: var(--sh-accent-soft); color: var(--sh-accent); font-size: 13px; }
.lan-terminal-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.lan-terminal-body strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-weight: 500; color: var(--sh-text); }
.lan-terminal-body small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--sh-text-muted); font-size: 9px; }
.lan-terminal-action { flex-shrink: 0; padding: 0; border: 0; background: transparent; color: var(--sh-text-muted); font-size: 10px; cursor: pointer; }
.lan-terminal-action:hover { color: var(--sh-text); }
.lan-terminal-action.primary { color: var(--sh-accent); }
.lan-event-list { display: flex; flex-direction: column; gap: 5px; max-height: 340px; overflow: auto; }
.lan-event { display: flex; gap: 9px; padding: 9px 7px; border: 1px solid transparent; border-radius: 9px; background: var(--sh-bg); }
.lan-event.unread { border-color: var(--sh-border); background: var(--sh-bg-panel); }
.lan-event-icon { width: 25px; height: 25px; flex-shrink: 0; display: grid; place-items: center; border-radius: 7px; background: var(--sh-accent-soft); color: var(--sh-accent); font-size: 13px; }
.lan-event-icon.is-file { background: var(--sh-bg-hover); color: var(--sh-text-secondary); }
.lan-event-body { min-width: 0; flex: 1; }
.lan-event-body p { margin: 0 0 2px; font-size: 11px; line-height: 1.5; color: var(--sh-text-secondary); }
.lan-event-body p strong { color: var(--sh-text); font-weight: 500; }
.lan-event-body p b { color: var(--sh-text); font-weight: 500; }
.lan-path { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--sh-text-muted); font: 10px var(--sh-font-mono); }
.lan-event-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 4px; color: var(--sh-text-muted); font-size: 9px; }
.lan-import { padding: 0; border: 0; background: transparent; color: var(--sh-accent); font-size: 10px; cursor: pointer; }
.lan-share-action { display: flex; align-items: center; justify-content: center; gap: 7px; min-height: 34px; margin-top: auto; border: 1px solid var(--sh-border); border-radius: 8px; background: var(--sh-bg); color: var(--sh-text-secondary); font-size: 12px; cursor: pointer; }
.lan-share-action:hover:not(:disabled) { border-color: var(--sh-border-strong); color: var(--sh-accent); }
.lan-share-action:disabled { opacity: 0.45; cursor: default; }
.lan-privacy { display: flex; align-items: flex-start; gap: 6px; margin: 0; color: var(--sh-text-muted); font-size: 10px; line-height: 1.6; }
.lan-privacy .el-icon { flex-shrink: 0; margin-top: 1px; }
</style>
