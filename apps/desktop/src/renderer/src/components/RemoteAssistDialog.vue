<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useRemoteAssistStore } from '@renderer/stores/remoteAssist'

const assist = useRemoteAssistStore()
const remoteVideo = ref<HTMLVideoElement>()
const localVideo = ref<HTMLVideoElement>()
const chatInput = ref('')
const chatBody = ref<HTMLDivElement>()

function attach(video: HTMLVideoElement | undefined, stream: MediaStream | null): void {
  if (!video) return
  if (video.srcObject !== stream) video.srcObject = stream
}

watch([() => assist.remoteStream, remoteVideo], ([stream]) => attach(remoteVideo.value, stream), { flush: 'post' })
watch([() => assist.localStream, localVideo], ([stream]) => attach(localVideo.value, stream), { flush: 'post' })
watch(() => assist.messages.length, async () => {
  await nextTick()
  if (chatBody.value) chatBody.value.scrollTop = chatBody.value.scrollHeight
})

function sendChat(): void {
  const text = chatInput.value
  chatInput.value = ''
  assist.sendChat(text)
}

function close(): void {
  assist.end()
}
</script>

<template>
  <el-dialog :model-value="true" :show-close="true" :close-on-click-modal="false" width="900px" top="6vh" append-to-body class="assist-dialog" :title="assist.call ? `远程协助 · ${assist.call.peerName}` : '远程协助'" @close="close">
    <div v-if="assist.call" class="assist-body">
      <div class="assist-meta">
        <span class="assist-dot" :class="assist.call.status"></span>
        <span>{{ assist.call.status === 'incoming' ? '收到共享请求' : assist.call.status === 'inviting' ? '等待对方接受' : assist.call.status === 'connecting' ? '正在建立画面…' : '画面已连接' }}</span>
        <span class="assist-device">{{ assist.call.peerDevice }}</span>
        <span v-if="assist.call.role === 'host'" class="assist-badge">你正在共享屏幕</span>
        <span v-else class="assist-badge">只读查看</span>
      </div>

      <div v-if="assist.call.status === 'incoming'" class="assist-incoming">
        <el-icon><Monitor /></el-icon>
        <h3>{{ assist.call.peerName }} 请求共享屏幕</h3>
        <p>接受后你将以只读方式看到对方的屏幕，并可以文字聊天。对方的麦克风音频可能同时传输。</p>
        <div><el-button type="primary" @click="assist.accept">接受并查看</el-button><el-button @click="assist.reject">拒绝</el-button></div>
      </div>

      <div v-else-if="assist.call.status === 'inviting'" class="assist-incoming">
        <el-icon class="is-loading"><Loading /></el-icon>
        <h3>等待 {{ assist.call.peerName }} 接受</h3>
        <p>对方接受后会立即请求共享主屏幕。请确保系统允许屏幕录制。</p>
        <div><el-button @click="close">取消邀请</el-button></div>
      </div>

      <template v-else>
        <div class="assist-stage">
          <video v-if="assist.call.role === 'guest'" ref="remoteVideo" class="assist-video" autoplay playsinline />
          <video v-else ref="localVideo" class="assist-video assist-local" autoplay muted playsinline />
          <div v-if="assist.call.status === 'connecting'" class="assist-connecting"><el-icon class="is-loading"><Loading /></el-icon><span>正在协商画面…</span></div>
          <div v-if="assist.error" class="assist-error" role="alert">{{ assist.error }}</div>
        </div>

        <div class="assist-footer">
          <div class="assist-actions">
            <el-button v-if="assist.call.role === 'host' && assist.error && !assist.localStream" size="small" type="primary" @click="assist.retryShare">重新开始共享</el-button>
            <el-button v-if="assist.call.role === 'host'" size="small" @click="assist.toggleMic">{{ assist.micEnabled ? '静音麦克风' : '打开麦克风' }}</el-button>
            <el-button size="small" type="danger" plain @click="close">结束协助</el-button>
          </div>
          <span class="assist-hint">屏幕内容通过 WebRTC 点对点传输，不经过公网或录制服务。</span>
        </div>

        <div class="assist-chat">
          <div class="assist-chat-head"><strong>文字聊天</strong><span>只在当前会话可见</span></div>
          <div ref="chatBody" class="assist-chat-body">
            <div v-if="!assist.messages.length" class="assist-chat-empty">发送命令、地址或排障提示…</div>
            <div v-for="message in assist.messages" :key="message.id" class="assist-message" :class="message.from">{{ message.text }}</div>
          </div>
          <div class="assist-chat-input"><el-input v-model="chatInput" size="small" placeholder="输入消息，Enter 发送" @keydown.enter.prevent="sendChat" /><el-button size="small" @click="sendChat">发送</el-button></div>
        </div>
      </template>
    </div>
  </el-dialog>
</template>

<style scoped>
.assist-body { display: flex; flex-direction: column; gap: 10px; }
.assist-meta { display: flex; align-items: center; gap: 7px; color: var(--sh-text-muted); font-size: 11px; }
.assist-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--sh-text-muted); }
.assist-dot.incoming, .assist-dot.inviting { background: var(--sh-warning); }
.assist-dot.connecting { background: var(--sh-accent); animation: assist-pulse 1s ease-in-out infinite; }
.assist-dot.connected { background: var(--sh-success); }
@keyframes assist-pulse { 50% { opacity: 0.28; } }
.assist-device { margin-left: auto; font: 10px var(--sh-font-mono); }
.assist-badge { padding: 1px 5px; border-radius: 4px; background: var(--sh-bg); color: var(--sh-text-secondary); font-size: 9px; }
.assist-incoming { min-height: 260px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 24px; border: 1px solid var(--sh-border); border-radius: 10px; background: var(--sh-bg); text-align: center; }
.assist-incoming .el-icon { font-size: 30px; color: var(--sh-accent); }
.assist-incoming h3 { margin: 2px 0 0; font-size: 16px; font-weight: 600; color: var(--sh-text); }
.assist-incoming p { max-width: 480px; margin: 0 0 6px; color: var(--sh-text-muted); font-size: 11px; line-height: 1.7; }
.assist-stage { position: relative; min-height: 360px; max-height: 56vh; display: grid; place-items: center; border-radius: 10px; overflow: hidden; background: #0f1115; }
.assist-video { width: 100%; height: 100%; max-height: 56vh; object-fit: contain; background: #0f1115; }
.assist-local { opacity: 0.88; }
.assist-connecting { position: absolute; display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-radius: 6px; background: rgba(15, 17, 21, 0.82); color: #cfd3d6; font-size: 11px; }
.assist-error { position: absolute; left: 12px; right: 12px; bottom: 12px; padding: 8px 10px; border-radius: 6px; background: rgba(127, 29, 29, 0.9); color: #fff; font-size: 11px; }
.assist-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.assist-actions { display: flex; gap: 5px; }
.assist-hint { color: var(--sh-text-muted); font-size: 9px; text-align: right; line-height: 1.5; }
.assist-chat { border: 1px solid var(--sh-border); border-radius: 9px; background: var(--sh-bg); overflow: hidden; }
.assist-chat-head { display: flex; align-items: center; justify-content: space-between; padding: 7px 9px; border-bottom: 1px solid var(--sh-border); }
.assist-chat-head strong { font-size: 11px; font-weight: 600; color: var(--sh-text); }
.assist-chat-head span { color: var(--sh-text-muted); font-size: 9px; }
.assist-chat-body { height: 110px; overflow: auto; padding: 7px 9px; }
.assist-chat-empty { color: var(--sh-text-muted); font-size: 10px; }
.assist-message { width: fit-content; max-width: 82%; margin-bottom: 5px; padding: 5px 8px; border-radius: 7px; background: var(--sh-bg-panel); color: var(--sh-text-secondary); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
.assist-message.me { margin-left: auto; background: var(--sh-accent-soft); color: var(--sh-text); }
.assist-chat-input { display: flex; gap: 5px; padding: 6px; border-top: 1px solid var(--sh-border); }
.assist-chat-input .el-input { flex: 1; }
</style>
