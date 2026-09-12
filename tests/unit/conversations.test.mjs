import { readdir, readFile } from 'node:fs/promises'
import { test, assert, diff } from '../harness.mjs'
import { createDb } from '../../src/backend/db.js'
import { createAgent } from '../../src/dialog/turn.js'
import { events } from '../../src/telemetry/events.js'

const dir = new URL('../conversations/', import.meta.url)
const files = (await readdir(dir)).filter(f => f.endsWith('.json')).sort()

for (const file of files) {
  const fx = JSON.parse(await readFile(new URL(file, dir), 'utf8'))

  test(`conversation: ${fx.name}`, async () => {
    events.reset()
    const db = createDb()
    const before = db.snapshot()
    // No adapter passed — every fixture must complete on the deterministic path alone.
    const agent = createAgent({ db, clock: () => Date.parse(fx.now) })

    let last = null
    for (const [i, t] of fx.turns.entries()) {
      const out = t.confirmLast
        ? await agent.turn(null, { confirm: { [last.cards[0].stepId]: last.cards[0].token } })
        : await agent.turn(t.user)
      last = out

      const e = t.expect ?? {}
      if (e.intentIs) assert.eq(out.intent, e.intentIs, `turn ${i} intent`)
      if (e.asks) assert.eq(out.asks, e.asks, `turn ${i} asks`)
      if (e.status) assert.eq(out.status, e.status, `turn ${i} status`)
      if (e.outOfScope) assert.eq(out.outOfScope, true, `turn ${i} out of scope`)
      if (e.cardKind) {
        assert.ok(out.cards.some(c => c.kind === e.cardKind),
          `turn ${i} expected a ${e.cardKind} card, got [${out.cards.map(c => c.kind)}]`)
      }
      if (e.replyMatches) {
        assert.ok(out.reply.toLowerCase().includes(e.replyMatches.toLowerCase()),
          `turn ${i} reply should contain "${e.replyMatches}"\n  got: ${out.reply}`)
      }
      assert.ok(typeof out.reply === 'string' && out.reply.length > 0,
        `turn ${i} always produces a reply`)
    }

    if (fx.finalStateDiff) {
      assert.eq(diff(before, db.snapshot()), fx.finalStateDiff, 'final state diff')
    }
  })
}

test('every fixture ran', () => {
  assert.ok(files.length >= 16, `expected at least 16 fixtures, found ${files.length}`)
})
