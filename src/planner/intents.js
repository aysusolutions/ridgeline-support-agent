import { score } from './fuzzy.js'

export const TIERS = { ACT: 0.75, DISAMBIGUATE: 0.45 }

// `advertised` marks the four capabilities from the brief. FAQ is a fifth implemented
// flow that is never offered as a menu option, only contextually — which is what keeps
// the containment number honest rather than flattering.
export const INTENTS = [
  { name: 'track_order', advertised: true, label: 'Track my order',
    requires: ['orderId', 'email'],
    utterances: ['where is my order', 'track my order', 'order status',
                 'has my package shipped', 'when will it arrive', 'tracking number',
                 'where is my parcel'] },

  { name: 'start_return', advertised: true, label: 'Start a return',
    requires: ['orderId', 'email', 'lineItemId', 'reason'],
    utterances: ['start a return', 'i want to return this', 'return an item',
                 'send it back', 'exchange for a different size', 'wrong size',
                 'return the jacket'] },

  { name: 'recommend', advertised: true, label: 'Help me choose',
    requires: [],
    utterances: ['help me choose a tent', 'what sleeping bag should i get',
                 'recommend some gear', 'which jacket is warmest',
                 'i need a pack for backpacking', 'what should i buy'] },

  { name: 'handoff', advertised: true, label: 'Talk to a human',
    requires: [],
    utterances: ['talk to a human', 'speak to an agent', 'get me a person',
                 'customer service representative', 'i want a real person'] },

  { name: 'compare', advertised: false, label: 'Compare these',
    requires: [],
    utterances: ['why this one over that', 'compare these two', 'what is the difference',
                 'which is better', 'why should i choose this one'] },

  { name: 'cancel_order', advertised: false, label: 'Cancel my order',
    requires: ['orderId', 'email'],
    utterances: ['cancel my order', 'cancel it', 'i want to cancel', 'stop the order',
                 'call off my order'] },

  { name: 'change_address', advertised: false, label: 'Change my address',
    requires: ['orderId', 'email', 'address'],
    utterances: ['change my shipping address', 'wrong address', 'ship it somewhere else',
                 'update the delivery address', 'send it to a different address'] },

  { name: 'reschedule', advertised: false, label: 'Reschedule delivery',
    requires: ['orderId', 'email', 'newDate'],
    utterances: ['reschedule the delivery', 'deliver it another day',
                 'change the delivery date', 'hold my delivery'] },

  { name: 'report_missing', advertised: false, label: 'Package missing',
    requires: ['orderId', 'email'],
    utterances: ['it says delivered but i did not get it', 'my package is missing',
                 'it never arrived', 'stolen package', 'parcel not received'] },

  { name: 'faq', advertised: false, label: 'Ask a question',
    requires: [],
    utterances: ['what is your return policy', 'how long do i have',
                 'do you ship internationally', 'what does the warranty cover',
                 'how much is shipping', 'how do i wash a down jacket'] },
]

// A QUESTION about what the agent is. "are you a real person" shares two content tokens
// with the handoff utterance "i want a real person" — Dice 0.8, over the act threshold —
// so it raised a support ticket instead of answering, and the router (which labels it
// `identity` correctly) was never consulted. Token overlap cannot tell a question from a
// request, and handoff is an ACTION: it creates a real ticket for a real queue.
const ASKING_ABOUT_US =
  /^\s*(?:are|is|am|r)\s+(?:you|u|this|i|it)\b|^\s*(?:who|what)\s+(?:are|r)\s+(?:you|u)\b/i

export function classify (text) {
  let best = { intent: 'faq', confidence: 0 }
  for (const intent of INTENTS) {
    const s = Math.max(...intent.utterances.map(u => score(text, u)))
    if (s > best.confidence) best = { intent: intent.name, confidence: s }
  }
  // Someone asking whether we are human is not asking for a human. Demote rather than
  // reclassify: `identity` is the router's label, so hand the decision over instead of
  // guessing it here.
  if (best.intent === 'handoff' && ASKING_ABOUT_US.test(text)) {
    return { intent: best.intent, confidence: Math.min(best.confidence, TIERS.DISAMBIGUATE - 0.01) }
  }
  return best
}

export const ADVERTISED = INTENTS.filter(i => i.advertised)
export const intentByName = name => INTENTS.find(i => i.name === name) ?? null
