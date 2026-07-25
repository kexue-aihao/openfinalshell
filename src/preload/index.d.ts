import type { OfsApi } from '../shared/ipc'

declare global {
  interface Window {
    ofs: OfsApi
  }
}

export {}
