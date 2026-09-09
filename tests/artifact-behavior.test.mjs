import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { register } from 'node:module'

register('./ts-loader.mjs', import.meta.url)

const { sanitizeStoredHtml } = await import('../extensions/artifacts/templates.ts')
const { readInputFile, resolveInputPath } = await import('../extensions/artifacts/utils.ts')
const { ensureServer, stopServer } = await import('../extensions/artifacts/server.ts')
const { artifactErrorMessage } = await import('../extensions/artifacts/errors.ts')

test('artifact sanitizer executes and removes active markup while preserving safe markup', () => {
  const html = sanitizeStoredHtml('<p>safe</p><script>alert(1)</script><img src="x" onerror="alert(1)"><a href="javascript:alert(1)">link</a>')
  assert.match(html, /<p>safe<\/p>/)
  assert.doesNotMatch(html, /<script|onerror|javascript:/i)
})

test('artifact path validation executes traversal, symlink, and sensitive-file checks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-input-'))
  try {
    await writeFile(path.join(root, 'safe.md'), '# safe')
    await writeFile(path.join(root, '.env'), 'secret')
    await symlink(path.join(root, 'safe.md'), path.join(root, 'link.md'))
    assert.equal(path.basename(resolveInputPath('safe.md', root)), 'safe.md')
    assert.equal(resolveInputPath('../safe.md', root), null)
    assert.equal(resolveInputPath('.env', root), null)
    assert.equal(resolveInputPath('link.md', root), null)
    assert.deepEqual(readInputFile('safe.md', root), { content: '# safe' })
    assert.match(readInputFile('../safe.md', root).error, /regular, non-sensitive/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('artifact server requires the token for local requests', async () => {
  const active = await ensureServer()
  const get = (pathname, headers = {}) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: active.port, path: pathname, headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })

  try {
    assert.equal((await get('/')).status, 404)
    const authorized = await get(`/?token=${encodeURIComponent(active.token)}`)
    assert.equal(authorized.status, 200)
    assert.match(String(authorized.headers['set-cookie']), /HttpOnly/)
  } finally {
    stopServer()
  }
})

test('unexpected filesystem errors are sanitized without hiding useful render errors', () => {
  assert.equal(artifactErrorMessage({ code: 'EACCES', message: '/private/project/.pi/artifacts/x' }, 'storage unavailable'), 'storage unavailable')
  assert.equal(artifactErrorMessage(new Error('rendered artifact exceeds the 16 MB limit'), 'fallback'), 'rendered artifact exceeds the 16 MB limit')
})
