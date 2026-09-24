import { app, BrowserWindow, ipcMain, shell, dialog, clipboard, type IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import { backendManager } from './backend'
import { SettingsService } from './settings'
import { StorageService } from './storage'
import { ExternalEditService } from './external-edit'
import { launchEditor, validateEditor } from './editor'
import { validateSettings, type StorageLocationId } from '../shared/settings'
import type { OpenFileRequest } from '../shared/external'

let settings: SettingsService
let storage: StorageService
let edits: ExternalEditService
const approvedEditors = new Set<string>()
let exitAllowed = false
let exitChecking = false

function trusted(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('不允许的 IPC 来源')
}

function registerServices(): void {
  ipcMain.handle('storage:read', event => { trusted(event); return storage.read() })
  ipcMain.handle('storage:open', (event, id: StorageLocationId) => { trusted(event); return storage.open(id) })
  ipcMain.handle('storage:copy', (event, id: StorageLocationId) => { trusted(event); return storage.copy(id) })
  ipcMain.handle('settings:read', event => { trusted(event); return settings.get() })
  ipcMain.handle('settings:save', async (event, input: unknown) => {
    trusted(event)
    const value = validateSettings(input)
    if (value.editor.path && !approvedEditors.has(value.editor.path)) throw new Error('请通过系统选择器选择编辑器')
    if (value.editor.mode === 'custom') await validateEditor(value.editor.path)
    return settings.save(value)
  })
  ipcMain.handle('editor:choose', async event => {
    trusted(event)
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择文本编辑器', properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: '编辑器', extensions: ['exe'] }] : undefined
    })
    if (result.canceled || !result.filePaths[0]) return null
    const file = result.filePaths[0]
    await validateEditor(file)
    approvedEditors.add(file)
    return file
  })
  ipcMain.handle('edits:list', event => { trusted(event); return edits.refresh() })
  ipcMain.handle('edits:open', (event, input: OpenFileRequest) => { trusted(event); return edits.open(input) })
  ipcMain.handle('edits:reopen', (event, id: string, useDefault: boolean) => { trusted(event); return edits.reopen(id, useDefault === true) })
  ipcMain.handle('edits:upload', (event, id: string, hash: string) => { trusted(event); return edits.upload(id, hash) })
  ipcMain.handle('edits:detach', (event, sessionId: string) => { trusted(event); return edits.detach(sessionId) })
}

async function confirmExit(): Promise<void> {
  if (exitChecking) return
  exitChecking = true
  try {
    if (await edits.hasPending()) {
      const result = await dialog.showMessageBox(mainWindow!, {
        type: 'warning', title: '保留未回传的修改？',
        message: '仍有未回传修改或传输中的文件。退出后保留本地草稿，下次启动可恢复，不会自动上传。',
        buttons: ['取消退出', '保留草稿并退出'], defaultId: 0, cancelId: 0
      })
      if (result.response !== 1) return
    }
    await edits.stop()
    await backendManager.stop()
    exitAllowed = true
    app.quit()
  } catch (error) {
    dialog.showErrorBox('无法安全退出', (error as Error).message)
  } finally { exitChecking = false }
}

// 是否开发态(electron-vite 注入)
const isDev = !!process.env['ELECTRON_RENDERER_URL']

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'Shell Helper',
    // 浅色外壳背景,避免启动/缩放时白闪
    backgroundColor: '#EEEDE8',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', event => {
    if (!exitAllowed) { event.preventDefault(); void confirmExit() }
  })
  mainWindow.webContents.on('will-navigate', event => event.preventDefault())

  // 外链用系统浏览器打开,禁止窗口内导航
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']!)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// ---- IPC: 前端获取后端连接信息(baseUrl + token) ----
ipcMain.handle('backend:info', async () => {
  const info = await backendManager.start()
  return {
    baseUrl: `http://${info.host}:${info.port}`,
    wsUrl: `ws://${info.host}:${info.port}`,
    token: info.token
  }
})

ipcMain.handle('app:version', () => app.getVersion())

function bootstrap(): void {
  app.whenReady().then(async () => {
    storage = new StorageService({
      userData: app.getPath('userData'), backend: () => backendManager.start(),
      openPath: directory => shell.openPath(directory), copyText: text => clipboard.writeText(text)
    })
    settings = new SettingsService(path.join(app.getPath('userData'), 'settings.json'))
    await settings.load()
    if (settings.get().settings.editor.path) approvedEditors.add(settings.get().settings.editor.path)
    edits = new ExternalEditService(path.join(app.getPath('userData'), 'drafts'), {
      editor: () => settings.get().settings.editor,
      launch: launchEditor,
      changed: items => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('edits:changed', items) },
      request: async (route, init) => {
        const info = await backendManager.start()
        return fetch(`http://${info.host}:${info.port}${route}`, {
          ...init, headers: { ...init?.headers, Authorization: `Bearer ${info.token}` },
          signal: AbortSignal.timeout(120000), redirect: 'error'
        })
      }
    })
    await edits.initialize()
    registerServices()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  }).catch(error => {
    dialog.showErrorBox('启动失败', (error as Error).message)
    exitAllowed = true
    app.quit()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // 退出前优雅关闭后端
  app.on('before-quit', (e) => {
    if (exitAllowed) return
    e.preventDefault()
    if (edits) void confirmExit()
  })
}

bootstrap()
