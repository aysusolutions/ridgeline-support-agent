// The floor under the floor.
//
// Routing conversational messages is the ROUTER's job, and this file must never compete
// with it — enumerating natural language is the treadmill the rest of the planner exists
// to avoid. But when there is no router at all — no key, exhausted quota, a provider
// having a bad afternoon — the agent answered "hi" with "I didn't catch that", then a
// disambiguation menu, then raised a support ticket on the third try. A shopper who says
// hello does not need a ticket.
//
// So: a deliberately tiny, closed set of the social messages that carry no information
// beyond their own category. Consulted ONLY when the router is unavailable. Every one is
// answered from brand.voice, so it needs no model and invents nothing.
//
// The bar for adding a pattern here: recognisable from the words alone with no context,
// and getting it wrong must cost nothing. "hi" qualifies. "is this warm enough" does not.
//
// Written as literal regexes rather than assembled from strings. An earlier version built
// them with template literals and every `\s` silently became `s`, matching nothing.

// A leading run of greeting or address words, so "hey what do u do" reaches the same
// pattern as "what do you do".
const OPEN = /^\s*(?:(?:hi|hey+|hello|yo+|sup|bro|man|mate|dude|ok|okay|so|and)[\s,!.]+)*/i

const PATTERNS = [
  // Greetings, including the ones with an address word attached.
  [/^\s*(?:hi|hey+|hello|yo+|sup|wass?up|howdy|hiya|heya|good\s+(?:morning|afternoon|evening))\b[\s,!.?]*(?:bro|man|mate|dude|there|folks|friend)?[\s,!.?]*$/i, 'greeting'],

  // Thanks.
  [/^\s*(?:ok(?:ay)?\s+)?(?:thanks?|thank\s+you|thx|ty|cheers|nice\s+one|appreciate\s+it)\b[\s,!.?]*(?:bro|man|mate|dude|a\s+lot|so\s+much)?[\s,!.?]*$/i, 'thanks'],

  // Goodbyes.
  [/^\s*(?:ok(?:ay)?\s+)?(?:bye+|goodbye|see\s+(?:ya|you)|later|laters|cya|i'?m\s+off|gtg|good\s?night)\b[\s,!.?]*(?:bro|man|mate|dude|then|now)?[\s,!.?]*$/i, 'closing'],

  // What can you do. Before `identity`, because "what do you do" is about the job.
  // Anchored to the END: "who are you shipping with" is a shipping question that merely
  // begins with "who are you", and matching its prefix answered the wrong thing.
  [/^(?:what|wat)\s+(?:can|do|does|could)\s+(?:you|u|ya|this|it)\s*(?:do|help|offer)?\s*(?:here|for\s+me|then)?[\s,!.?]*$/i, 'capabilities'],
  [/^how\s+(?:can|do)\s+(?:you|u)\s+help[\s,!.?]*$/i, 'capabilities'],

  // What do you stock. Answerable straight from the catalogue, so it belongs in the floor
  // rather than falling through to FAQ retrieval — where "what kind of gear do you have"
  // matched the WARRANTY entry above threshold and came back as a policy answer.
  // Requires a GENERIC noun. "what kind of gear do you have" is a catalogue question;
  // "what kind of tent for himalayas" is a product need and must stay a search.
  [/^(?:what|wat)\s+(?:kind|type|sort)s?\s+of\s+(?:gear|gears|kit|stuff|things?|products?|items?)(?:\s+(?:do|does)?\s*(?:you|u|ya)\s+(?:have|sell|stock|carry|got))?[\s,!.?]*$/i, 'catalogue'],
  [/^(?:what|wat)\s+(?:do|does|have|has)\s+(?:you|u|ya)\s*(?:have|sell|stock|carry|got)?[\s,!.?]*$/i, 'catalogue'],
  [/^(?:what|wat)\s+(?:have|has)\s+(?:you|u)\s+got[\s,!.?]*$/i, 'catalogue'],

  // Who or what are you.
  [/^(?:who|what)\s+(?:are|r|is)\s+(?:you|u|this)[\s,!.?]*$/i, 'identity'],
  [/^(?:are|r)\s+(?:you|u)\s+(?:a\s+)?(?:bot|robot|human|real|real\s+person|person|ai|machine)[\s,!.?]*$/i, 'identity'],
  [/^am\s+i\s+(?:talking|speaking)\s+to\s+a\s+\w+[\s,!.?]*$/i, 'identity'],
]

// Returns a route label, or null when this is not one of the handful of things we are
// willing to recognise without help.
export function socialRoute (text) {
  const raw = String(text ?? '')
  // A long message is not small talk, whatever it opens with. "hi, where is order
  // RO-10482" is support and must not be swallowed here.
  // Eight, not six: "what kind of gear do you have" is seven words and is exactly the
  // thing this file should catch. The real protection is that every pattern is anchored to
  // the whole message, not this count — the count only keeps long prose out cheaply.
  if (raw.trim().split(/\s+/).length > 8) return null

  // Greetings match the whole message; the rest may carry a greeting in front of them.
  const trimmed = raw.replace(OPEN, '')
  for (const [re, route] of PATTERNS) {
    if (re.test(raw) || re.test(trimmed)) return route
  }
  return null
}
