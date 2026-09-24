import type { ShellHelperApi } from './index'

declare global {
  interface Window {
    shellHelper: ShellHelperApi
  }
}

export {}
