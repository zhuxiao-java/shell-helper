import { ElMessageBox } from 'element-plus'
import { acceptHostKey, type HostKeyChallenge } from '@renderer/api/hosts'

export function readHostKey(error: unknown): HostKeyChallenge | null {
  const challenge = (error as { hostKey?: HostKeyChallenge }).hostKey
  if (!challenge || (challenge.code !== 'unknown_host_key' && challenge.code !== 'host_key_changed')) return null
  return challenge
}

/** 遇到未知或已变化的主机密钥时先确认，信任后再执行一次。 */
export async function withHostKey<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    const challenge = readHostKey(error)
    if (!challenge) throw error
    const changed = challenge.code === 'host_key_changed'
    await ElMessageBox.confirm(`${challenge.message}\n\n${challenge.key_type}\n${challenge.fingerprint}`, changed ? '主机密钥已变化' : '确认主机密钥', {
      confirmButtonText: changed ? '更新并继续' : '信任并继续',
      cancelButtonText: '取消',
      type: 'warning'
    })
    await acceptHostKey(challenge)
    return await run()
  }
}
