import { existsSync, mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'

/** 旧版后端默认目录。Electron 以前没有把数据目录传给后端，数据库和日志会落在这里。 */
export function legacyDataDirectory(options: {
  home: string
  platform: string
  appData?: string
  xdgDataHome?: string
}): string {
  if (options.platform === 'win32') {
    return path.join(options.appData || path.join(options.home, 'AppData', 'Roaming'), 'shell-helper')
  }
  if (options.platform === 'darwin') {
    return path.join(options.home, 'Library', 'Application Support', 'shell-helper')
  }
  return path.join(options.xdgDataHome || path.join(options.home, '.local', 'share'), 'shell-helper')
}

function moveIfAbsent(from: string, to: string): void {
  if (!existsSync(from) || existsSync(to)) return
  mkdirSync(path.dirname(to), { recursive: true })
  renameSync(from, to)
}

/** 把旧目录里的数据库、密钥和日志挪进应用数据文件夹。目标已存在时保留目标，不覆盖。 */
export function adoptLegacyDirectory(legacy: string, userData: string, home = ''): void {
  if (!legacy || !userData) return
  if (home && !path.resolve(userData).startsWith(path.resolve(home) + path.sep)) return
  if (path.resolve(legacy) === path.resolve(userData)) return
  if (!existsSync(legacy)) return
  mkdirSync(userData, { recursive: true })
  const database = 'shell-helper.db'
  if (existsSync(path.join(legacy, database)) && !existsSync(path.join(userData, database))) {
    moveIfAbsent(path.join(legacy, database), path.join(userData, database))
    moveIfAbsent(path.join(legacy, `${database}-wal`), path.join(userData, `${database}-wal`))
    moveIfAbsent(path.join(legacy, `${database}-shm`), path.join(userData, `${database}-shm`))
    moveIfAbsent(path.join(legacy, '.master.key'), path.join(userData, '.master.key'))
  }
  moveIfAbsent(path.join(legacy, 'logs'), path.join(userData, 'logs'))
}
