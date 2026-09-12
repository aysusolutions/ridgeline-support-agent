import { isTainted } from '../shared/taint.js'
import {
  firewall, verifyNoFalseAction, verifyNoLivedExperience, verifyNotStalling,
} from './firewall.js'
import { attribute, citedIdsFrom } from './attribution.js'
import { models } from '../config/models.js'

// Untrusted free text is withheld from the composer entirely. It does not need it — the
// UI renders those fields separately and escaped — and sending a poisoned gift message
// into the prompt would be handing an attacker a channel for no benefit. The firewall
// would still catch an invented fact, but not feeding it is the stronger position.
export function stripUntrusted (node) {
  if (Array.isArray(node)) return node.map(stripUntrusted)
  if (isTainted(node)) return '[withheld]'
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, stripUntrusted(v)]))
  }
  return node
}

// Returns the generation only if it survives the firewall. null means "use the template".
export async function compose (adapter, results, onReject, recent = [], notes = {}) {
  const generated = await adapter.run('compose', { results: stripUntrusted(results), recent, notes })
  if (!generated) return null

  const verdict = firewall(generated, results)
  if (!verdict.ok) {
    onReject?.(verdict)
    return null
  }
  // We handed it the records. A reply that asks for them back is not an answer.
  const stalling = verifyNotStalling(generated, Array.isArray(results) && results.length > 0)
  if (!stalling.ok) {
    onReject?.({ ...stalling, reason: 'asked for detail it was already given' })
    return null
  }
  const lived = verifyNoLivedExperience(generated)
  if (!lived.ok) {
    onReject?.({ ...lived, reason: 'claimed lived experience it cannot have' })
    return null
  }
  return generated.trim()
}

// FAQ answers do NOT go through the generic composer. They need citations and
// claim-level attribution, and abstention when the retrieved entries do not actually
// answer the question — none of which `compose` does.
export async function answerFaq (adapter, faqList, question, onReject) {
  const entries = faqList.items.map(f => ({ id: f.id, question: f.question, answer: f.answer }))
  if (!entries.length) return null

  const raw = await adapter.run('answer_faq', { question, entries })
  if (!raw) return null

  const text = String(raw).trim()
  if (/^INSUFFICIENT/i.test(text)) {
    onReject?.({ rejected: ['INSUFFICIENT'], reason: 'model abstained' })
    return null
  }

  const cited = citedIdsFrom(text, entries.map(e => e.id))
  const passages = entries.filter(e => cited.includes(e.id)).map(e => e.answer)
  // No citation, or one the retrieval never offered, means we cannot check the claim.
  const verdict = attribute(text, passages.length ? passages : [])
  if (!verdict.ok) {
    onReject?.({ rejected: verdict.unattributed, reason: 'unattributed claim' })
    return null
  }

  return text.replace(/\s*\[[a-z0-9-]+\]\s*/gi, ' ').trim()
}

// How many sentences each kind of reply is allowed. The prompt asks for this too, and
// the model keeps ignoring it — "hi Ayush, what's on your mind" arrives with a second
// line of "I'm here to help with any questions you have" bolted on. Length is checkable,
// so code enforces it: the model owns the words, code owns the shape.
export const SHAPE = {
  greeting: 1,
  thanks: 1,
  closing: 1,
  complaint: 2,
  identity: 2,
  capabilities: 2,
  // Was 1, when browse only ASKED which department. Now that it answers with what the
  // shop stocks and then narrows, one sentence truncated it to whatever came first — a
  // reply of "Hey!" and nothing else.
  browse: 2,
  // Declining a purchase is one clear sentence plus what happens next. Left at the
  // default it rambled into "I'll try to get back on track with your purchase. Thanks Bye".
  purchase: 2,
}
const DEFAULT_SENTENCES = 3

// Nobody says "hi" six times in one conversation. The prompt asks the model not to when
// we have already greeted, and it mostly complies — but only mostly, and a stray "Hi,"
// on turn five is exactly what made this read like a bot. Whether we have greeted is
// session state the model cannot see, so code strips it rather than asking twice.
export function dropGreeting (text) {
  const stripped = String(text)
    .replace(
      // The trailing address word has to go with it. Stripping just "Hey" from "Hey there!
      // Which gear are you after?" left "There!", and the one-sentence cap for a greeting
      // then kept only that. Same for the register-matched "Hey bro".
      /^\s*(hi|hey|hello|good (?:morning|afternoon|evening)|welcome(?: back| to [^,.!]*)?|good to see you)(?:\s+(?:there|bro|mate|man|friend|folks))?\b[\s,!.—-]*/i,
      '')
  // If almost nothing survives, the reply WAS the greeting — "Welcome back, Ayush." would
  // become "Ayush.", which is worse than the duplicate we were trying to remove.
  if (stripped.trim().length < 12) return String(text).trim()
  return stripped.charAt(0).toUpperCase() + stripped.slice(1)
}

// Keeps whole sentences only — truncating mid-clause reads worse than the padding did.
export function trimToShape (text, intent) {
  const limit = SHAPE[intent] ?? DEFAULT_SENTENCES
  const sentences = String(text).replace(/\s*\n+\s*/g, ' ').match(/[^.!?]+[.!?]*/g) ?? []
  const kept = sentences.map(s => s.trim()).filter(Boolean).slice(0, limit)
  return kept.length ? kept.join(' ') : String(text).trim()
}

// The language-agnostic backstop. The regex guards run first because they are free and
// catch the common English case without a round trip; this catches everything they cannot
// read. It can only ADD rejections — a `false` here never overrides a regex that fired.
//
// Unavailable means unverified, and unverified prose does not ship: if the checker cannot
// be reached we fall back to the deterministic template, which is the same thing we do
// when the writer cannot be reached. Silence is the safe direction.
export async function verifyClaims (adapter, reply, { wroteToLedger = false } = {}) {
  const raw = await adapter.run('verify', { reply })
  if (!raw) {
    return models.verification.failClosed
      ? { ok: false, rejected: ['unverified'], reason: 'could not check the reply' }
      : { ok: true, rejected: [] }
  }

  let v
  try {
    v = JSON.parse(String(raw).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim())
  } catch {
    return { ok: false, rejected: ['unparseable'], reason: 'checker returned nonsense' }
  }

  const faults = []
  // An action claim is only a fault when nothing actually happened.
  if (v.action === true && !wroteToLedger) faults.push('claimed an action it did not take')
  if (v.experience === true) faults.push('claimed lived experience it cannot have')
  if (v.stalling === true) faults.push('asked for detail it was already given')
  return faults.length
    ? { ok: false, rejected: faults, reason: faults[0] }
    : { ok: true, rejected: [] }
}

// Writes a conversational reply from a fact sheet the CODE assembled. The model chooses
// the words; it cannot choose the content. Returns null when unavailable or when the
// firewall catches an invented fact, and the caller falls back to the canned line.
export async function converse (adapter, { intent, text, recent, facts, notes, opened, returning }, onReject) {
  const generated = await adapter.run('converse', {
    intent, text, recent, facts, notes, opened, returning,
  })
  if (!generated) return null

  const verdict = firewall(generated, [facts])
  if (!verdict.ok) {
    onReject?.(verdict)
    return null
  }
  // A conversational reply NEVER performs an action, so any claim that one happened is
  // false by construction. This is where "your purchase is being processed" dies.
  const deeds = verifyNoFalseAction(generated, false)
  if (!deeds.ok) {
    onReject?.({ ...deeds, reason: 'claimed an action it did not take' })
    return null
  }
  const lived = verifyNoLivedExperience(generated)
  if (!lived.ok) {
    onReject?.({ ...lived, reason: 'claimed lived experience it cannot have' })
    return null
  }
  // The guard was wired into `compose` only, so "I don't have specs for any tents right
  // now" came out of a CONVERSATIONAL turn instead — with a catalogue of eighteen products
  // one search away. A conversational reply is never empty-handed about the catalogue: it
  // can always look. Passing `true` says exactly that.
  const stalling = verifyNotStalling(generated, true)
  if (!stalling.ok) {
    onReject?.({ ...stalling, reason: 'claimed it lacks specs it can simply look up' })
    return null
  }
  // Language-agnostic backstop, after the free English pass above.
  const checked = await verifyClaims(adapter, generated, { wroteToLedger: false })
  if (!checked.ok) {
    onReject?.(checked)
    return null
  }
  const cleaned = generated.trim().replace(/^["']|["']$/g, '')
  return trimToShape(opened ? dropGreeting(cleaned) : cleaned, intent)
}

export async function composeComparison (adapter, comparison, statedNeed, onReject) {
  const generated = await adapter.run('compare', {
    comparison: stripUntrusted(comparison),
    statedNeed: statedNeed ?? null,
  })
  if (!generated) return null

  const verdict = firewall(generated, [comparison])
  if (!verdict.ok) {
    onReject?.(verdict)
    return null
  }
  return generated.trim()
}
