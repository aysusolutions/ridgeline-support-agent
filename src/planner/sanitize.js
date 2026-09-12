export const MAX_INPUT_CHARS = 500

const ZERO_WIDTH = /[​-‏⁠﻿]/g
const BIDI = /[‪-‮⁦-⁩]/g
const TAGS = /[\uDB40][\uDC00-\uDFFF]/g

// Characters that render as Latin but are not. Folding these BEFORE matching is what
// stops the obvious obfuscated-injection tricks.
const HOMOGLYPHS = new Map(Object.entries({
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c',
  'х': 'x', 'у': 'y', 'і': 'i', 'ѕ': 's', 'һ': 'h',
  'А': 'A', 'Е': 'E', 'О': 'O', 'Р': 'P', 'С': 'C',
  'Х': 'X', 'У': 'Y', 'Ѕ': 'S',
  'Α': 'A', 'Ο': 'O', 'ο': 'o', 'Β': 'B', 'Κ': 'K',
}))

// Heuristics, not a boundary. The real defences are the capability and taint gates —
// these exist so an obvious attempt is logged and answered calmly rather than parsed.
const HEURISTICS = [
  [/ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i, 'INJECTION_HEURISTIC'],
  // "ignore your restrictions" — found by tests/adversarial/scope-evasion.json, which is
  // what the corpus is for. The list will always be incomplete; that is why it is the
  // heuristic layer and not the boundary.
  [/\b(ignore|bypass|drop|forget|override)\s+(your|all|the|any)\s+(restrictions?|rules?|guidelines?|constraints?|filters?|guardrails?)/i,
    'INJECTION_HEURISTIC'],
  [/disregard\s+(everything|all|the|any)\s*(above|previous|prior)?/i, 'INJECTION_HEURISTIC'],
  [/you\s+are\s+now\b|developer\s+mode|\bDAN\b|jailbreak|unrestricted/i, 'INJECTION_HEURISTIC'],
  [/(repeat|print|reveal|show|output)\s+(your|the)\s+(system\s+)?(prompt|instructions)/i, 'INJECTION_HEURISTIC'],
  [/translate\s+the\s+above/i, 'INJECTION_HEURISTIC'],
  [/<\|im_(start|end)\|>|\[\/?INST\]|###\s*System:|\b(system|assistant)\s*:/i, 'ROLE_MARKUP'],
  [/[A-Za-z0-9+/]{40,}={0,2}/, 'ENCODED_PAYLOAD'],
  [/(?:\\x[0-9a-f]{2}|%[0-9a-f]{2}){8,}/i, 'ENCODED_PAYLOAD'],
]

export function sanitize (raw) {
  let text = String(raw ?? '')

  text = text.normalize('NFKC')
  text = text.replace(TAGS, '').replace(ZERO_WIDTH, '').replace(BIDI, '')
  text = [...text].map(ch => HOMOGLYPHS.get(ch) ?? ch).join('')
  text = text.replace(/\s+/g, ' ').trim()

  const truncated = text.length > MAX_INPUT_CHARS
  if (truncated) text = text.slice(0, MAX_INPUT_CHARS)

  const flags = [...new Set(HEURISTICS.filter(([re]) => re.test(text)).map(([, f]) => f))]
  return { text, flags, truncated }
}
