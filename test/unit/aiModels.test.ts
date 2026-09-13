import { describe, expect, it } from 'vitest'
import { parseAiModels } from '../../src/main/services/aiModels'

describe('AI model input metadata', () => {
  it('keeps ID-only DeepSeek and OpenAI listings unknown regardless of model names', () => {
    const models = parseAiModels({ data: ['deepseek-flash', 'deepseek-v4-pro', 'gpt-4o', 'custom-vision'].map((id) => ({ id, owned_by: 'provider' })) })
    expect(models).toHaveLength(4)
    expect(models.every((model) => model.input.image === 'unknown' && !model.imageSource)).toBe(true)
  })

  it.each([
    [{ input: ['text', 'image'] }, 'yes'],
    [{ input_modalities: ['text'] }, 'no'],
    [{ architecture: { input_modalities: ['text', 'image'] } }, 'yes'],
    [{ modalities: { input: ['text'], output: ['image'] } }, 'no'],
    [{ capabilities: { modalities: { input: ['image'] } } }, 'yes'],
    [{ supports_image_input: false }, 'no'],
    [{ capabilities: { vision: true } }, 'yes'],
    [{ modalities: ['image'], output_modalities: ['image'] }, 'unknown'],
    [{ input: ['text', 42] }, 'unknown'],
    [{ input: ['not-a-modality'] }, 'unknown'],
    [{ vision: false, input: ['text', 'image'] }, 'unknown']
  ])('parses input-specific declarations without assuming output is input: %j', (fields, expected) => {
    expect(parseAiModels({ data: [{ id: 'model', ...fields }] })[0].input.image).toBe(expected)
  })

  it('uses callable route aliases, ignores directory metadata and preserves limits', () => {
    expect(parseAiModels({ models: { count: 2, alias: { id: 'canonical', context_length: 128000, max_output_tokens: 4096, input: ['image'] } } })).toEqual([
      expect.objectContaining({ id: 'alias', contextWindow: 128000, maxOutputTokens: 4096, imageSource: 'metadata', input: { text: true, image: 'yes' } })
    ])
    expect(parseAiModels({ data: [{ id: 'a' }, { id: 'a' }, null, [], { id: '' }], models: { other: {} } }).map((item) => item.id)).toEqual(['a'])
  })
})
