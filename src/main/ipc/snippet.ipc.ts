import { z } from 'zod'
import { handle } from './registry'
import {
  deleteSnippet,
  deleteSnippetGroup,
  listSnippets,
  saveSnippet,
  saveSnippetGroup
} from '../store/snippets'

const snippetSchema = z.object({
  id: z.string(),
  groupId: z.string(),
  name: z.string().min(1).max(120),
  command: z.string().max(65536),
  autoEnter: z.boolean(),
  order: z.number()
})

const groupSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  order: z.number()
})

export function registerSnippetIpc(): void {
  handle('snippet:list', () => listSnippets())
  handle('snippet:save', (s) => saveSnippet(s), z.tuple([snippetSchema]))
  handle('snippet:delete', (id) => deleteSnippet(id), z.tuple([z.string()]))
  handle('snippetGroup:save', (g) => saveSnippetGroup(g), z.tuple([groupSchema]))
  handle('snippetGroup:delete', (id) => deleteSnippetGroup(id), z.tuple([z.string()]))
}
