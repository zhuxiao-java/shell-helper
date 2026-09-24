import { shell } from 'electron'
import { spawn } from 'node:child_process'
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import type { Settings } from '../shared/settings'

export async function validateEditor(file: string): Promise<void> {
  if (!path.isAbsolute(file) || /[\x00-\x1f]/.test(file)) throw new Error('编辑器路径无效')
  const info = await fs.stat(file)
  if (process.platform === 'darwin' && file.endsWith('.app') && info.isDirectory()) return
  if (!info.isFile()) throw new Error('请选择文本编辑器的可执行程序')
  if (process.platform === 'win32' && !/\.exe$/i.test(file)) throw new Error('请选择 .exe 编辑器，不支持脚本启动器')
  if (process.platform !== 'win32') await fs.access(file, constants.X_OK)
}

export async function launchEditor(file: string, editor: Settings['editor']): Promise<void> {
  if (editor.mode === 'default') {
    if (!file.endsWith('.txt')) throw new Error('默认应用只能打开安全的 .txt 副本')
    const error = await shell.openPath(file)
    if (error) throw new Error(error)
    return
  }
  await validateEditor(editor.path)
  const bundle = process.platform === 'darwin' && editor.path.endsWith('.app')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bundle ? '/usr/bin/open' : editor.path, bundle ? ['-a', editor.path, file] : [file], {
      shell: false, stdio: 'ignore', detached: !bundle
    })
    child.once('error', reject)
    if (bundle) child.once('exit', code => code === 0 ? resolve() : reject(new Error('编辑器启动失败')))
    else child.once('spawn', () => { child.unref(); resolve() })
  })
}
