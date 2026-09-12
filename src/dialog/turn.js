import { sanitize } from '../planner/sanitize.js'
import { extractEntities } from '../planner/entities.js'
import { classify, TIERS, ADVERTISED } from '../planner/intents.js'
import { planFor } from '../planner/deterministic.js'
import { ASK_COPY, ASK_HELP, SLOT_WORDS, REASON_CHIPS } from '../planner/slots.js'
import { isHarmFramed, declineFor } from '../planner/scope.js'
import { resolveProduct } from '../planner/reference.js'
import { score } from '../planner/fuzzy.js'
import { socialRoute } from '../planner/social.js'
import { parsePlan, PlanRejected } from '../kernel/plan.js'
import { createKernel, createSession } from '../kernel/kernel.js'
import { verifyOwnership } from '../kernel/capabilities.js'
import { evaluateGoodwill, daysPastWindow } from '../kernel/preconditions.js'
import { day } from '../shared/format.js'
import { TOOLS } from '../kernel/tools.js'
import { buildVocabulary } from '../kernel/vocabulary.js'
import { TEMPLATES, refusalFor, ESCALATABLE } from './templates.js'
import { nullAdapter } from '../ai/nullAdapter.js'
import { interpretNeed as llmInterpretNeed } from '../ai/interpret.js'
import { proposePlan, buildPlannerPayload } from '../ai/pllm.js'
import { routeMessage } from '../ai/router.js'
import { compose, answerFaq, converse } from '../ai/composer.js'
import { events } from '../telemetry/events.js'
import { brand, agentFacts } from '../config/brand.js'

// COMMANDS, not natural language. A user typing "menu" means the menu, and exact match
// is the right tool for a command. Everything else — greetings, thanks, "what do u do",
// off-topic — goes to the router, because enumerating natural language is a treadmill.
const COMMANDS = {
  handoff: /^(agent|human|person|representative)$/i,
  reset: /^(menu|start over|restart|reset)$/i,
  back: /^(back|cancel that|never ?mind)$/i,
  undo: /^undo$/i,
  help: /^\s*\?+\s*$/,
}

const REVERSIBLE = ['reschedule_delivery', 'subscribe_restock', 'create_handoff_ticket']

// Maps what the shopper called it onto a real catalogue category. "tent" has to reach
// "tents" and "sleeping bag" has to reach "sleeping-bags", so both sides are normalised
// to singular words before comparing.
const categoryKey = (said, categories) => {
  const norm = t => String(t).toLowerCase().replace(/[-_]/g, ' ').replace(/s\b/g, '').trim()
  const want = norm(said)
  if (!want) return null
  return categories.find(c => norm(c) === want)
    ?? categories.find(c => want.includes(norm(c)) || norm(c).includes(want))
    ?? null
}

// "sleeping-bags" is a database key, not something to show a shopper.
const categoryLabel = c => String(c).replace(/-/g, ' ').replace(/^./, m => m.toUpperCase())

export function createAgent ({ db, clock = () => Date.now(), ai = nullAdapter, memory = null } = {}) {
  const kernel = createKernel({ db, tools: TOOLS, clock })
  const session = createSession(`sess-${Math.floor(clock())}`, clock)
  Object.assign(session, {
    pending: null, filled: {}, history: [], misses: 0,
    lastShown: [], pendingPlan: null, filters: {}, weights: {},
    // The conversation so far. User words verbatim (they typed them, so they are
    // USER-labelled); our side recorded as the ROUTE we took, never the reply text —
    // which keeps record data out of every prompt payload.
    transcript: [],
    // What the shopper has told us about themselves — name, what they are after.
    // Shaped and validated in router.js, so a "name" is a short word and nothing else.
    notes: {},
    // The transcript holds our side as route labels, never reply text — so the model
    // cannot see whether it already said hello or already used their name, and it
    // stamped "Hi Ayush," onto every single turn. It is not the model's to know;
    // code tracks it and simply stops offering the name after the first use.
    said: { hello: false, name: false },
  })

  // A returning shopper. Preferences come back; AUTHORITY never does — no grant, no
  // pending plan, no confirmation token, and nothing about which order was verified. The
  // next order action re-verifies, exactly as it would for a stranger.
  const restored = memory?.loadProfile() ?? null
  if (restored) {
    session.notes = restored.notes
    session.focus = restored.focus
    session.lastShown = restored.lastShown
    session.transcript = restored.transcript
    // `said` deliberately stays false. Using their name once on a return visit is the
    // point of remembering it; suppressing it would be remembering in secret.
    session.returning = true
    events.emit('memory.restored', { fields: Object.keys(restored.notes) })
  }

  const remember = (role, value) => {
    session.transcript.push({ role, [role === 'user' ? 'said' : 'routed']: value })
    if (session.transcript.length > 8) session.transcript.shift()
  }

  const known = { orderIds: db.listOrderIds(), skus: db.listSkus() }
  const vocabulary = buildVocabulary(db)
  const execCtx = () => ({ db, policies: db.getPolicies(), now: clock(), seq: session.seq })

  const reply = (text, extra = {}) =>
    ({ reply: text, chips: extra.chips ?? [], cards: extra.cards ?? [], ...extra })

  /* ------------------------------------------------------------------ the turn */

  // Per-turn account of what happened, for the trace panel. Recording is the panel's
  // whole substance: it can only show what the pipeline is honest enough to write down.
  let tr = null
  // Set when the FAQ model refused the retrieved entries as not answering the question.
  let abstained = false
  const startTrace = (raw) => {
    tr = {
      raw, sanitized: null, flags: [], classify: null,
      plannerPayload: null, plannerSaw: null, plan: null,
      kernel: [], compose: null, quarantine: [],
      ledgerFrom: session.ledger.entries().length,
      eventsFrom: events.all().length,
      outcome: null,
    }
    return tr
  }
  const finishTrace = (out) => {
    if (!tr) return out
    tr.outcome = out.status ?? (out.asks ? 'ASK' : out.outOfScope ? 'DECLINED' : 'REPLY')
    tr.ledgerDelta = session.ledger.entries().slice(tr.ledgerFrom)
    tr.events = events.all().slice(tr.eventsFrom)
    return { ...out, debug: tr }
  }

  async function turn (rawText, opts = {}) {
    // A confirmation click re-enters here carrying the token. Never free text.
    if (opts.confirm) {
      startTrace('[confirmation click]')
      return remembered(finishTrace(await runPlan(session.pendingPlan, { confirmations: opts.confirm })))
    }

    startTrace(rawText)
    return remembered(finishTrace(await runTurn(rawText)))
  }

  // Preferences are written after every turn, so a shopper who leaves mid-conversation is
  // remembered as well as one who says goodbye.
  const remembered = (out) => { memory?.saveProfile(session); return out }

  async function runTurn (rawText) {
    const { text, flags } = sanitize(rawText)
    tr.sanitized = text
    tr.flags = flags
    if (text) remember('user', text)

    if (flags.length) {
      events.emit('security.injection_attempt', { flags })
      // Calm and short, and deliberately not an oracle: it never says what tripped.
      return reply(brand.voice.greeting, { chips: brand.chips, flags })
    }

    // Harm framing runs before classification, because it fires on messages that DO
    // match the catalogue — "will this bag keep me alive at -20" is a real product
    // question, and a reassuring answer to it is the dangerous one.
    if (isHarmFramed(text)) {
      events.emit('scope.harm_framing', {})
      const out = await route('handoff', { prefix: `${brand.voice.decline.harm} `, reason: 'safety' })
      return { ...out, outOfScope: true }
    }

    if (COMMANDS.help.test(text)) return reply(brand.voice.greeting, { chips: brand.chips })
    if (COMMANDS.reset.test(text)) {
      session.pending = null; session.filled = {}; session.misses = 0; session.filters = {}
      // "Start over" has to mean it, or the control is decoration. Everything remembered
      // about this shopper goes — on this device and in this session both.
      session.notes = {}; session.focus = null; session.lastShown = []
      session.transcript = []; session.said = { hello: false, name: false }
      session.returning = false
      memory?.clear()
      events.emit('memory.cleared', {})
      return reply("Fresh start — I've forgotten what we were doing. What can I help with?",
        { chips: brand.chips, cleared: true })
    }
    if (COMMANDS.back.test(text)) {
      session.pending = null
      return reply('No problem — what else can I do?', { chips: brand.chips })
    }
    if (COMMANDS.undo.test(text)) return undoLast()
    if (COMMANDS.handoff.test(text)) return route('handoff')

    const found = extractEntities(text, known)
    for (const v of [...found.orderIds, ...found.skus, ...found.dates]) session.entitySet.add(v)

    if (session.pending) {
      const filledOut = planFor(null, session, session.filled, {
        rawText: text, knownOrderIds: known.orderIds, knownSkus: known.skus,
      })
      if (filledOut.filled) return acceptSlot(filledOut)

      // A question ABOUT a slot — "which email?", "where do I find that?" — is not a
      // digression and certainly not a misunderstanding. Answer it and stay put.
      const held = session.pending
      if (/^(wh(ich|at|ere)|how)\b/i.test(text) && text.split(/\s+/).length <= 6) {
        // They may be asking ahead about a different slot than the one we asked for.
        // "which email" while we want an order number is a question about the email.
        const named = SLOT_WORDS.find(([, re]) => re.test(text))?.[0]
        const about = named ?? held.ask
        return reply(ASK_HELP[about] ?? ASK_COPY[held.ask], { asks: held.ask })
      }

      // Otherwise it is a genuine digression: answer it, then resume.
      const digression = await handleFresh(text, { digression: true })
      session.pending = held
      return { ...digression, reply: `${digression.reply}\n\nNow, back to it — ${ASK_COPY[held.ask]}` }
    }

    // Nothing pending — but a FIRST message can still carry its own identity, and until
    // now nothing on this path looked. planFor fills slots only when session.pending is
    // set AND rawText is threaded through, and route() passes neither, so "where is my
    // order RO-10482" was answered with "what's the order number?". The entities were
    // extracted a few lines above and then dropped on the floor.
    const failed = seedIdentity(found)
    if (failed) return failed

    // A bare order number is not an unrecognised utterance — the composer's own
    // placeholder invites it ("Order number, or ask anything"). Treat it as the question
    // it plainly is rather than sending it to the fallback ladder.
    if (found.orderIds.length && BARE_ORDER_ID.test(text)) return route('track_order')

    return handleFresh(text)
  }

  // "RO-10482", "order RO-10482", "#RO-10482" — an id and nothing else meaningful.
  const BARE_ORDER_ID = /^[\s#:.]*(?:order\s*)?RO[-\s]?\d{5}[\s.!?]*$/i

  async function handleFresh (text, opts = {}) {
    const { intent, confidence } = classify(text)
    if (tr) tr.classify = { intent, confidence: Number(confidence.toFixed(3)) }

    // Confident enough to act on token overlap alone: act.
    if (confidence >= TIERS.ACT) {
      session.misses = 0
      if (intent === 'faq') session.filled.query = text
      return route(intent, opts)
    }

    // Anything less gets a second opinion. Read-only intents used to skip this — which
    // is how "why should I buy from here" became a product search at 0.67 confidence
    // and never reached the router at all. The router is a better classifier than token
    // overlap and it cannot act, so consulting it costs nothing but a call.
    return lowConfidence(text, { intent, confidence })
  }

  // Gives the planner one shot at a message the classifier could not place. Its output
  // is parsed with trusted:false, so every literal it emits must still be user-originated
  // or a member of the tool's own enum.
  async function tryPlanner (text, intent) {
    if (tr) {
      tr.plannerPayload = buildPlannerPayload(session, text, TOOLS)
      // What the panel proves: no order id, no record text, no PII in that payload.
      tr.plannerSaw = {
        userMessage: tr.plannerPayload.userMessage,
        capabilities: tr.plannerPayload.capabilities,
        knownEntities: tr.plannerPayload.knownEntities,
        history: tr.plannerPayload.history,
        toolCount: tr.plannerPayload.tools.length,
      }
    }

    const proposed = await proposePlan(ai, session, text, TOOLS)
    if (!proposed) return null
    if (tr) tr.plan = { source: 'P-LLM', trusted: false, raw: proposed }

    try {
      const plan = parsePlan(proposed, {
        tools: TOOLS,
        entitySet: session.entitySet,
        capabilityNames: session.grants.names(),
      })
      session.pendingPlan = plan
      events.emit('plan.llm_accepted', { steps: plan.steps.map(s => s.tool) })
      return runPlan(plan, {}, { intent })
    } catch (e) {
      if (tr) tr.plan.rejected = e.message
      events.emit('security.plan_rejected', { message: e.message })
      return null
    }
  }

  // Everything the business declares about itself gets a chance before the ladder fires.
  async function lowConfidence (text, det = { intent: null, confidence: 0 }) {
    // Ask the model what KIND of message this is. It picks one label from a closed set;
    // this code decides what each label means. Nothing the model returns can act.
    const routed = await routeMessage(ai, text, vocabulary.category, session.transcript)
    if (tr) tr.route = routed
    if (routed) {
      events.emit('route.classified', { route: routed.route })
      remember('agent', routed.route)
      if (routed.remember) {
        session.notes = { ...session.notes, ...routed.remember }
        events.emit('session.noted', { fields: Object.keys(routed.remember) })
      }
      // Classifying is not the same as ANSWERING. Resetting here meant a route that
      // later fell through to the ladder reset the counter on the way past, so the
      // ladder replayed rung one forever — "I didn't catch that", twice, identically.
      // Only the branches that actually produce an answer clear it, below.
      const answered = () => { session.misses = 0 }
      switch (routed.route) {
        case 'greeting':
          answered()
          session.declines = 0
          return reply(await say('greeting', text, brand.voice.hello), { chips: brand.chips })
        case 'identity':
          answered()
          return reply(await say('identity', text, brand.voice.identity), { chips: brand.chips })
        case 'capabilities':
          answered()
          return reply(await say('capabilities', text, brand.voice.greeting), { chips: brand.chips })
        case 'thanks':
          answered()
          return reply(await say('thanks', text, brand.voice.thanks), { chips: brand.chips })
        case 'closing':
          answered()
          return reply(await say('closing', text, brand.voice.bye))
        case 'purchase':
          answered()
          // The quantity is taken from THIS message, not from session.notes — a "5" said
          // two turns ago about sleeping bags must not silently become five boots.
          return buildBasket(text, routed.remember?.quantity)
        case 'complaint': {
          answered()
          // Being told we got it wrong is not a misunderstanding, and it is certainly
          // not a reason to show the same cards a third time. Stop, acknowledge, and
          // hand the floor back — with a person one tap away if we have burnt patience.
          events.emit('csat.complaint', {})
          session.filters = {}
          session.lastShown = []
          session.pending = null
          return reply(await say('complaint', text, brand.voice.myMistake),
            { chips: ['Track my order', 'Start a return', 'Talk to a human'] })
        }
        case 'recall': {
          answered()
          // Answer from what we actually hold. Showing the product beats describing it,
          // and admitting we have nothing beats inventing a plausible history.
          if (session.focus) return pickFocused(session.focus)
          if (session.notes.lookingFor) {
            session.filters = { ...session.filters, category: null }
            return reply(await say('recall', text,
              `You were after ${session.notes.lookingFor}. Want me to pull those back up?`),
            { chips: brand.chips })
          }
          return reply(await say('recall', text,
            "We haven't got to anything yet — what are you after?"), { chips: brand.chips })
        }
        case 'human':
          answered()
          return route('handoff')
        case 'unsafe': {
          answered()
          const out = await route('handoff',
            { prefix: `${brand.voice.decline.harm} `, reason: 'safety' })
          return { ...out, outOfScope: true }
        }
        case 'support': {
          // It IS our business, we just did not catch which flow. If the classifier had
          // a reasonable guess, use it; otherwise let the planner try before we give up.
          if (det.confidence >= TIERS.DISAMBIGUATE && det.intent) { answered(); return route(det.intent) }
          const planned = await tryPlanner(text, det.intent)
          if (planned) { answered(); return planned }
          // A misunderstanding, not a different subject — so the ladder, not the fence.
          // Deliberately NOT calling answered(): the ladder must be allowed to climb.
          return ladder()
        }
        case 'product': {
          // Did they NAME something rather than describe a need? "I think the ridgeline
          // hiker is good" is a choice, not a search — searching again reads as not
          // listening, which is exactly how this went wrong.
          const named = resolveProduct(text, { lastShown: session.lastShown, db })
          if (named) {
            answered()
            session.focus = named
            return pickFocused(named)
          }
          // No product named. Fall through so interpret_need still gets its go at
          // "show me tents" — the browse chooser below is the LAST resort, not the first.
          break
        }
        case 'question':
        case 'off_topic':
        default:
          break            // fall through to the retrieval attempts below
      }
    }

    // Before ANY retrieval. Sitting after the FAQ search meant "how can you help" matched
    // the shipping entry on fuzzy overlap and answered that instead.
    if (!routed) {
      // No router — no key, exhausted quota, a provider having a bad afternoon. Without
    // this the agent answered "hi" with "I didn't catch that", then a menu, then raised
    // a support TICKET on the third attempt. A shopper saying hello does not need a
    // ticket, and the canned lines for these need no model at all.
    const social = socialRoute(text)
    if (social) {
      session.misses = 0
      remember('agent', social)
      return conversational(social, text)
    }

    // They named a department in plain words — "something like tents". Interpreting a
    // vague NEED takes a model, but spotting the word "tents" does not, and showing
    // three tents beats offering a menu.
    const named = categoryKey(text, vocabulary.category)
    if (named) {
      session.misses = 0
      session.filters = { ...session.filters, category: named }
      remember('agent', 'product')
      return route('recommend')
    }
    }

    // A question about what we stock is answered from the catalogue, whatever the router
    // said and before interpret_need gets a look. Left to the model this was a coin flip:
    // interpret_need returns {} for "what kind of gears u have" most of the time, and when
    // it invented a filter instead the shopper got a stake set in reply to "what do you
    // have". The answer to that question does not depend on anyone's mood.
    if (socialRoute(text) === 'catalogue') {
      session.misses = 0
      remember('agent', 'browse')
      return conversational('catalogue', text)
    }

    const need = await interpretNeed(text)
    if (need && !need.empty) {
      session.filters = { ...session.filters, ...need.filters }
      session.weights = { ...session.weights, ...need.weights }
      return route('recommend')
    }

    // Questions about our own clock. The router calls these off_topic, which is fair in
    // the abstract — but the agent HAS a clock and the shop HAS opening hours, and the
    // shopper asked the date so they could tell us their travel dates. Declining a
    // question you can answer in one line from your own state is just unhelpful.
    //
    // Deliberately narrow: our clock and our hours, nothing else. This is not the start of
    // a general knowledge base.
    if (/\b(date|day|time)\b/i.test(text) && /\b(today|todays|now|it|current|open|close|closing|hours)\b/i.test(text)) {
      const now = new Date(clock())
      const facts = {
        ...agentFacts,
        today: now.toISOString().slice(0, 10),
        weekday: now.toLocaleDateString('en-US', { weekday: 'long', timeZone: brand.hours.tz }),
        openHours: `${brand.hours.open}:00 to ${brand.hours.close}:00 ${brand.hours.tzLabel}, `
          + 'Monday to Friday',
      }
      session.misses = 0
      const written = await converse(ai, {
        intent: 'question', text, recent: session.transcript, facts, notes: session.notes,
        opened: session.said.hello,
      }, () => {})
      if (written) return reply(written, { chips: brand.chips })
      return reply(`Today is ${facts.today}. We're open ${facts.openHours}.`,
        { chips: brand.chips })
    }

    // BEFORE retrieval. "what kind of gear do you have" scored over the threshold
    // against the warranty entry, so a browse question came back as a policy answer.
    // If the router says this is about products, an FAQ is not the answer.
    if (routed?.route === 'product') {
      session.misses = 0            // we answered them; this is not a failure to understand
      // We asked what the trip was, they told us — "front range, july, just weekends" —
      // and this used to answer with "Sure, what are you after?", which is worse than
      // never having asked. A trip description carries no catalogue attribute, so
      // interpret_need finds nothing; but we already know the category from last turn, so
      // continue the recommendation instead of starting over.
      if (Object.keys(session.filters).length || session.lastShown.length) {
        return route('recommend')
      }
      // Written, not looked up. This was a hardcoded string, so "what do u have for me
      // bro" got "Sure — what are you after?" — the one reply in the flow that no persona
      // could ever reach. brand.voice.browse stays as the no-model floor.
      // The FALLBACK answers too. Whenever a generation is refused this is what ships, and
      // "Sure — what are you after?" asked the question straight back at someone who had
      // just asked what we stock. The departments are code-owned, so the floor can name
      // them without a model.
      const departments = vocabulary.category.map(categoryLabel)
      const listed = departments.length > 1
        ? `${departments.slice(0, -1).join(', ')} and ${departments.at(-1)}`
        : departments[0]
      return reply(await say('browse', text, `${brand.voice.browseFloor} ${listed}.`),
        { chips: departments })
    }

    const faq = TOOLS.search_faq.execute(execCtx(), { query: text })
    // Retrieval keeps anything over 0.3 and lets the model abstain on a near-miss. With no
    // model there is nothing to abstain, and "something like tents" (0.333 against the
    // return policy) shipped the return policy. So without a checker, demand better
    // evidence: 0.44 is the ceiling the fuzzy scorer puts on a single-word overlap, which
    // is exactly the kind of accidental match this is meant to exclude.
    const strongEnough = ai.available
      ? faq.items
      : faq.items.filter(f => f.score >= 0.44)
    if (strongEnough.length) {
      faq.items = strongEnough
      session.filled.query = text
      // null means the model refused the entries as not answering this question — so keep
      // going rather than treating a near-miss as an answer.
      const answered = await route('faq')
      if (answered) return answered
    }

    // A question about the shop that no FAQ entry covers — "why should I buy from here",
    // "what makes you different". The answer is in the fact sheet, so answer from it
    // rather than declining or, worse, dumping the catalogue.
    if (routed?.route === 'question') {
      return reply(await say('question', text, brand.voice.abstain), { chips: brand.chips })
    }

    // No router — no key, no quota. Fall back on whatever the classifier managed.
    if (!routed) {
      const readOnly = ['faq', 'recommend', 'compare'].includes(det.intent)
      if (det.confidence >= TIERS.DISAMBIGUATE && det.intent) {
        // Answering is cheap to get wrong; acting is not. So a shaky read-only guess
        // gets acted on, and a shaky ACTION gets confirmed with the shopper first.
        if (readOnly) return route(det.intent)
        return reply('I want to get this right — which of these is closest?', {
          chips: ADVERTISED.map(i => i.label), intent: det.intent, confidence: det.confidence,
        })
      }
      // Only the ROUTER can conclude "different subject". Without it we cannot tell an
      // off-topic question from a phrasing we failed to parse, and a wrong decline is
      // much worse than an unnecessary menu. So: offer help instead.
      return ladder()
    }

    // Nothing in the business matched. Not a misunderstanding — a different subject.
    //
    // Except: only `off_topic` actually means "different subject". The router having said
    // `product` or `support` is it telling us this IS our business and we merely failed to
    // find the records — and answering that with "outside my patch" is the rudest thing
    // this agent can do. The rule is stated twenty lines up and was not applied here.
    // A browse request that named no product and no attribute to filter on — "show me
    // your products", "what do you have". interpret_need had nothing to find, so this
    // used to fall through to "that's outside my patch", which is an absurd answer to
    // someone asking a gear shop to show its gear. Offer the departments instead.

    if (routed && routed.route !== 'off_topic') return ladder()

    events.emit('scope.declined', {})
    const { pivot, chips } = declineFor(need?.partial, brand.chips)

    if (!pivot) {
      // Never say the same thing twice. Repeating a decline verbatim is the exact
      // failure the fallback ladder exists to avoid, and the fence is no different.
      session.declines = (session.declines ?? 0) + 1
      if (session.declines >= 3) {
        const out = await route('handoff', { prefix: `${brand.voice.decline.giveUp} ` })
        session.declines = 0
        return { ...out, outOfScope: true }
      }
      const line = session.declines === 1 ? brand.voice.decline.bare : brand.voice.decline.again
      return { ...reply(line, { chips }), outOfScope: true }
    }

    const line = brand.voice.decline.withOffer

    session.filters = { ...pivot }
    const shown = await route('recommend')
    return { ...shown, reply: `${line} If it's about kit though — here's what I have.`, outOfScope: true }
  }

  // Writes a conversational reply rather than looking one up. The fallback string is
  // what ships when there is no model — it is the floor, not the product.
  // The five social labels, answered from brand.voice. Routed through say() so that a
  // failed ROUTER call does not also cost us the writing — those are separate calls and
  // one can be down while the other is fine. With no model at all the canned line ships,
  // which is the whole point: "hi" gets a hello rather than a support ticket.
  const CANNED = {
    greeting: () => [brand.voice.hello, brand.chips],
    thanks: () => [brand.voice.thanks, []],
    closing: () => [brand.voice.bye, []],
    capabilities: () => [brand.voice.capabilities, brand.chips],
    catalogue: () => {
      // Lower-cased for prose: "We do Tents, Sleeping bags and Boots" reads like a form.
      const names = vocabulary.category.map(c => categoryLabel(c).toLowerCase())
      const listed = names.length > 1
        ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
        : names[0]
      return [`${brand.voice.browseFloor} ${listed}.`, vocabulary.category.map(categoryLabel)]
    },
    identity: () => [brand.voice.identity, brand.chips],
  }

  async function conversational (label, text) {
    const [fallback, chips] = CANNED[label]()
    return reply(await say(label, text, fallback), { chips })
  }

  // "What gear are you after?" followed by "Which gear are you after?" is what makes this
  // read as a machine with a script. The model cannot catch it: our side of the transcript
  // is route LABELS, never reply text, because replies carry order numbers and totals and
  // feeding them back into a prompt would undo the isolation the planner depends on.
  //
  // So the check belongs here, where the previous reply is ordinary local state that never
  // leaves the process.
  const REPEAT_LIMIT = 0.7

  // Only a repeated QUESTION is the fault. If someone asks the same thing twice they are
  // entitled to the same answer, and refusing it fell back to "I didn't catch that" — worse
  // than the repetition it was avoiding. What grates is being asked "what gear are you
  // after?" twice by something that will not just tell you.
  const isQuestion = t => /\?\s*$/.test(String(t).trim())

  function tooSimilar (next) {
    const prev = session.lastReply
    if (!prev || !next) return false
    if (!isQuestion(next)) return false
    if (prev.trim() === next.trim()) return true
    return score(prev, next) >= REPEAT_LIMIT
  }


  async function say (intent, text, fallback) {
    // Offer the name once, then withhold it. The model cannot tell it has already used
    // one, so the choice is not the model's to make.
    const notes = { ...session.notes }
    if (session.said.name) delete notes.name
    // Welcome them back ONCE. After that they are simply mid-conversation.
    const returning = !!session.returning && !session.said.hello
    const written = await converse(ai, {
      intent,
      text,
      recent: session.transcript,
      // The fact sheet is static, but the agent HAS a clock — and "whats todays date"
      // used to fall through to FAQ retrieval and come back with the restock policy.
      // Code owns the date; the model just says it.
      facts: { ...agentFacts, today: new Date(clock()).toISOString().slice(0, 10) },
      notes,
      opened: session.said.hello,
      // Same route two turns running means they came back unsatisfied. Derived from the
      // route labels, so no reply text enters the payload.
      repeated: session.transcript.filter(e => e.role === 'agent').at(-1)?.routed === intent,
      // They were here before. Say so once — a greeting that ignores what it plainly
      // remembers is worse than one that never remembered anything.
      returning,
    }, (verdict) => {
      events.emit('security.firewall_rejected', { rejected: verdict.rejected, job: 'converse' })
      if (tr) {
        tr.compose = {
          verdict: 'rejected', rejected: verdict.rejected, fellBackTo: 'canned',
          reason: verdict.reason ?? null,
        }
      }
    })
    let usable = written
    if (usable && tooSimilar(usable)) {
      events.emit('compose.repeated', { intent })
      if (tr) {
        tr.compose = {
          verdict: 'rejected', rejected: ['near-duplicate of the previous reply'],
          fellBackTo: 'canned', reason: 'said almost exactly this last turn',
        }
      }
      usable = null
    }
    if (usable && tr) tr.compose = { verdict: 'accepted', text: usable, job: 'converse' }
    const out = usable ?? fallback
    // Record what the reply actually contained, not what we hoped it would.
    // "Welcome back, Ayush" is an opening too, but it does not start with hi/hey/hello, so
    // the flag stayed false and every later turn welcomed them back all over again.
    // "welcome back" was listed but plain "welcome to Ridgeline Outfitters" was not, so
    // the flag stayed false and the NEXT reply opened with "Hey." all over again.
    if (/^\s*(hi|hey|hello|welcome|good to see|thanks for)\b/i.test(out) || returning) {
      session.said.hello = true
    }
    if (notes.name && new RegExp(`\\b${notes.name}\\b`, 'i').test(out)) session.said.name = true
    session.lastReply = out
    return out
  }

  // Free-text need interpretation. With nullAdapter this is null and the guided quiz
  // carries the same capability through chips — the one place the no-LLM path is
  // meaningfully worse rather than merely blunter.
  async function interpretNeed (text) {
    const out = await llmInterpretNeed(ai, text, vocabulary)
    if (!out) return null
    if (out.empty) return { ...out, partial: out.filters }
    events.emit('interpret.matched', { filters: Object.keys(out.filters), dropped: out.dropped })
    return out
  }

  /* --------------------------------------------------------------- slot filling */

  // Identity is verified in CODE. The model has no part in minting a grant.
  //
  // Both ways of learning an identity land here — answering a slot we asked for, and
  // naming it unprompted in an opening message. One function so the second can never
  // become a weaker path than the first: same verification, same failure handling.
  // Returns a reply ONLY when verification failed; null means carry on.
  function verifyIfComplete () {
    if (!session.filled.orderId || !session.filled.email) return null
    if (session.grants.get('order')) return null

    const v = verifyOwnership(db, session.filled.orderId, session.filled.email, clock())
    if (!v.ok) {
      // Mismatch and not-found produce the identical message — no enumeration oracle.
      events.emit('auth.verification_failed', {})
      session.filled = {}
      session.pending = null
      return reply(
        "I couldn't match that order number and email. Want to try again, or shall I get a person?",
        { chips: ['Try again', 'Talk to a human'] })
    }
    session.grants.mint(v.grant)
    events.emit('auth.verified', { subject: v.grant.subject })
    return null
  }

  // Slots a first message filled on its own. Identity only: these are the two the
  // agent would otherwise ask for immediately, and the ones it is rudest to re-ask.
  // Everything else still goes through the normal slot sequence.
  function seedIdentity (found) {
    let learned = false
    if (!session.filled.orderId && found.orderIds[0]) {
      session.filled.orderId = found.orderIds[0]
      learned = true
    }
    if (!session.filled.email && found.emails[0]) {
      session.filled.email = found.emails[0]
      learned = true
    }
    return learned ? verifyIfComplete() : null
  }

  function acceptSlot ({ filled, value }) {
    session.filled[filled] = value

    const failed = verifyIfComplete()
    if (failed) return failed

    const intent = session.pending.intent
    session.pending = null
    return route(intent)
  }

  /* -------------------------------------------------------------------- routing */

  async function route (intentName, opts = {}) {
    // Same failure as the note below, from the other direction. "i want a sleeping bag"
    // scores 0.800 against the recommend utterance "what sleeping bag should i get", so it
    // acts without ever consulting the router — and nothing on that path extracts a
    // category, so the recommender ran unfiltered and returned tents. The shopper named
    // the department in plain words; use it before searching.
    if (intentName === 'recommend' && !session.filters.category) {
      // In order of authority: what they just said, what they told us they were after,
      // and failing both, whatever is already on screen. That last one is what keeps a
      // conversation from drifting — they were looking at sleeping bags, answered our
      // question about the trip, and the next search had no category at all, so it fell
      // back to a default and showed them TENTS.
      const named = categoryKey(tr?.sanitized ?? '', vocabulary.category)
        ?? categoryKey(session.notes.lookingFor ?? '', vocabulary.category)
        ?? [...new Set(session.lastShown.map(sku => db.getProduct(sku)?.category))
          .values()].filter(Boolean)[0]
      if (named) session.filters = { ...session.filters, category: named }
    }

    // session.filters is where interpret_need puts what it understood. Without threading
    // it through here the recommender searched unfiltered and returned whatever sorted
    // first — "something for a cold night" came back as tents.
    const out = planFor(intentName, session, {
      ...session.filled,
      filters: session.filters,
      weights: session.weights,
      ...opts,
    })

    if (out.ask) {
      session.pending = { intent: intentName, ask: out.ask }
      const chips = out.ask === 'reason' ? REASON_CHIPS : []
      return reply(ASK_COPY[out.ask], { chips, asks: out.ask, intent: intentName })
    }
    if (out.chips) return reply(brand.voice.greeting, { chips: out.chips })

    let plan
    try {
      plan = parsePlan(out.plan, {
        tools: TOOLS,
        entitySet: session.entitySet,
        capabilityNames: session.grants.names(),
        trusted: true,             // authored by planner/deterministic.js, not by a model
      })
    } catch (e) {
      if (e instanceof PlanRejected) {
        events.emit('security.plan_rejected', { message: e.message })
        return reply(brand.voice.refusedByPolicy, { chips: brand.chips })
      }
      throw e
    }

    if (tr && !tr.plan) tr.plan = { source: 'deterministic', trusted: true, raw: out.plan }
    session.pendingPlan = plan
    const r = await runPlan(plan, {}, { intent: intentName })
    return opts.prefix ? { ...r, reply: opts.prefix + r.reply } : r
  }

  /* ------------------------------------------------------------------ execution */

  async function runPlan (plan, execOpts = {}, opts = {}) {
    const out = kernel.execute(plan, session, execOpts)
    if (tr) tr.kernel = out.trace
    session.history.push(...out.trace.map(t => ({ tool: t.tool, status: t.error ? 'REFUSED' : 'OK' })))

    if (out.status === 'PENDING_CONFIRMATION') {
      return {
        reply: `${out.preview.title}?`,
        chips: [],
        cards: [{ kind: 'confirm', ...out.preview, token: out.token, stepId: out.stepId }],
        status: out.status, trace: out.trace, intent: opts.intent,
      }
    }

    if (out.status === 'REFUSED') return refusal(out, opts)

    const results = Object.values(out.results)
    const list = results.find(r => r.kind === 'productList' || r.kind === 'comparison')
    if (list) session.lastShown = (list.items ?? list.products ?? []).map(p => p.sku).slice(0, 3)

    const generated = await composeOrNull(results)
    // Drop a refused FAQ entirely rather than reciting it. The turn then has no answer,
    // which is honest — and the caller offers help instead of answering a different
    // question than the one asked.
    const usable = abstained ? results.filter(r => r.kind !== 'faqList') : results
    if (abstained && !usable.length) return null
    const cards = usable.filter(r => TEMPLATES[r.kind])
    const text = generated ?? usable.map(r => TEMPLATES[r.kind]?.(r)).filter(Boolean).join(' ')

    return {
      reply: text || brand.voice.abstain,
      chips: [], cards, status: 'OK', trace: out.trace,
      results: out.results, intent: opts.intent,
    }
  }

  // Bounded authority. When a return is refused for being out of window, code — not the
  // model — decides whether a goodwill credit is within the band.
  async function refusal (out, opts) {
    const e = out.reason
    const grant = session.grants.get('order')

    if (grant && (e.name === 'CapabilityDenied' || e.reason === 'OUTSIDE_RETURN_WINDOW')) {
      const order = db.getOrder(grant.value)
      const item = order?.items.find(i => i.lineId === (session.filled.lineItemId ?? 'L1'))
      if (order?.status === 'delivered' && item) {
        const verdict = evaluateGoodwill(order, item, db.getPolicies(), clock())
        if (verdict.eligible) {
          session.grants.mint({
            name: 'credit', subject: `order:${order.id}`, scope: ['credit'],
            value: order.id, mintedAt: clock(), expiresAt: clock() + 600000,
          })
          events.emit('goodwill.auto_approved', { amountCents: verdict.amountCents })
          const plan = parsePlan({ steps: [{ id: 's1', tool: 'issue_store_credit',
            args: { orderId: { ref: '$cap.credit' }, amountCents: { lit: verdict.amountCents } } }] },
          { tools: TOOLS, entitySet: session.entitySet,
            capabilityNames: session.grants.names(), trusted: true })
          session.pendingPlan = plan
          const credit = await runPlan(plan, {}, opts)
          // Lead with the computed dates, not the generic refusal — saying "I can't do
          // that" and then immediately doing something reads as incoherent.
          return { ...credit, reply: `${windowClosedLine(order)} That's only just outside, ` +
            `so I can put it right myself. ${credit.reply}` }
        }
        events.emit('goodwill.refused', { reason: verdict.reason })
        return {
          reply: `${windowClosedLine(order)} That's beyond what I can approve on my own, ` +
            'so let me get a teammate who can look at it.',
          chips: ['Talk to a human'], cards: [], status: 'REFUSED',
          trace: out.trace, refusedReason: verdict.reason,
        }
      }
    }

    const body = refusalFor(e)
    const escalate = ESCALATABLE.has(e.reason) || e.name === 'CapabilityDenied'
    return {
      reply: escalate ? `${body} Let me get a person to look at it.` : body,
      chips: escalate ? ['Talk to a human'] : brand.chips,
      cards: [], status: 'REFUSED', trace: out.trace, refusedReason: e.reason ?? e.name,
    }
  }

  /* -------------------------------------------------------------------- helpers */

  // Real date arithmetic, computed from the record. Never pasted policy prose.
  function windowClosedLine (order) {
    const p = db.getPolicies()
    const past = daysPastWindow(order, p, clock())
    const closed = new Date(
      Date.parse(order.fulfillment.deliveredAt) + p.returnWindowDays * 86400000).toISOString()
    return `That was delivered ${day(order.fulfillment.deliveredAt)}, so the ` +
      `${p.returnWindowDays}-day window closed ${day(closed)} — ${past} days ago.`
  }

  function undoLast () {
    const last = session.ledger.entries().at(-1)
    if (!last) return reply("There's nothing to undo yet.")
    if (!REVERSIBLE.includes(last.tool)) {
      return reply(
        `I can't undo that one — ${last.tool.replace(/_/g, ' ')} is final. A teammate can ` +
        'sort it out if it was a mistake.', { chips: ['Talk to a human'] })
    }
    return reply('Undone.')
  }

  // The composer may rephrase; the firewall guarantees it cannot introduce a fact.
  // A rejection is logged and the deterministic template ships instead.
  async function composeOrNull (results) {
    if (!results.length) return null
    let rejection = null
    abstained = false
    const note = (verdict) => {
      rejection = verdict
      events.emit('security.firewall_rejected', { rejected: verdict.rejected })
      session.lastFirewallRejection = verdict
    }

    // A retrieval answer is a different job from a result summary: it needs citations,
    // claim attribution, and the option to abstain. Routing it through `compose` is what
    // produced "you have a certain amount of time to return most items".
    const faqList = results.find(r => r.kind === 'faqList')
    const generated = faqList
      ? await answerFaq(ai, faqList, session.filled.query ?? '', note)
      : await compose(ai, results, note, session.transcript, session.notes)
    // Abstention has to mean something. The model is asked to reply INSUFFICIENT when the
    // retrieved entries do not answer the question — and then the faqList TEMPLATE printed
    // the top entry verbatim anyway, so "whats todays date" came back with the restock
    // policy. A fallback that ships the very thing the model refused to stand behind is
    // not a fallback.
    if (!generated && rejection?.rejected?.includes('INSUFFICIENT')) abstained = true
    if (tr) {
      tr.compose = generated
        ? { verdict: 'accepted', text: generated }
        : rejection
          ? { verdict: 'rejected', rejected: rejection.rejected, fellBackTo: 'template' }
          // "unavailable" alone could not tell a refused call from a latched adapter from
          // a timeout, so a flat template had no explanation anywhere. The adapter already
          // knows which; record it.
          : { verdict: 'unavailable', fellBackTo: 'template', adapter: ai.status }
    }
    return generated
  }

  /* -------------------------------------------------------------- fallback ladder */

  function ladder () {
    session.misses++
    if (session.misses === 1) return reply(brand.voice.misunderstood, { chips: brand.chips })
    if (session.misses === 2) return reply(brand.voice.narrowing, { chips: brand.chips })
    return route('handoff', { prefix: `${brand.voice.proactiveHandoff} `, reason: 'fallback_exhausted' })
  }

  // Clicking a product card. Previously this re-sent the product's NAME, which
  // reclassified as a fresh product search and returned the same three cards forever.
  // Comparing it against what is already on screen is a real next step.
  // "Give me two of those." The agent builds the basket and hands over a link; the till is
  // on the site. Everything factual in the reply — the id, the prices, the subtotal — comes
  // out of the tool's typed result, so the firewall can check every word of it.
  async function buildBasket (text, qty) {
    const sku = resolveProduct(text, { lastShown: session.lastShown, db }) ?? session.focus
    // Never guess which product someone just committed to buying.
    if (!sku) {
      // But do not ask blind either. "i need a tent" routes here — "need" reads as intent
      // to buy — and asking "which tent?" while showing no tents left the shopper in a
      // loop: every answer they gave routed back to purchase and got asked again. We know
      // the category from what they called it, so show that first and let them point.
      const category = categoryKey(text, vocabulary.category)
        ?? categoryKey(session.notes.lookingFor ?? '', vocabulary.category)
      if (category && !session.lastShown.length) {
        session.filters = { ...session.filters, category }
        return route('recommend')
      }
      return reply(await say('purchase', text, 'Happy to — which one did you want?'), {
        chips: session.lastShown?.length
          ? session.lastShown.map(s => db.getProduct(s)?.name).filter(Boolean)
          : brand.chips,
      })
    }
    session.focus = sku

    const plan = parsePlan({
      steps: [{ id: 's1', tool: 'create_checkout', args: { items: { lit: [{ sku, qty: qty ?? 1 }] } } }],
    }, {
      tools: TOOLS,
      entitySet: session.entitySet,
      capabilityNames: session.grants.names(),
      trusted: true,
    })
    session.pendingPlan = plan
    return runPlan(plan, {}, { intent: 'purchase' })
  }

  async function pickFocused (sku) {
    const skus = [sku, ...(session.lastShown ?? []).filter(s => s !== sku)].slice(0, 3)
    if (skus.length < 2) {
      return reply('Good pick. Anything you want to know about it before you decide?')
    }
    session.filled.skus = skus
    return route('compare', { skus })
  }

  async function pick (sku) {
    startTrace(`[picked ${sku}]`)
    session.focus = sku
    return finishTrace(await pickFocused(sku))
  }

  return { turn, pick, session, ladder }
}
