// The order slots are asked in. Identity first, then the specifics — asking for a
// reason before knowing which order is what makes bots feel like forms.
export const ASK_ORDER = ['orderId', 'email', 'lineItemId', 'reason', 'size', 'address', 'newDate']

export const ASK_COPY = {
  orderId: "What's the order number? It looks like RO-10482 and it's on your confirmation email.",
  email: 'And the email address on that order?',
  lineItemId: 'Which item is it?',
  reason: "What's the reason? Wrong size, defective, not as described, or changed your mind?",
  size: 'Which size would you like instead?',
  address: "What's the new address? Street, city, state and ZIP.",
  newDate: 'Which day works better? Anything within the next 10 days.',
}

// Answers to "which email?", "where do I find that?" — questions ABOUT the slot rather
// than answers to it. Without these the agent hits the fallback ladder and tells a
// perfectly reasonable question that it did not understand.
export const ASK_HELP = {
  orderId: 'It starts RO- and sits at the top of your confirmation email, next to the date.',
  email: 'Whichever address you used when you ordered — the one the confirmation went to.',
  lineItemId: 'The item line, like L1 or L2. Or just tell me the product name.',
  reason: 'Whatever fits best — wrong size, defective, not as described, or changed your mind.',
  size: 'Any size we stock in that item. I will tell you if it is out.',
  address: 'Street, city, state and ZIP is plenty.',
  newDate: 'Any day in the next ten — the carrier will not hold it longer than that.',
}

// Lets "which email?" be answered about the EMAIL even while we are still asking for the
// order number. Ordered most-specific first.
export const SLOT_WORDS = [
  ['orderId', /\border\s*(number|no|id)?\b|\bRO-?\b/i],
  ['email', /\be-?mail\b|\baddress\b(?!.*\bship)/i],
  ['lineItemId', /\bitem\b|\bline\b|\bwhich one\b/i],
  ['reason', /\breason\b|\bwhy\b/i],
  ['size', /\bsize\b/i],
  ['newDate', /\bdate\b|\bday\b|\bwhen\b/i],
  ['address', /\bship(ping)?\s*address\b|\bdeliver(y)?\s*address\b/i],
]

export const REASON_CHIPS = ['Wrong size', 'Defective', 'Not as described', 'Changed my mind']

export const REASON_MAP = {
  'wrong size': 'wrongSize',
  'defective': 'defective',
  'broken': 'defective',
  'damaged': 'defective',
  'not as described': 'notAsDescribed',
  'changed my mind': 'changedMind',
  'wrong item': 'wrongItem',
}

export function nextMissing (required, filled) {
  return ASK_ORDER.find(s => required.includes(s) && !filled[s]) ?? null
}
