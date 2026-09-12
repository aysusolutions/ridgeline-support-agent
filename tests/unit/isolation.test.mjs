import { readdir, readFile } from 'node:fs/promises'
import { test, assert } from '../harness.mjs'
import { buildPlannerPayload } from '../../src/ai/pllm.js'
import { TOOLS } from '../../src/kernel/tools.js'      // the TEST may import it; src/ai may not
import { createDb } from '../../src/backend/db.js'
import { createSession } from '../../src/kernel/kernel.js'
import { verifyOwnership } from '../../src/kernel/capabilities.js'
import { unwrap } from '../../src/shared/taint.js'

const NOW = Date.parse('2026-08-01T15:00:00Z')

function verifiedSession (orderId, email) {
  const db = createDb()
  const s = createSession('s1', () => NOW)
  s.grants.mint(verifyOwnership(db, orderId, email, NOW).grant)
  s.history = []
  return { db, s }
}

test('the planner payload carries capability names but never their values', () => {
  const { s } = verifiedSession('RO-10221', 'sam.okafor@example.com')
  const payload = JSON.stringify(buildPlannerPayload(s, 'where is my order', TOOLS))
  assert.eq(payload.includes('RO-10221'), false, 'no order id leaked into the payload')
  assert.ok(payload.includes('"order"'), 'capability name present')
  assert.ok(payload.includes('"cancel"') || payload.includes('"claim"'), 'scope present')
})

test('the planner payload never contains untrusted record text', () => {
  const { db, s } = verifiedSession('RO-10221', 'sam.okafor@example.com')
  const poison = unwrap(db.getOrder('RO-10221').giftMessage)
  const payload = JSON.stringify(buildPlannerPayload(s, 'what does the gift message say', TOOLS))
  for (const fragment of poison.split(/\s+/).filter(w => w.length > 6)) {
    assert.eq(payload.includes(fragment), false, `payload free of "${fragment}"`)
  }
})

test('the planner payload never contains a customer email or address', () => {
  const { s } = verifiedSession('RO-10390', 'mira.velasco@example.com')
  const payload = JSON.stringify(buildPlannerPayload(s, 'i want to return this', TOOLS))
  for (const pii of ['mira.velasco@example.com', 'Portland', '97214', '6620']) {
    assert.eq(payload.includes(pii), false, `payload free of ${pii}`)
  }
})

test('prior turns appear as tool names and statuses only', () => {
  const { s } = verifiedSession('RO-10221', 'sam.okafor@example.com')
  s.history = [{ tool: 'lookup_order', status: 'OK',
                 result: { id: 'RO-10221', totals: { totalCents: 18900 } } }]
  const payload = JSON.stringify(buildPlannerPayload(s, 'now cancel it', TOOLS))
  assert.ok(payload.includes('lookup_order'), 'tool name present')
  assert.eq(payload.includes('18900'), false, 'result values withheld')
})

test('the payload does expose what the user themselves typed', () => {
  const { s } = verifiedSession('RO-10390', 'mira.velasco@example.com')
  s.entitySet.add('RO-10390')
  const payload = JSON.stringify(buildPlannerPayload(s, 'cancel RO-10390', TOOLS))
  assert.ok(payload.includes('RO-10390'), 'user-originated values are not secret from the planner')
})

test('src/ai never imports from src/kernel or src/backend', async () => {
  const dir = new URL('../../src/ai/', import.meta.url)
  const offenders = []
  for (const f of await readdir(dir)) {
    if (!f.endsWith('.js')) continue
    const body = await readFile(new URL(f, dir), 'utf8')
    if (/from\s+['"][^'"]*\/(kernel|backend)\//.test(body)) offenders.push(f)
  }
  assert.eq(offenders, [], 'the AI layer must reach the kernel only by handing it a Plan')
})

test('src/kernel never imports from src/ai', async () => {
  const dir = new URL('../../src/kernel/', import.meta.url)
  const offenders = []
  for (const f of await readdir(dir)) {
    if (!f.endsWith('.js')) continue
    const body = await readFile(new URL(f, dir), 'utf8')
    if (/from\s+['"][^'"]*\/ai\//.test(body)) offenders.push(f)
  }
  assert.eq(offenders, [], 'the trusted core must not depend on the untrusted layer')
})
