import axios, { type AxiosInstance } from 'axios'

interface Conn {
  baseUrl: string
  wsUrl: string
  token: string
}

let conn: Conn | null = null
let http: AxiosInstance | null = null
let initPromise: Promise<Conn> | null = null

/**
 * 浏览器预览兑底(仅 dev):无 Electron preload 时从 URL 参数取后端地址,
 * 便于在浏览器中跑真实后端联调 UI。生产/Electron 环境不会命中。
 */
function readBrowserDevConn(): Conn | null {
  if (!import.meta.env.DEV || window.shellHelper) return null
  const p = new URLSearchParams(window.location.search)
  const base = p.get('backend')
  if (!base) return null
  const u = new URL(base)
  return {
    baseUrl: base.replace(/\/$/, ''),
    wsUrl: `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}`,
    token: p.get('token') ?? ''
  }
}

/** 加载(并缓存)后端连接信息,首次会触发主进程拉起 Python 后端 */
export async function ensureConn(): Promise<Conn> {
  if (conn) return conn
  const devConn = readBrowserDevConn()
  if (devConn) {
    conn = devConn
    return devConn
  }
  if (!initPromise) {
    initPromise = window.shellHelper
      .getBackendInfo()
      .then((info) => {
        conn = info
        return info
      })
      .catch((err) => {
        initPromise = null
        throw err
      })
  }
  return initPromise
}

export async function getHttp(): Promise<AxiosInstance> {
  const c = await ensureConn()
  if (!http) {
    http = axios.create({ baseURL: c.baseUrl, timeout: 30000 })
    http.interceptors.request.use((cfg) => {
      cfg.headers.Authorization = `Bearer ${c.token}`
      return cfg
    })
    // 后端错误统一为 {detail: "..."},提取为可读消息覆盖 axios 默认文案
    http.interceptors.response.use(
      (res) => res,
      (err) => {
        const detail = (err.response?.data as { detail?: unknown } | undefined)?.detail
        if (typeof detail === 'string' && detail) err.message = detail
        return Promise.reject(err)
      }
    )
  }
  return http
}

export function getWsUrl(path: string): string {
  if (!conn) throw new Error('连接尚未初始化')
  const url = conn.wsUrl + path
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}token=${encodeURIComponent(conn.token)}`
}
