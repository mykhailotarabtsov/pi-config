import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Pi extensions import the host packages by alias. The config repository does
// not depend on those packages, so resolve the aliases from the installed Pi
// runtime without adding test dependencies or network access.
const HOST_ALIASES = new Set([
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-ai/compat',
  '@earendil-works/pi-ai/oauth',
  '@earendil-works/pi-ai/providers/all',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-tui',
  'typebox',
  'typebox/compile',
  'typebox/value',
])

function resolutionRoots() {
  const roots = []
  if (process.env.PI_PACKAGE_DIR) roots.push(process.env.PI_PACKAGE_DIR)
  const globalRoot = path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules')
  roots.push(globalRoot)
  // The published Pi package keeps its aliased runtime packages and YAML
  // parser in its own node_modules rather than at the global root.
  roots.push(path.join(globalRoot, '@earendil-works', 'pi-coding-agent'))
  return [...new Set(roots)]
}

function resolveHostPackage(specifier) {
  const roots = resolutionRoots()
  const directEntries = {
    '@earendil-works/pi-coding-agent': 'dist/index.js',
    '@earendil-works/pi-agent-core': 'node_modules/@earendil-works/pi-agent-core/dist/index.js',
    '@earendil-works/pi-ai': 'node_modules/@earendil-works/pi-ai/dist/compat.js',
    '@earendil-works/pi-ai/compat': 'node_modules/@earendil-works/pi-ai/dist/compat.js',
    '@earendil-works/pi-ai/oauth': 'node_modules/@earendil-works/pi-ai/dist/oauth.js',
    '@earendil-works/pi-ai/providers/all': 'node_modules/@earendil-works/pi-ai/dist/providers/all.js',
    '@earendil-works/pi-tui': 'node_modules/@earendil-works/pi-tui/dist/index.js',
    typebox: 'node_modules/typebox/build/index.mjs',
    'typebox/compile': 'node_modules/typebox/build/compile/index.mjs',
    'typebox/value': 'node_modules/typebox/build/value/index.mjs',
  }
  const entry = directEntries[specifier]
  for (const root of roots) {
    const candidate = entry && path.join(root, entry)
    if (candidate && existsSync(candidate)) return candidate
  }

  const resolvers = [createRequire(import.meta.url)]
  for (const root of roots) {
    // A root may be either the global node_modules directory or the Pi package
    // itself. createRequire handles both package layouts and package exports.
    resolvers.push(createRequire(path.join(root, 'package.json')))
  }
  for (const resolver of resolvers) {
    try {
      return resolver.resolve(specifier)
    } catch {
      // Try the next portable installation location.
    }
  }
  return undefined
}

export async function resolve(specifier, context, nextResolve) {
  if (HOST_ALIASES.has(specifier)) {
    const resolved = resolveHostPackage(specifier)
    if (!resolved) {
      throw new Error(
        `Pi host package ${JSON.stringify(specifier)} is required by this test; ` +
        `searched require.resolve, PI_PACKAGE_DIR, and ${path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules')}`,
      )
    }
    return { url: pathToFileURL(resolved).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
