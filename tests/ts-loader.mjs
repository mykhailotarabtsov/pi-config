import { resolve as resolveHost } from './host-loader.mjs'

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && specifier.endsWith('.js')) {
    try {
      return await nextResolve(`${specifier.slice(0, -3)}.ts`, context)
    } catch {
      // Keep ordinary JavaScript imports working when there is no TS sibling.
    }
  }
  return resolveHost(specifier, context, nextResolve)
}
