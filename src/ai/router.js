// Routes a message the deterministic classifier could not place.
//
// This replaces a growing pile of hand-written patterns for greetings, thanks, and
// "what do u do". Those were the same mistake as a topic denylist: an unbounded
// enumeration of natural language, always one phrasing behind.
//
// Nothing here can act. The model returns ONE label from a closed set; code decides what
// that label means. A wrong pick costs a mediocre reply, never an unauthorised effect —
// which is why this is a safe place to let the model think, and the kernel is not.

export const ROUTES = Object.freeze([
  'greeting', 'identity', 'capabilities', 'thanks', 'closing',
  'support', 'product', 'purchase', 'question', 'complaint', 'human', 'unsafe', 'off_topic',
  // "What were we looking at?" — a question about what WE remember, not about an order.
  // Without its own label the router read it as `support`, found no order, and escalated
  // to a human: the most natural thing a returning shopper says, answered worst.
  'recall',
])

// Anything the shopper told us about themselves. Tightly shaped — a name is a short
// word, not a paragraph — so a model that tries to smuggle instructions in through the
// "name" field gets a truncated nonsense string rather than a channel.
export function validateNotes (raw) {
  if (!raw || typeof raw !== 'object') return null
  const notes = {}
  const name = String(raw.name ?? '').trim()
  if (/^[\p{L}][\p{L}'’-]{1,20}$/u.test(name)) notes.name = name
  const lookingFor = String(raw.lookingFor ?? '').trim()
  if (lookingFor && lookingFor.length <= 60) notes.lookingFor = lookingFor
  // The consultative persona asks what the trip is. Without somewhere to put the answer
  // it would ask again next turn, which is worse than never having asked.
  const trip = String(raw.trip ?? '').trim()
  if (trip && trip.length <= 80) notes.trip = trip
  const q = Number(raw.quantity)
  if (Number.isInteger(q) && q > 0 && q <= 99) notes.quantity = q
  return Object.keys(notes).length ? notes : null
}

export function validateRoute (parsed) {
  const route = String(parsed?.route ?? '').trim().toLowerCase()
  if (!ROUTES.includes(route)) return null
  return {
    route,
    reason: String(parsed?.reason ?? '').slice(0, 80),
    remember: validateNotes(parsed?.remember),
  }
}

// `recent` is the conversation so far: the user's own words verbatim, and for our side
// only the LABEL we routed to — never the reply text. Without it a follow-up like
// "I asked who you are, not what you can do" has no referent and gets misrouted.
export async function routeMessage (adapter, text, categories, recent = []) {
  const raw = await adapter.run('route', { text, categories, recent })
  if (!raw) return null
  try {
    const cleaned = String(raw).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
    return validateRoute(JSON.parse(cleaned))
  } catch {
    return null
  }
}
