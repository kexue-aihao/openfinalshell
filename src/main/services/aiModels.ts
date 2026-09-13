import type { AiImageCapability, AiModelInfo } from '@shared/types'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function numberField(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
}

/** Only input-specific modality declarations establish image input support. */
function imageCapability(row: Record<string, unknown>): AiImageCapability {
  const caps = record(row.capabilities)
  const architecture = record(row.architecture)
  const declared: boolean[] = []
  for (const fields of [row, caps]) {
    if (!fields) continue
    for (const key of ['vision', 'supports_vision', 'supports_image_input', 'image_input', 'image']) {
      if (typeof fields[key] === 'boolean') declared.push(fields[key] as boolean)
    }
  }
  const inputSets = [
    row.input_modalities, row.input, record(row.modalities)?.input,
    caps?.input_modalities, caps?.input, record(caps?.modalities)?.input,
    architecture?.input_modalities
  ]
  for (const input of inputSets) {
    if (!Array.isArray(input) || !input.length || !input.every((item) => typeof item === 'string')) continue
    const modalities = input.map((item: string) => item.toLowerCase())
    // Ignore malformed/unrecognized lists instead of treating them as a negative declaration.
    if (!modalities.every((item) => ['text', 'image', 'images', 'vision', 'audio', 'video', 'file'].includes(item))) continue
    declared.push(modalities.some((item) => ['image', 'images', 'vision'].includes(item)))
  }
  if (!declared.length || declared.some((value) => value !== declared[0])) return 'unknown'
  return declared[0] ? 'yes' : 'no'
}

function parseModel(value: unknown, routeId?: string): AiModelInfo | undefined {
  const row = record(value)
  if (!row) return undefined
  // Enriched maps may provide a canonical nested ID different from the callable route alias.
  const id = routeId?.trim() || (typeof row.id === 'string' ? row.id.trim() : '')
  if (!id || id.length > 200 || /[\u0000-\u001f]/.test(id)) return undefined
  const displayName = typeof row.name === 'string' ? row.name : typeof row.display_name === 'string' ? row.display_name : id
  const image = imageCapability(row)
  return {
    id, name: displayName.trim().slice(0, 300) || id,
    ...(typeof row.owned_by === 'string' ? { ownedBy: row.owned_by.slice(0, 200) } : {}),
    contextWindow: numberField(row.context_window, row.contextWindow, row.context_length, row.max_input_tokens),
    maxOutputTokens: numberField(row.max_output_tokens, row.maxOutputTokens, row.max_tokens, record(row.top_provider)?.max_completion_tokens),
    input: { text: true, image },
    ...(image !== 'unknown' ? { imageSource: 'metadata' as const } : {})
  }
}

/** /models may list IDs only. Never infer vision support from provider or model names. */
export function parseAiModels(payload: unknown): AiModelInfo[] {
  const root = record(payload)
  if (!root) return []
  const models: AiModelInfo[] = []
  const seen = new Set<string>()
  const entries: Array<[string | undefined, unknown]> = Array.isArray(root.data)
    ? root.data.map((entry) => [undefined, entry])
    : Object.entries(record(root.models) ?? {})
  for (const [id, entry] of entries) {
    const model = parseModel(entry, id)
    if (!model || seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
    if (models.length === 2000) break
  }
  return models
}
