import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const sourcePath = join(root, 'src/renderer/src/features/onboarding/releaseNotes.ts')
const outputPath = join(root, 'windows/OpenFinalShell.Core/native-release-notes.json')
const source = await readFile(sourcePath, 'utf8')
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const temp = await mkdtemp(join(tmpdir(), 'openfinalshell-release-notes-'))
const modulePath = join(temp, 'release-notes.mjs')
try {
  await writeFile(modulePath, output, 'utf8')
  const module = await import(pathToFileURL(modulePath).href)
  if (!Array.isArray(module.RELEASE_NOTES) || module.RELEASE_NOTES.length === 0) {
    throw new Error('Electron release notes source did not produce a non-empty RELEASE_NOTES array')
  }
  await writeFile(outputPath, `${JSON.stringify(module.RELEASE_NOTES, null, 2)}\n`, 'utf8')
  console.log(`Generated ${module.RELEASE_NOTES.length} release-note versions at ${outputPath}`)
} finally {
  await rm(temp, { recursive: true, force: true })
}
