#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, realpath, lstat, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_SOURCE = path.resolve(HERE, '..')
const DEFAULT_TARGET = path.join(os.homedir(), '.pi', 'agent')
const MANIFEST = '.pi-agent-managed.json'
const BACKUPS = '.pi-agent-backups'
const URL_PLACEHOLDER = '${PI_LLAMA_CPP_URL}'
const CONFIG_FILES = new Set(['settings.json', 'mcp.json', 'models.json'])
const REQUIRED_FILES = [
  'settings.json',
  'mcp.json',
  'APPEND_SYSTEM.md',
  'AGENTS.md',
  'README.md',
  'package.json',
  'package-lock.json',
  'setup.sh',
  'models.json.template',
  'scripts/setup.mjs',
]
const SYNC_DIRS = ['agents', 'skills', 'extensions', 'prompts', 'themes', 'scripts', 'tests']
const EXCLUDED = new Set(['extensions/herdr-agent-state.ts'])
const NEVER_DELETE = new Set(['extensions/herdr-agent-state.ts', 'auth.json', 'trust.json'])

const usage = () => `Usage: setup.sh [--dry-run] [--target PATH]\n       node scripts/setup.mjs [--dry-run] [--source PATH] [--target PATH]`

function parseArgs(argv) {
  const options = { dryRun: false, source: DEFAULT_SOURCE, target: DEFAULT_TARGET }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--source' || arg === '--target') {
      const value = argv[++index]
      if (!value) throw new Error(`${arg} requires a path\n${usage()}`)
      options[arg.slice(2)] = path.resolve(value)
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage())
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`)
    }
  }
  return options
}

function isAbsoluteReference(value) {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^file:\/\//i.test(value)
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function isSamePath(left, right) {
  return path.resolve(left) === path.resolve(right)
}

async function requiredRegularFile(root, relative) {
  const filename = path.join(root, relative)
  let info
  try {
    info = await lstat(filename)
  } catch {
    throw new Error(`Required source file is missing: ${relative}`)
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Required source file is not a regular file: ${relative}`)
  }
  return filename
}

async function sourceTree(root, relative, warnings, skippedPaths) {
  const directory = path.join(root, relative)
  let info
  try {
    info = await lstat(directory)
  } catch {
    throw new Error(`Required source directory is missing: ${relative}`)
  }
  if (info.isSymbolicLink()) {
    warnings.push(`Skipping external source symlink: ${relative}`)
    skippedPaths.add(relative)
    return []
  }
  if (!info.isDirectory()) throw new Error(`Required source path is not a directory: ${relative}`)

  const files = []
  async function visit(current, currentRelative) {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const relativePath = path.posix.join(currentRelative, entry.name)
      if (EXCLUDED.has(relativePath) || relativePath.endsWith('.disabled')) continue
      const fullPath = path.join(root, relativePath)
      if (entry.isSymbolicLink()) {
        warnings.push(`Skipping external source symlink: ${relativePath}`)
        skippedPaths.add(relativePath)
      } else if (entry.isDirectory()) {
        await visit(fullPath, relativePath)
      } else if (entry.isFile()) {
        files.push(relativePath)
      } else {
        warnings.push(`Skipping unsupported source entry: ${relativePath}`)
      }
    }
  }
  await visit(directory, relative)
  return files
}

function sanitizeSettings(settings) {
  const result = structuredClone(settings)
  delete result.lastChangelogVersion
  if (Array.isArray(result.packages)) {
    result.packages = result.packages.filter((item) => {
      const source = typeof item === 'string' ? item : item?.source
      if (typeof source !== 'string') return false
      // Local packages are installed/wired by their owner, not a portable default.
      return !isAbsoluteReference(source) && !source.startsWith('~/') && !source.startsWith('.')
    })
  }
  return result
}

function replacePlaceholder(value, url) {
  if (typeof value === 'string') return value.replaceAll(URL_PLACEHOLDER, url)
  if (Array.isArray(value)) return value.map((item) => replacePlaceholder(item, url))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replacePlaceholder(item, url)]))
  }
  return value
}

function validateUrl(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`PI_LLAMA_CPP_URL is not a valid URL: ${value}`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('PI_LLAMA_CPP_URL must be an http(s) URL')
  }
}

async function loadSource(source, warnings) {
  for (const relative of REQUIRED_FILES) await requiredRegularFile(source, relative)
  const discoveredFiles = [...REQUIRED_FILES]
  const skippedPaths = new Set()
  for (const directory of SYNC_DIRS) discoveredFiles.push(...await sourceTree(source, directory, warnings, skippedPaths))
  const sourceFiles = [...new Set(discoveredFiles)]

  const readJson = async (relative) => {
    try {
      return JSON.parse(await readFile(path.join(source, relative), 'utf8'))
    } catch (error) {
      throw new Error(`Invalid JSON in source ${relative}: ${error.message}`)
    }
  }
  const settings = sanitizeSettings(await readJson('settings.json'))
  const mcp = await readJson('mcp.json')
  await readJson('package.json')
  await readJson('package-lock.json')
  const template = await readJson('models.json.template')
  if (template.providers?.ollama) throw new Error('models.json.template must not contain an Ollama provider')
  if (!template.providers?.['llama-cpp']) throw new Error('models.json.template must contain a llama-cpp provider')

  const sourceContent = new Map()
  for (const relative of sourceFiles) {
    sourceContent.set(relative, relative === 'settings.json'
      ? Buffer.from(jsonText(settings))
      : relative === 'mcp.json'
        ? Buffer.from(jsonText(mcp))
        : await readFile(path.join(source, relative)))
  }
  return { sourceFiles, sourceContent, template, skippedPaths }
}

async function checkNodeAndNpm() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error(`Node.js >=22.19 is required; found ${process.version}`)
  }
  const npm = spawnSync('npm', ['--version'], { encoding: 'utf8', stdio: 'pipe' })
  if (npm.error || npm.status !== 0) throw new Error('npm is required before setup can write files')
}

async function assertSafeRoot(root) {
  try {
    const info = await lstat(root)
    if (info.isSymbolicLink()) throw new Error(`Refusing symlink in target path: ${root}`)
    if (!info.isDirectory()) throw new Error(`Target path is not a directory: ${root}`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

async function assertSafeTargetPath(target, relative) {
  await assertSafeRoot(target)
  const parts = relative.split('/').filter(Boolean)
  let current = target
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index])
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new Error(`Refusing symlink in managed target path: ${relative}`)
      if (index < parts.length - 1 && !info.isDirectory()) {
        throw new Error(`Managed target parent is not a directory: ${relative}`)
      }
    } catch (error) {
      if (error.code === 'ENOENT') break
      throw error
    }
  }
}

async function targetInfo(target, relative) {
  try {
    const info = await lstat(path.join(target, relative))
    if (info.isSymbolicLink()) throw new Error(`Refusing symlink in managed target path: ${relative}`)
    return info
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function validateManifest(value) {
  if (!value || value.version !== 1 || !value.files || typeof value.files !== 'object') {
    throw new Error(`Invalid ${MANIFEST}`)
  }
  const files = {}
  for (const [relative, digest] of Object.entries(value.files)) {
    const normalized = path.posix.normalize(relative)
    if (!relative || normalized !== relative || relative.startsWith('../') || relative.includes('/../') || path.isAbsolute(relative)) {
      throw new Error(`Invalid managed path in ${MANIFEST}: ${relative}`)
    }
    const managed = REQUIRED_FILES.includes(relative) || relative === 'models.json'
      || SYNC_DIRS.some(directory => relative.startsWith(`${directory}/`))
    if (!managed || relative === MANIFEST || relative === BACKUPS || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error(`Invalid managed entry in ${MANIFEST}: ${relative}`)
    }
    files[relative] = digest
  }
  return files
}

async function readManifest(target) {
  const info = await targetInfo(target, MANIFEST)
  if (!info) return {}
  try {
    return validateManifest(JSON.parse(await readFile(path.join(target, MANIFEST), 'utf8')))
  } catch (error) {
    throw new Error(`Cannot read ${MANIFEST}: ${error.message}`)
  }
}

async function writeTargetFile(target, relative, content, mode = 0o644) {
  const filename = path.join(target, relative)
  await mkdir(path.dirname(filename), { recursive: true })
  const existing = await targetInfo(target, relative)
  const permissions = relative === 'models.json' ? 0o600 : existing ? existing.mode & 0o777 : mode
  await writeFile(filename, content, { mode: permissions })
  await chmod(filename, permissions)
}

async function backupTargetFile(target, relative, warnings) {
  const stamp = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`
  const backupRelative = `${BACKUPS}/${stamp}/${relative}`
  await assertSafeTargetPath(target, backupRelative)
  const source = path.join(target, relative)
  const destination = path.join(target, backupRelative)
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
  await writeFile(destination, await readFile(source), { mode: 0o600 })
  warnings.push(`Backed up ${relative} to ${backupRelative}`)
}

async function run() {
  const options = parseArgs(process.argv.slice(2))
  const warnings = []
  const source = await realpath(options.source)
  await assertSafeRoot(options.target)
  const target = await realpath(options.target).catch(error => {
    if (error.code !== 'ENOENT') throw error
    return path.resolve(options.target)
  })
  const sourceData = await loadSource(source, warnings)
  const skipped = relative => [...sourceData.skippedPaths].some(entry => relative === entry || relative.startsWith(`${entry}/`))
  const prior = await readManifest(target)
  const sameLocation = isSamePath(source, target)
  const llamaUrl = process.env.PI_LLAMA_CPP_URL || ''
  if (llamaUrl) validateUrl(llamaUrl)

  let generatedLlama = null
  if (llamaUrl) {
    generatedLlama = replacePlaceholder(sourceData.template, llamaUrl)
    if (generatedLlama.providers?.ollama) throw new Error('Generated models contain an Ollama provider')
  }

  const allManagedPaths = new Set([...sourceData.sourceFiles, ...Object.keys(prior), MANIFEST])
  for (const relative of allManagedPaths) await assertSafeTargetPath(target, relative)
  await assertSafeTargetPath(target, 'models.json')

  const existingModels = await targetInfo(target, 'models.json')
  let modelContent = null
  let modelChanged = false
  if (llamaUrl) {
    let current = { providers: {} }
    if (existingModels) {
      try {
        current = JSON.parse(await readFile(path.join(target, 'models.json'), 'utf8'))
      } catch (error) {
        throw new Error(`Cannot update target models.json: ${error.message}`)
      }
      if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('Target models.json must contain an object')
      if (current.providers !== undefined && (!current.providers || typeof current.providers !== 'object' || Array.isArray(current.providers))) {
        throw new Error('Target models.json providers must contain an object')
      }
    }
    modelContent = structuredClone(current)
    modelContent.providers = { ...(current.providers || {}), 'llama-cpp': generatedLlama.providers['llama-cpp'] }
    const next = Buffer.from(jsonText(modelContent))
    const currentBytes = existingModels ? await readFile(path.join(target, 'models.json')) : null
    modelChanged = !currentBytes || !currentBytes.equals(next)
    modelContent = next
  } else if (!existingModels) {
    modelContent = Buffer.from(jsonText({ providers: {} }))
    modelChanged = true
  }

  await checkNodeAndNpm()
  console.log(`Setting up pi-agent configuration\n  Source: ${source}\n  Target: ${target}`)
  if (options.dryRun) {
    if (!sameLocation) {
      for (const relative of Object.keys(prior)) {
        if (sourceData.sourceFiles.includes(relative) || skipped(relative) || relative === 'models.json' || NEVER_DELETE.has(relative) || relative.startsWith('sessions/')) continue
        const info = await targetInfo(target, relative)
        if (!info) continue
        const current = await readFile(path.join(target, relative))
        console.log(`  ${sha256(current) === prior[relative] ? 'would prune' : 'would keep modified obsolete'} ${relative}`)
      }
      for (const relative of sourceData.sourceFiles) {
        const info = await targetInfo(target, relative)
        if (CONFIG_FILES.has(relative) && info) {
          console.log(`  preserve ${relative}`)
          continue
        }
        const content = sourceData.sourceContent.get(relative)
        const current = info ? await readFile(path.join(target, relative)) : null
        if (current?.equals(content)) console.log(`  unchanged ${relative}`)
        else if (info && !prior[relative]) console.log(`  preserve conflicting unowned file ${relative}`)
        else console.log(`  would ${info ? 'update' : 'copy'} ${relative}${info ? ' (with backup)' : ''}`)
      }
      console.log('  would write ownership manifest')
    } else {
      console.log('  source and target are identical; no file sync or pruning')
    }
    if (modelChanged) console.log(`  would ${existingModels ? 'update' : 'create'} models.json${existingModels && llamaUrl ? ' (with backup)' : ''}`)
    else console.log('  preserve models.json')
    console.log('  would run npm ci --ignore-scripts')
    for (const warning of warnings) console.log(`  ⚠️  ${warning}`)
    return
  }

  await assertSafeRoot(target)
  await mkdir(target, { recursive: true })
  const nextManaged = { ...prior }

  if (!sameLocation) {
    for (const relative of Object.keys(prior)) {
      if (sourceData.sourceFiles.includes(relative) || skipped(relative) || relative === 'models.json' || NEVER_DELETE.has(relative) || relative.startsWith('sessions/')) continue
      const info = await targetInfo(target, relative)
      if (!info) {
        delete nextManaged[relative]
        continue
      }
      const current = await readFile(path.join(target, relative))
      if (sha256(current) === prior[relative]) {
        await unlink(path.join(target, relative))
        delete nextManaged[relative]
        console.log(`  pruned obsolete ${relative}`)
      } else {
        delete nextManaged[relative]
        warnings.push(`Keeping modified obsolete managed file: ${relative}`)
      }
    }

    for (const relative of sourceData.sourceFiles) {
      const info = await targetInfo(target, relative)
      if (CONFIG_FILES.has(relative) && info) {
        if (prior[relative]) nextManaged[relative] = prior[relative]
        console.log(`  preserved ${relative}`)
        continue
      }
      const content = sourceData.sourceContent.get(relative)
      const current = info ? await readFile(path.join(target, relative)) : null
      if (!current || !current.equals(content)) {
        if (info && !prior[relative]) {
          warnings.push(`Preserving conflicting unowned file: ${relative}`)
          continue
        }
        if (info) await backupTargetFile(target, relative, warnings)
        const sourceMode = (await lstat(path.join(source, relative))).mode & 0o777
        await writeTargetFile(target, relative, content, sourceMode || 0o644)
        console.log(`  ${info ? 'updated' : 'copied'} ${relative}`)
      }
      nextManaged[relative] = sha256(content)
    }
  }

  if (modelChanged) {
    if (existingModels && llamaUrl) await backupTargetFile(target, 'models.json', warnings)
    await writeTargetFile(target, 'models.json', modelContent, 0o600)
    console.log(`  ${existingModels ? 'updated' : 'created'} models.json`)
    if (!sameLocation) nextManaged['models.json'] = sha256(modelContent)
  } else if (existingModels) {
    console.log('  preserved models.json')
    if (!sameLocation && prior['models.json']) nextManaged['models.json'] = prior['models.json']
  } else if (!sameLocation) {
    nextManaged['models.json'] = sha256(modelContent)
  }

  if (!sameLocation) {
    await writeTargetFile(target, MANIFEST, Buffer.from(jsonText({ version: 1, files: nextManaged })))
    console.log(`  wrote ${MANIFEST}`)
  }

  const npmArgs = ['ci', '--prefix', target, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']
  console.log(`  running npm ${npmArgs.join(' ')}`)
  const npm = spawnSync('npm', npmArgs, { stdio: 'inherit' })
  if (npm.error || npm.status !== 0) throw new Error(`npm ci failed${npm.status === null ? '' : ` with exit code ${npm.status}`}`)
  for (const warning of warnings) console.log(`  ⚠️  ${warning}`)
  console.log('Done. Restart pi for changes to take effect.')
}

run().catch((error) => {
  console.error(`❌ ${error.message}`)
  process.exitCode = 1
})
