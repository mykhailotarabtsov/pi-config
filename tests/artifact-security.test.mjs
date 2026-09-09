import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../extensions/artifacts/', import.meta.url)
const read = (name) => readFile(new URL(name, root), 'utf8')

test('artifact sanitizer removes executable HTML while preserving safe markup', async () => {
  const source = await read('templates.ts')
  assert.match(source, /sanitizeStoredHtml\(value: string\): string/) 
  assert.match(source, /allowedSchemes: \["http", "https", "mailto"\]/)
  assert.match(source, /disallowedTagsMode: "discard"/)
  assert.match(source, /html\(\{ text \}/)
  assert.match(source, /return sanitizeFragment\(text\)/)
  assert.doesNotMatch(source, /allowedTags:[^;]+script/)
})

test('artifact input paths reject traversal, links, and sensitive files', async () => {
  const source = await read('utils.ts')
  assert.match(source, /rawPath\.startsWith\("~"\)/)
  assert.match(source, /isAbsolute\(rawPath\)/)
  assert.match(source, /stat\.isSymbolicLink\(\)/)
  assert.match(source, /stat\.nlink !== 1/)
  assert.match(source, /hasSymlinkBetween\(root, candidate\)/)
  assert.match(source, /PROTECTED_NAMES/)
  assert.match(source, /PROTECTED_SUFFIXES/)
  assert.match(source, /isWithin\(root, real\)/)
})

test('artifact HTTP routes require a session token and use timing-safe comparison', async () => {
  const source = await read('server.ts')
  assert.match(source, /timingSafeEqual\(left, right\)/)
  assert.match(source, /if \(!authorized\(suppliedToken, token\)\)/)
  assert.match(source, /send\(res, 404, "text\/plain; charset=utf-8", "not found"\)/)
  assert.match(source, /HttpOnly; SameSite=Strict; Path=\//)
  assert.match(source, /const trusted = trustedArtifacts\.get\(match\[1\]\) === digest\(raw\)/)
  assert.doesNotMatch(source, /req\.method === "HEAD"/)
})

test('artifact tool uses StringEnum and thrown errors with structured result details', async () => {
  const source = await read('index.ts')
  assert.match(source, /StringEnum\(\["create", "update", "open", "list"\]/)
  assert.match(source, /class ArtifactToolError extends Error/)
  assert.match(source, /throw error/)
  assert.match(source, /pi\.on\("tool_result"[\s\S]*?return details \? \{ details \}/)
})
