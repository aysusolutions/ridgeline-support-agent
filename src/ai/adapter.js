// The client-side adapter. It knows job names and payloads. It never knows a prompt,
// never knows a key, and never reaches a provider directly.

import { models } from '../config/models.js'

export const JOBS = Object.freeze(new Set([
  'route', 'verify', 'converse', 'plan', 'extract', 'interpret_need', 'compose',
  'answer_faq', 'reason_lines', 'compare', 'summarize_handoff',
]))

const ENDPOINT = '/api/llm'

// A hang is the one failure that does not degrade on its own: nothing rejects, so nothing
// falls back. This is the clock that turns it into an ordinary null.
function deadlineSignal (ms) {
  if (typeof AbortController !== 'function') return { signal: undefined, done: () => {} }
  const c = new AbortController()
  const id = setTimeout(() => c.abort(new Error(`llm timed out after ${ms}ms`)), ms)
  return { signal: c.signal, done: () => clearTimeout(id) }
}

export function createAdapter ({
  fetchImpl = globalThis.fetch,
  endpoint = ENDPOINT,
  clock = () => Date.now(),
  budgetMs = models.timeouts.clientMs,
} = {}) {
  // When the function is not deployed at all — running from a static server, or a
  // preview with no key — the endpoint 404s on every turn. Latch that once rather than
  // failing (and logging) on every message for the rest of the session.
  let absent = false
  let nullStreak = 0
  let exhausted = false

  async function post (job, payload, ms) {
    const timer = deadlineSignal(ms)
    let res
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        signal: timer.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ job, payload }),
      })
    } finally {
      timer.done()
    }
    if (res.status === 404) { absent = true; throw new Error('llm endpoint absent') }
    if (res.status === 429) { exhausted = true; throw new Error('llm rate limited') }
    if (!res.ok) throw new Error(`llm ${res.status}`)
    const body = await res.json()
    return body.text ?? null
  }

  return {
    // Why the agent is on its deterministic path, so the trace panel can say so rather
    // than leaving "the model is off" indistinguishable from "the model is wrong".
    get status () {
      if (absent) return 'no endpoint'
      if (exhausted) return 'quota exhausted'
      if (nullStreak >= 3) return 'provider failing'
      return 'live'
    },
    get available () { return !absent && !exhausted },

    async run (job, payload) {
      // Allowlist first, before any network call.
      if (!JOBS.has(job)) return null
      if (absent || exhausted) return null

      const note = (text) => { nullStreak = text === null ? nullStreak + 1 : 0; return text }

      // ONE budget for the attempt and its retry together. Giving each its own would let
      // a hang cost twice the deadline, which is the problem rather than the fix.
      const deadline = clock() + budgetMs
      const left = () => deadline - clock()

      try {
        return note(await post(job, payload, left()))
      } catch {
        // A daily quota does not clear on retry, and hammering it wastes the user's
        // time for nothing. A timeout is transient, so it does NOT latch — it just
        // counts toward the null streak like any other empty answer.
        if (absent || exhausted) { nullStreak++; return null }
        // No point starting a request that cannot finish inside what remains.
        if (left() < 1_000) { nullStreak++; return null }
        try {
          // One retry. Per-minute limits clear in bursts; a single retry catches most.
          return note(await post(job, payload, left()))
        } catch {
          nullStreak++
          return null
        }
      }
    },
  }
}
