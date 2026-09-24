import path from 'node:path'
import { stat } from 'node:fs/promises'
import type { BackendInfo } from './backend'
import type { StorageLocation, StorageLocationId, StorageLocations } from '../shared/settings'

interface StorageDependencies {
  userData: string
  backend(): Promise<BackendInfo>
  openPath(directory: string): Promise<string>
  copyText(text: string): void
}

const validPath = (value: unknown): value is string => typeof value === 'string' && path.isAbsolute(value) && !/[\x00-\x1f]/.test(value)

/** 仅允许查看应用已知的存储位置，不接受来自渲染层的任意路径。 */
export class StorageService {
  constructor(private readonly deps: StorageDependencies) {}

  async read(): Promise<StorageLocations> {
    const locations: StorageLocation[] = [
      { id: 'drafts', path: path.join(this.deps.userData, 'drafts') },
      { id: 'database', path: null, unavailable: '暂时无法获取数据库位置' },
      { id: 'settings', path: path.join(this.deps.userData, 'settings.json') },
      { id: 'logs', path: null, unavailable: '暂时无法获取日志位置' }
    ]
    try {
      const info = await this.deps.backend()
      if (validPath(info.databasePath)) locations[1].path = info.databasePath
      else if (info.databasePath === null) locations[1].unavailable = '当前数据库不使用本地文件'
      if (validPath(info.dataDir)) locations[3].path = path.join(info.dataDir, 'logs')
      const incomplete = (info.databasePath !== null && !locations[1].path) || !locations[3].path
      return { locations, warning: incomplete ? '后端未提供完整存储位置，请重启应用后重试。' : undefined }
    } catch {
      return { locations, warning: '后端暂不可用，仍可查看本地草稿和设置；数据库与日志位置可稍后重试。' }
    }
  }

  private async location(id: StorageLocationId): Promise<StorageLocation> {
    if (!['drafts', 'database', 'settings', 'logs'].includes(id)) throw new Error('不允许的存储位置')
    // 本地副本与设置的访问不依赖后端可用性。
    if (id === 'drafts' || id === 'settings') return { id, path: path.join(this.deps.userData, id === 'drafts' ? 'drafts' : 'settings.json') }
    const item = (await this.read()).locations.find(item => item.id === id)!
    if (!item.path) throw new Error(item.unavailable || '无法获取存储位置')
    return item
  }

  async open(id: StorageLocationId): Promise<void> {
    const item = await this.location(id)
    const directory = id === 'settings' || id === 'database' ? path.dirname(item.path!) : item.path!
    if (!(await stat(directory)).isDirectory()) throw new Error('存储目录不存在')
    const error = await this.deps.openPath(directory)
    if (error) throw new Error(`无法打开目录：${error}`)
  }

  async copy(id: StorageLocationId): Promise<void> {
    const item = await this.location(id)
    this.deps.copyText(item.path!)
  }
}
