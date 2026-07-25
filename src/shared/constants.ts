/** 三层共享常量。禁止运行时依赖。 */
import type { AppSettings } from './types'

export const APP_NAME = 'OpenFinalShell'

/** 8 色预置：连接标签色 & UI 强调色 */
export const PRESET_COLORS = [
  '#1677ff', // 蓝（默认强调色）
  '#13c2c2', // 青
  '#52c41a', // 绿
  '#faad14', // 黄
  '#fa8c16', // 橙
  '#f5222d', // 红
  '#eb2f96', // 粉
  '#722ed1' // 紫
] as const

/** 终端下行批处理与背压水位（计划 4.2） */
export const TERM_FLUSH_INTERVAL_MS = 8
export const TERM_FLUSH_MAX_BYTES = 256 * 1024
export const TERM_FLOW_PAUSE_BYTES = 2 * 1024 * 1024
export const TERM_FLOW_RESUME_BYTES = 512 * 1024

/** 传输进度节流 */
export const TRANSFER_PROGRESS_INTERVAL_MS = 200

/** 监控采集 */
export const MONITOR_DEFAULT_INTERVAL_MS = 2000
export const MONITOR_MIN_INTERVAL_MS = 1000
export const MONITOR_MAX_INTERVAL_MS = 10000
/** df 每 N tick 采一次 */
export const MONITOR_DF_EVERY_N_TICKS = 5
/** 帧超时：写入批次后超过该时长未见 END 即丢帧 */
export const MONITOR_FRAME_TIMEOUT_MS = 5000

export const DEFAULT_TERMINAL_FONT_FAMILY =
  '"Maple Mono NF CN", "Cascadia Mono", Consolas, "Microsoft YaHei Mono", "Microsoft YaHei", monospace'

export const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  language: 'zh-CN',
  themeMode: 'dark',
  accent: PRESET_COLORS[0],
  uiZoom: 100,
  disableGpu: false,
  confirmOnCloseTab: true,
  restoreTabsOnLaunch: false,
  terminal: {
    fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
    fontSize: 14,
    lineHeight: 1.2,
    cursorStyle: 'bar',
    cursorBlink: true,
    scrollback: 5000,
    copyOnSelect: true,
    rightClick: 'paste',
    confirmMultilinePaste: true,
    themeId: 'auto',
    webgl: true
  },
  sftp: {
    downloadDir: '',
    maxConcurrentPerSession: 2,
    maxConcurrentGlobal: 4,
    conflictPolicy: 'ask',
    showHiddenFiles: false,
    doubleClickAction: 'download'
  },
  monitor: {
    intervalMs: MONITOR_DEFAULT_INTERVAL_MS
  },
  layout: {
    sidePanelSizePct: 18,
    sidePanelCollapsed: false,
    activeSidebar: 'connections',
    monitorPanelSizePct: 22,
    monitorPanelCollapsed: false,
    sftpPaneOpen: false,
    sftpPaneHeightPct: 40
  },
  window: {
    width: 1280,
    height: 800,
    maximized: false
  }
}
