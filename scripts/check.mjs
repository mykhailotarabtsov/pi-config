import { readdir, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
async function files(directory) {
  const result = []
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await files(relative))
    else if (entry.isFile()) result.push(relative)
  }
  return result
}
const resources = (await Promise.all(['extensions', 'themes', 'scripts', 'tests'].map(files))).flat()
const jsonFiles = ['settings.json', 'mcp.json', 'models.json.template', 'package.json', 'package-lock.json', ...resources.filter(file => file.endsWith('.json'))]
for (const file of jsonFiles) {
  try { JSON.parse(await readFile(path.join(root, file), 'utf8')) }
  catch (error) { throw new Error(`${file}: ${error.message}`) }
}
const sources = resources.filter(file => /\.(ts|mjs)$/.test(file))
for (const file of sources) {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--check', path.join(root, file)], { encoding: 'utf8' })
  if (result.error || result.status !== 0) throw new Error(`${file}: ${result.error?.message || result.stderr}`)
}
const shell = spawnSync('bash', ['-n', path.join(root, 'setup.sh')], { encoding: 'utf8' })
if (shell.error || shell.status !== 0) throw new Error(shell.error?.message || shell.stderr)
console.log(`Validated ${jsonFiles.length} JSON files, parsed ${sources.length} JS/TS files, and checked setup.sh (syntax, not TypeScript typechecking).`)
