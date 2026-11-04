// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App as AntdApp } from 'antd'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { ConnectionGroup, ConnectionProfile } from '@shared/types'
import { ConnectionTreePanel } from '@/features/connections/ConnectionTreePanel'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUiStore } from '@/stores/useUiStore'
import { fakeOfs } from './fakeOfs'
import '@/i18n'

const now = Date.now()

function profile(id: string, name: string, groupId: string | null = null): ConnectionProfile {
  return {
    id,
    name,
    groupId,
    host: `10.0.0.${id.slice(1)}`,
    port: 22,
    username: 'root',
    auth: { method: 'password' },
    terminal: { charset: 'utf-8', termType: 'xterm-256color' },
    options: {
      keepaliveInterval: 15000,
      readyTimeout: 15000,
      legacyAlgorithms: false,
      autoReconnect: false,
      monitorEnabled: false,
      compress: false
    },
    createdAt: now,
    updatedAt: now
  }
}

function visibleMenus(): Element[] {
  return [...document.querySelectorAll('[role="menu"][data-connection-context-menu="true"]')]
}

function nodeFor(label: HTMLElement): HTMLElement {
  // profile: node > nodeText > nodeName(label); group: node > nodeName(label)
  const node = label.parentElement?.parentElement?.classList.contains('node')
    ? label.parentElement.parentElement
    : label.parentElement
  if (!node) throw new Error(`node not found for ${label.textContent}`)
  return node
}

function renderPanel(profiles: ConnectionProfile[], groups: ConnectionGroup[] = []): void {
  useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS) })
  useUiStore.setState({ editingProfileId: null })
  useConnectionStore.setState({ profiles, groups, loaded: true, searchText: '' })
  render(
    <AntdApp>
      <ConnectionTreePanel />
    </AntdApp>
  )
}

afterEach(() => {
  cleanup()
  fakeOfs.reset()
})

it('keeps a single menu after rapid right-clicks and edits the last target', async () => {
  renderPanel([profile('p1', 'Server One'), profile('p2', 'Server Two'), profile('p3', 'Server Three')])

  const first = await screen.findByText('Server One')
  const second = screen.getByText('Server Two')
  const third = screen.getByText('Server Three')

  // Three contextmenu events in one batch model a slow renderer: the previous
  // per-node dropdowns could all mount before rc-trigger registered its
  // outside-close listener, leaving stacked menus behind.
  act(() => {
    for (const [index, node] of [nodeFor(first), nodeFor(second), nodeFor(third)].entries()) {
      node.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 40 + index * 4,
        clientY: 60 + index * 30
      }))
    }
  })

  await waitFor(() => expect(visibleMenus()).toHaveLength(1))
  const menu = visibleMenus()[0] as HTMLElement
  expect(menu.style.left).toBe('48px')
  expect(menu.style.top).toBe('120px')
  fireEvent.click(screen.getByRole('menuitem', { name: '编辑' }))
  await waitFor(() => expect(useUiStore.getState().editingProfileId).toBe('p3'))
})

it('opens the group actions from the same single menu', async () => {
  renderPanel([profile('p1', 'Server One', 'g1')], [
    { id: 'g1', name: 'Production', parentId: null, order: 1 }
  ])

  const groupLabel = await screen.findByText('Production')
  fireEvent.contextMenu(nodeFor(groupLabel), { clientX: 30, clientY: 50 })

  await waitFor(() => expect(visibleMenus()).toHaveLength(1))
  fireEvent.click(screen.getByRole('menuitem', { name: '新建连接' }))
  await waitFor(() => expect(useUiStore.getState().editingProfileId).toBe('new'))
})

it('keeps the menu inside the viewport and supports keyboard navigation', async () => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  const originalWidth = window.innerWidth
  const originalHeight = window.innerHeight
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 400 })
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.getAttribute('role') === 'menu') return { x: 0, y: 0, left: 0, top: 0, right: 180, bottom: 160, width: 180, height: 160, toJSON: () => ({}) }
    return originalRect.call(this)
  }
  try {
    renderPanel([profile('p1', 'Server One')])
    fireEvent.contextMenu(nodeFor(await screen.findByText('Server One')), { clientX: 390, clientY: 390 })
    const menu = await screen.findByRole('menu')
    await waitFor(() => {
      expect((menu as HTMLElement).style.left).toBe('212px')
      expect((menu as HTMLElement).style.top).toBe('232px')
    })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '连接' }))
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    fireEvent.keyDown(menu, { key: 'Enter' })
    await waitFor(() => expect(useUiStore.getState().editingProfileId).toBe('p1'))
  } finally {
    HTMLElement.prototype.getBoundingClientRect = originalRect
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalHeight })
  }
})

it.each([
  ['top-left', 10, 10, '10px', '10px'],
  ['top-right', 390, 10, '212px', '10px'],
  ['bottom-left', 10, 390, '10px', '232px']
] as const)('clamps a menu opened from the %s corner', async (_corner, clientX, clientY, expectedLeft, expectedTop) => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  const originalWidth = window.innerWidth
  const originalHeight = window.innerHeight
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 400 })
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.getAttribute('role') === 'menu') return { x: 0, y: 0, left: 0, top: 0, right: 180, bottom: 160, width: 180, height: 160, toJSON: () => ({}) }
    return originalRect.call(this)
  }
  try {
    renderPanel([profile('p1', 'Server One')])
    fireEvent.contextMenu(nodeFor(await screen.findByText('Server One')), { clientX, clientY })
    const menu = await screen.findByRole('menu')
    await waitFor(() => {
      expect((menu as HTMLElement).style.left).toBe(expectedLeft)
      expect((menu as HTMLElement).style.top).toBe(expectedTop)
    })
  } finally {
    HTMLElement.prototype.getBoundingClientRect = originalRect
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalHeight })
  }
})

it('closes when the user clicks outside the body-mounted menu', async () => {
  renderPanel([profile('p1', 'Server One')])
  fireEvent.contextMenu(nodeFor(await screen.findByText('Server One')), { clientX: 80, clientY: 80 })
  await screen.findByRole('menu')
  fireEvent.pointerDown(document.body)
  await waitFor(() => expect(visibleMenus()).toHaveLength(0))
})

it.each(['Escape', 'blur', 'resize', 'tree-scroll'] as const)('closes the menu on %s', async (reason) => {
  renderPanel([profile('p1', 'Server One')])
  fireEvent.contextMenu(nodeFor(await screen.findByText('Server One')), { clientX: 80, clientY: 80 })
  await screen.findByRole('menu')
  if (reason === 'Escape') fireEvent.keyDown(window, { key: 'Escape' })
  else if (reason === 'blur') fireEvent.blur(window)
  else if (reason === 'resize') fireEvent.resize(window)
  else fireEvent.scroll(document.querySelector('[class*="tree"]')!)
  await waitFor(() => expect(visibleMenus()).toHaveLength(0))
})
