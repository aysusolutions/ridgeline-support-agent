import { validateNotes } from '../ai/router.js'

// Memory across visits, in two tiers with deliberately different lifetimes.
//
// The line is: PERSIST THE PREFERENCES, NEVER THE AUTHORITY.
//
// A capability grant is twenty minutes of computed authority over one order. Persisting it
// would turn ownership verification into a one-time gate — an unattended browser would
// keep the right to cancel someone's order a week later. The same goes for a pending plan
// and a confirmation token: a token that outlives the page is a replay waiting to happen.
// And `filled` holds the order number and email that were used to verify, which is exactly
// the pair nobody should find in localStorage.
//
// So the exclusion is a NAMED LIST rather than an accident, and a test asserts none of it
// ever reaches storage.
export const NEVER_PERSIST = Object.freeze([
  'grants', 'confirmations', 'ledger', 'pendingPlan', 'pending', 'filled',
  'entitySet', 'seq', 'history', 'misses', 'id',
])

export const PROFILE_KEY = 'ridgeline:profile:v1'
export const CHAT_KEY = 'ridgeline:chat:v1'

// A preference is durable and dull — a name, a category. A transcript is neither: it is
// whatever the shopper typed, which can include an email or an order number. Same feature,
// different risk, so different clocks.
export const PROFILE_TTL_MS = 7 * 86_400_000     // a week
export const CHAT_TTL_MS = 60 * 60_000           // an hour — resume, not archive

const MAX_TURNS = 8            // matches the router's window; more is weight, not memory
const MAX_TEXT = 600

const fresh = (saved, ttl, now) =>
  saved && Number.isFinite(Date.parse(saved.savedAt)) && now - Date.parse(saved.savedAt) < ttl

// Everything read back out is re-validated. A stored profile is untrusted input: the file
// is one devtools tab away from being edited by hand.
function shapeProfile (saved) {
  const notes = validateNotes(saved?.notes) ?? {}
  const sku = /^[A-Z0-9-]{3,20}$/.test(String(saved?.focus ?? '')) ? saved.focus : null
  const lastShown = Array.isArray(saved?.lastShown)
    ? saved.lastShown.filter(s => /^[A-Z0-9-]{3,20}$/.test(String(s))).slice(0, 3)
    : []
  // Our side of the transcript is a ROUTE LABEL, never reply text — the same asymmetry the
  // live session keeps, so restoring it cannot smuggle record data back into a prompt.
  const transcript = Array.isArray(saved?.transcript)
    ? saved.transcript
      .filter(e => e && (typeof e.said === 'string' || typeof e.routed === 'string'))
      .map(e => (e.role === 'user'
        ? { role: 'user', said: String(e.said).slice(0, MAX_TEXT) }
        : { role: 'agent', routed: String(e.routed).slice(0, 40) }))
      .slice(-MAX_TURNS)
    : []
  return { notes, focus: sku, lastShown, transcript }
}

const shapeChat = saved => (Array.isArray(saved?.messages) ? saved.messages : [])
  .filter(m => m && (m.role === 'user' || m.role === 'agent') && typeof m.text === 'string')
  .map(m => ({ role: m.role, text: m.text.slice(0, MAX_TEXT) }))
  .slice(-(MAX_TURNS * 2))

export function createMemory ({ storage, clock = () => Date.now() } = {}) {
  const read = (key) => {
    if (!storage) return null
    try { return JSON.parse(storage.getItem(key) ?? 'null') } catch { return null }
  }
  const write = (key, value) => {
    if (!storage) return
    try { storage.setItem(key, JSON.stringify({ ...value, v: 1, savedAt: new Date(clock()).toISOString() })) } catch { /* a full or blocked store is not worth breaking the page over */ }
  }
  const drop = (key) => {
    if (!storage) return
    // `removeItem` returns undefined, so `removeItem?.() ?? setItem(...)` removes the key
    // and then writes "null" straight back over it. Forgetting has to actually forget.
    try {
      if (typeof storage.removeItem === 'function') storage.removeItem(key)
      else storage.setItem(key, 'null')
    } catch { /* ignore */ }
  }

  return {
    enabled: !!storage,

    loadProfile () {
      const saved = read(PROFILE_KEY)
      return fresh(saved, PROFILE_TTL_MS, clock()) ? shapeProfile(saved) : null
    },

    // Takes the live session and copies out only the four fields worth keeping. It reads
    // from an allowlist rather than deleting from a copy, so a new session field is
    // private by default instead of leaking the day someone adds it.
    saveProfile (session) {
      const profile = {
        notes: session.notes ?? {},
        focus: session.focus ?? null,
        lastShown: session.lastShown ?? [],
        transcript: (session.transcript ?? []).slice(-MAX_TURNS),
      }
      // Nothing worth remembering means no record at all, not an empty one. Otherwise
      // "start over" is followed instantly by a fresh write and the key comes back from
      // the dead — and a visitor who told us nothing would still leave a trace.
      const empty = !Object.keys(profile.notes).length && !profile.focus &&
        !profile.lastShown.length && !profile.transcript.length
      if (empty) { drop(PROFILE_KEY); return }
      write(PROFILE_KEY, profile)
    },

    loadChat () {
      const saved = read(CHAT_KEY)
      return fresh(saved, CHAT_TTL_MS, clock()) ? shapeChat(saved) : null
    },

    saveChat (messages) { write(CHAT_KEY, { messages: shapeChat({ messages }) }) },

    // "Start over" has to mean it. Both tiers, one call.
    clear () { drop(PROFILE_KEY); drop(CHAT_KEY) },
  }
}
