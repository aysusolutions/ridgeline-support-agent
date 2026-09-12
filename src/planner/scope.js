import { HARM_FRAMINGS } from '../config/safety.js'
import { brand } from '../config/brand.js'

export function isHarmFramed (text) {
  const t = String(text ?? '')
  return HARM_FRAMINGS.some(re => re.test(t))
}

// Out-of-scope is NOT detected by a list. It is what the pipeline concludes once the
// classifier, interpret_need and search_faq have all missed. This function only picks
// the copy, and deliberately never names the category — partly because the agent does
// not need to know what kind of question it declined, and partly so the fence is not
// an oracle about its own rules.
export function declineFor (partialMatch, chips) {
  if (partialMatch && Object.keys(partialMatch).length) {
    return { reply: brand.voice.decline.withOffer, pivot: partialMatch, chips: [] }
  }
  return { reply: brand.voice.decline.bare, pivot: null, chips }
}
