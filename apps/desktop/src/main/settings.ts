import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { defaults, validateSettings, type Settings, type SettingsResult } from '../shared/settings'

export async function atomicJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomUUID()}.tmp`
  const handle = await fs.open(temp, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync() }
  finally { await handle.close() }
  await fs.rename(temp, file)
}

export class SettingsService {
  private current = defaults()
  private warning?: string
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly file: string) {}
  async load(): Promise<void> {
    try {
      if ((await fs.stat(this.file)).size > 1024 * 1024) throw new Error('设置文件过大')
      this.current = validateSettings(JSON.parse(await fs.readFile(this.file, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.warning = '设置文件损坏，已恢复默认设置。原文件保留为备份。'
        await fs.rename(this.file, `${this.file}.damaged-${Date.now()}`).catch(() => undefined)
      }
      this.current = defaults()
      await atomicJson(this.file, this.current)
    }
  }
  get(): SettingsResult { return { settings: structuredClone(this.current), warning: this.warning } }
  async save(value: unknown): Promise<Settings> {
    const settings = validateSettings(value)
    const write = this.queue.then(async () => {
      await atomicJson(this.file, settings)
      this.current = settings
      this.warning = undefined
      return structuredClone(settings)
    })
    this.queue = write.catch(() => undefined)
    return write
  }
}
