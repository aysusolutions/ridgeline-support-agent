// The ONLY patterns in the scope system.
//
// These exist because harm risk is a property of CONSEQUENCE, not of subject. "Will this
// bag keep me alive at -20?" is a legitimate product question about a real catalogue
// attribute, so it passes the structural in-scope test and would otherwise get a
// confident, reassuring, potentially lethal answer.
//
// DO NOT grow this into a topic list. Topics are handled structurally: a message is in
// scope if the classifier, interpret_need or search_faq matches it, and out of scope is
// simply what falls through. See spec §7.3.
export const HARM_FRAMINGS = [
  /\b(alive|survive|survival|die|death|hypothermia|frostbite)\b/i,
  // "is the Summit 20 fine at -25?" is the dangerous shape: a real question about a real
  // catalogue attribute, where a reassuring answer could get someone hurt.
  /\b(safe|safely|fine|ok|okay|will i be ok|good enough|warm enough|enough|rated for)\b.{0,30}\b(for|in|at|down to|to)\b.{0,20}(-|minus|\d+\s?°?\s?[cf]\b)/i,
  /\bavalanche\b|\baltitude sickness\b|\bacclimati[sz]/i,
  /\bsafe to drink\b|\bpurif|\bgiardia\b|\bpotable\b/i,
  /\b(rescue|emergency|stranded|lost in the)\b/i,
]
