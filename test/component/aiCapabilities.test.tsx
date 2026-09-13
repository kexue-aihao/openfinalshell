// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AiSettingsPanel } from '@/features/ai/AiSettingsPanel'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { AiImageCapabilityTestResult, AiProviderProfile, AiProviderProfileDraft } from '@shared/types'
import { deferred, fakeOfs } from './fakeOfs'

const profile: AiProviderProfile = {
  id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-flash', enabled: true, hasToken: true, createdAt: 1, updatedAt: 1
}
const result: AiImageCapabilityTestResult = {
  model: 'deepseek-v4-pro', image: 'yes', outcome: 'accepted', httpStatus: 200,
  message: '测试已接受图片请求。'
}
beforeEach(() => {
  fakeOfs.reset()
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, aiAssistantEnabled: true } })
  fakeOfs.handle('ai:profiles:list', () => [profile])
  fakeOfs.handle('ai:models:discover', () => ['deepseek-flash', 'deepseek-v4-pro'].map((id) => ({ id, name: id, input: { text: true, image: 'unknown' } })))
  fakeOfs.handle('ai:profiles:save', (draft) => ({ ...profile, ...draft as AiProviderProfileDraft }))
  fakeOfs.handle('ai:model:capabilityTest', () => result)
})
afterEach(cleanup)

describe('AI image declarations and explicit testing', () => {
  it('keeps the full model dropdown selectable and tests the selected unsaved model only on click', async () => {
    render(<AiSettingsPanel />)
    await screen.findByDisplayValue('deepseek-flash')
    expect(screen.queryByText('能力未知')).toBeNull()
    expect(screen.getByText('图片未声明')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '获取模型' }))
    const picker = await screen.findByRole('combobox', { name: '模型' })
    fireEvent.mouseDown(picker)
    await waitFor(() => expect(picker.getAttribute('aria-expanded')).toBe('true'))
    const menu = within(document.querySelector('.ant-select-dropdown')! as HTMLElement)
    expect(menu.getAllByText('图片未声明')).toHaveLength(2)
    expect(menu.getByTitle('deepseek-flash')).toBeTruthy()
    fireEvent.click(menu.getByTitle('deepseek-v4-pro'))
    expect(fakeOfs.invokes.some((call) => call.channel === 'ai:model:capabilityTest')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '测试图片输入' }))
    await screen.findByText(result.message)
    expect(fakeOfs.invokes).toContainEqual({
      channel: 'ai:model:capabilityTest', payload: { profileId: profile.id, baseUrl: profile.baseUrl, token: undefined, model: result.model }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
    await waitFor(() => expect(fakeOfs.invokes).toContainEqual({
      channel: 'ai:profiles:save', payload: expect.objectContaining({ model: result.model })
    }))
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://gateway.example/v1' } })
    expect(screen.queryByText(result.message)).toBeNull()
    expect(screen.queryByText('图片请求通过')).toBeNull()
  })

  it('discards a late test when the current model changes', async () => {
    const pending = deferred<AiImageCapabilityTestResult>()
    fakeOfs.handle('ai:model:capabilityTest', () => pending.promise)
    render(<AiSettingsPanel />)
    const picker = await screen.findByDisplayValue('deepseek-flash')
    fireEvent.click(screen.getByRole('button', { name: '测试图片输入' }))
    await waitFor(() => expect(fakeOfs.invokes.some((call) => call.channel === 'ai:model:capabilityTest')).toBe(true))
    fireEvent.change(picker, { target: { value: 'other-model' } })
    await act(async () => { pending.resolve({ ...result, model: profile.model }) })
    expect(screen.queryByText(result.message)).toBeNull()
    expect(screen.getByText('图片未声明')).toBeTruthy()
  })

  it('does not attach late model listings to an edited endpoint', async () => {
    const pending = deferred<unknown[]>()
    fakeOfs.handle('ai:models:discover', () => pending.promise)
    render(<AiSettingsPanel />)
    await screen.findByDisplayValue('deepseek-flash')
    fireEvent.click(screen.getByRole('button', { name: '获取模型' }))
    await waitFor(() => expect(fakeOfs.invokes.some((call) => call.channel === 'ai:models:discover')).toBe(true))
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://gateway.example/v1' } })
    await act(async () => { pending.resolve([{ id: 'wrong-route', name: 'Wrong route', input: { text: true, image: 'yes' } }]) })
    expect(screen.queryByRole('combobox', { name: '模型' })).toBeNull()
    expect(screen.getByText('图片未声明')).toBeTruthy()
  })
})
