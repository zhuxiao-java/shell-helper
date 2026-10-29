import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import { ElMessage } from 'element-plus'
import type { LanAssistEvent, LanPeer } from '../../../shared/lan'

export type AssistRole = 'host' | 'guest'
export type AssistStatus = 'incoming' | 'inviting' | 'connecting' | 'connected'

export interface AssistCall {
  peerId: string
  peerName: string
  peerDevice: string
  role: AssistRole
  status: AssistStatus
}

export interface AssistMessage {
  id: string
  from: 'me' | 'peer'
  text: string
  at: number
}

export const useRemoteAssistStore = defineStore('remote-assist', () => {
  const call = ref<AssistCall | null>(null)
  const localStream = shallowRef<MediaStream | null>(null)
  const remoteStream = shallowRef<MediaStream | null>(null)
  const messages = ref<AssistMessage[]>([])
  const error = ref('')
  const micEnabled = ref(true)
  const screenActive = ref(false)
  const dialogOpen = computed(() => !!call.value)
  let pc: RTCPeerConnection | null = null
  let channel: RTCDataChannel | null = null
  let unsubscribe: (() => void) | undefined
  let pendingCandidates: RTCIceCandidateInit[] = []
  let initialized = false

  function send(peerId: string, payload: Record<string, unknown>): void {
    void window.shellHelper.sendLanAssist(peerId, payload).then(result => {
      if (!result.ok && call.value?.peerId === peerId) error.value = result.error || '发送失败'
    }).catch((err: Error) => { error.value = err.message || '发送失败' })
  }

  function setupChannel(next: RTCDataChannel): void {
    channel = next
    next.onopen = () => { /* 聊天通道就绪 */ }
    next.onmessage = event => {
      if (typeof event.data !== 'string') return
      try {
        const payload = JSON.parse(event.data) as { type?: string; text?: string }
        if (payload.type === 'chat' && payload.text) appendMessage('peer', payload.text)
      } catch { /* 忽略无效聊天数据 */ }
    }
  }

  function appendMessage(from: 'me' | 'peer', text: string): void {
    const clean = text.trim().slice(0, 4000)
    if (!clean) return
    messages.value.push({ id: crypto.randomUUID(), from, text: clean, at: Date.now() })
  }

  function createPeer(): RTCPeerConnection {
    const next = new RTCPeerConnection({ iceServers: [] })
    pc = next
    next.onicecandidate = event => {
      if (event.candidate && call.value) send(call.value.peerId, { type: 'assist-ice', candidate: event.candidate.toJSON() })
    }
    next.ontrack = event => {
      const stream = event.streams[0] || new MediaStream([event.track])
      remoteStream.value = stream
    }
    next.onconnectionstatechange = () => {
      if (!call.value) return
      if (next.connectionState === 'connected') { call.value.status = 'connected'; error.value = '' }
      else if (next.connectionState === 'failed') { error.value = 'WebRTC 连接失败，请确认双方在同一局域网'; end(false) }
      else if (next.connectionState === 'disconnected') { error.value = '连接暂时中断' }
    }
    next.ondatachannel = event => setupChannel(event.channel)
    return next
  }

  async function flushCandidates(): Promise<void> {
    if (!pc || !pc.remoteDescription) return
    const queued = pendingCandidates
    pendingCandidates = []
    for (const candidate of queued) {
      try { await pc.addIceCandidate(candidate) } catch { /* 忽略过期候选 */ }
    }
  }

  async function startHostMedia(): Promise<void> {
    if (!call.value || call.value.role !== 'host') return
    call.value.status = 'connecting'
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false })
      screenActive.value = true
      localStream.value = display
      let audio: MediaStream | null = null
      try { audio = await navigator.mediaDevices.getUserMedia({ audio: true }) } catch { ElMessage.warning('麦克风不可用，继续仅共享屏幕') }
      const peer = createPeer()
      for (const track of display.getTracks()) peer.addTrack(track, display)
      for (const track of audio?.getTracks() || []) { display.addTrack(track); peer.addTrack(track, display) }
      display.getVideoTracks()[0]?.addEventListener('ended', () => { if (call.value) void end(true) })
      setupChannel(peer.createDataChannel('chat'))
      const offer = await peer.createOffer()
      await peer.setLocalDescription(offer)
      send(call.value.peerId, { type: 'assist-offer', sdp: peer.localDescription })
    } catch (err) {
      error.value = (err as Error).name === 'NotAllowedError' ? '屏幕共享已取消或没有权限' : ((err as Error).message || '无法开始屏幕共享')
      if (call.value) send(call.value.peerId, { type: 'assist-hangup', reason: error.value })
      end(false)
    }
  }

  async function acceptOffer(sdp: RTCSessionDescriptionInit): Promise<void> {
    if (!call.value) return
    call.value.status = 'connecting'
    try {
      const peer = createPeer()
      await peer.setRemoteDescription(sdp)
      await flushCandidates()
      const answer = await peer.createAnswer()
      await peer.setLocalDescription(answer)
      send(call.value.peerId, { type: 'assist-answer', sdp: peer.localDescription })
    } catch (err) {
      error.value = (err as Error).message || '无法建立远程画面'
      end(false)
    }
  }

  async function addCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!pc || !pc.remoteDescription) { pendingCandidates.push(candidate); return }
    try { await pc.addIceCandidate(candidate) } catch { /* 忽略过期候选 */ }
  }

  function handleSignal(event: LanAssistEvent): void {
    const type = typeof event.payload.type === 'string' ? event.payload.type : ''
    if (type === 'assist-invite') {
      if (call.value) {
        void window.shellHelper.sendLanAssist(event.peerId, { type: 'assist-reject', reason: 'busy' })
        return
      }
      call.value = { peerId: event.peerId, peerName: event.peerName, peerDevice: event.peerDevice, role: 'guest', status: 'incoming' }
      error.value = ''
      messages.value = []
      return
    }
    if (!call.value || call.value.peerId !== event.peerId) return
    if (type === 'assist-accept' && call.value.role === 'host') { void startHostMedia(); return }
    if (type === 'assist-reject') { ElMessage.info(`${event.peerName} 拒绝了屏幕共享`); end(false); return }
    if (type === 'assist-offer') {
      const sdp = event.payload.sdp as RTCSessionDescriptionInit | undefined
      if (sdp) void acceptOffer(sdp)
      return
    }
    if (type === 'assist-answer' && call.value.role === 'host') {
      const sdp = event.payload.sdp as RTCSessionDescriptionInit | undefined
      if (sdp && pc) void pc.setRemoteDescription(sdp).then(flushCandidates).catch(() => { error.value = '无法读取对方画面参数' })
      return
    }
    if (type === 'assist-ice') {
      const candidate = event.payload.candidate as RTCIceCandidateInit | undefined
      if (candidate) void addCandidate(candidate)
      return
    }
    if (type === 'assist-chat') {
      if (typeof event.payload.text === 'string') appendMessage('peer', event.payload.text)
      return
    }
    if (type === 'assist-hangup') { end(false); return }
  }

  function initialize(): void {
    if (initialized) return
    initialized = true
    unsubscribe = window.shellHelper.onLanAssist(handleSignal)
  }

  function invite(peer: LanPeer): void {
    if (call.value) { ElMessage.info('当前已有远程协助会话'); return }
    if (!window.shellHelper) return
    call.value = { peerId: peer.id, peerName: peer.name, peerDevice: peer.device, role: 'host', status: 'inviting' }
    error.value = ''
    messages.value = []
    send(peer.id, { type: 'assist-invite' })
  }

  function retryShare(): void {
    if (!call.value || call.value.role !== 'host') return
    if (localStream.value) return
    void startHostMedia()
  }

  function accept(): void {
    if (!call.value || call.value.role !== 'guest') return
    call.value.status = 'connecting'
    send(call.value.peerId, { type: 'assist-accept' })
  }

  function reject(): void {
    if (call.value) send(call.value.peerId, { type: 'assist-reject', reason: 'declined' })
    end(false)
  }

  function sendChat(text: string): void {
    if (!call.value) return
    const value = text.trim().slice(0, 4000)
    if (!value) return
    if (channel?.readyState === 'open') channel.send(JSON.stringify({ type: 'chat', text: value }))
    else send(call.value.peerId, { type: 'assist-chat', text: value })
    appendMessage('me', value)
  }

  function toggleMic(): void {
    const tracks = localStream.value?.getAudioTracks() || []
    const audio = tracks[0] || null
    if (!audio) { ElMessage.info('当前没有麦克风轨道'); return }
    audio.enabled = !audio.enabled
    micEnabled.value = audio.enabled
  }

  function cleanup(): void {
    channel?.close()
    channel = null
    pc?.close()
    pc = null
    pendingCandidates = []
    for (const stream of [localStream.value, remoteStream.value]) {
      for (const track of stream?.getTracks() || []) { try { track.stop() } catch { /* 已停止 */ } }
    }
    localStream.value = null
    remoteStream.value = null
    screenActive.value = false
  }

  function end(notifyPeer = true): void {
    if (call.value && notifyPeer) send(call.value.peerId, { type: 'assist-hangup' })
    cleanup()
    call.value = null
    error.value = ''
    messages.value = []
    micEnabled.value = true
  }

  function dispose(): void {
    unsubscribe?.()
    unsubscribe = undefined
    initialized = false
    end(false)
  }

  return {
    call, dialogOpen, localStream, remoteStream, messages, error, micEnabled, screenActive,
    initialize, invite, accept, reject, retryShare, sendChat, toggleMic, end, dispose
  }
})
