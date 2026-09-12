// The Plan AST grammar. Deliberately tiny: no loops, no conditionals, no expressions,
// nothing Turing-complete. An un-analysable plan language is itself an attack surface,
// so every addition here has to be justified against that.

export const MAX_STEPS = 4
export const MAX_CONSEQUENTIAL = 1

export class PlanRejected extends Error {
  constructor (msg) { super(msg); this.name = 'PlanRejected' }
}

const REF_CAP = /^\$cap\.([a-z_][a-z0-9_]*)$/
const REF_STEP = /^\$(s\d+)\.([A-Za-z0-9_]+(?:(?:\.[A-Za-z0-9_]+)|(?:\[\d+\]))*)$/

// `trusted` says who authored this plan.
//
// The literal-provenance rule exists to stop the MODEL inventing a value — an order id it
// hallucinated, or a number it read out of a poisoned record field. A plan built by
// planner/deterministic.js was assembled by our own code from slots that already passed
// entity extraction, so that rule is not just unnecessary there, it is impossible to
// satisfy: structured arguments like `filters` are objects and can never be "in the
// entity set".
//
// Defaults to false. An LLM plan must ALWAYS be parsed with trusted:false, and is
// additionally barred from expressing object or array literals at all.
export function parsePlan (raw, { tools, entitySet, capabilityNames, trusted = false }) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.steps)) {
    throw new PlanRejected('plan shape: expected { steps: [...] }')
  }
  if (raw.steps.length === 0) throw new PlanRejected('plan shape: no steps')
  if (raw.steps.length > MAX_STEPS) {
    throw new PlanRejected(`too many steps: ${raw.steps.length} > ${MAX_STEPS}`)
  }

  const seen = new Set()
  let consequential = 0

  for (const step of raw.steps) {
    if (!step || typeof step !== 'object' ||
        typeof step.id !== 'string' || typeof step.tool !== 'string' ||
        !step.args || typeof step.args !== 'object' || Array.isArray(step.args)) {
      throw new PlanRejected('plan shape: malformed step')
    }
    if (seen.has(step.id)) throw new PlanRejected(`duplicate step id ${step.id}`)

    const tool = tools[step.tool]
    if (!tool) throw new PlanRejected(`unknown tool "${step.tool}"`)
    if (tool.consequential && ++consequential > MAX_CONSEQUENTIAL) {
      throw new PlanRejected('more than one consequential step in a plan')
    }

    for (const [name, spec] of Object.entries(step.args)) {
      const schema = tool.args[name]
      if (!schema) throw new PlanRejected(`unknown argument "${name}" for ${step.tool}`)
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        throw new PlanRejected(`argument form for "${name}": expected { lit } or { ref }`)
      }

      const forms = ['lit', 'ref'].filter(f => f in spec)
      if (forms.length !== 1) {
        throw new PlanRejected(`argument form for "${name}": expected exactly one of lit|ref`)
      }

      if ('lit' in spec) {
        const v = spec.lit
        if (!trusted) {
          // A model literal must be a scalar the USER supplied, or a value from the
          // tool's own closed enum. Structured literals are refused outright — an object
          // is a place to smuggle a value past the entity check.
          if (v !== null && typeof v === 'object') {
            throw new PlanRejected(`literal for "${name}" may not be an object or array`)
          }
          const inEnum = Array.isArray(schema.enum) && schema.enum.includes(v)
          const inEntities = entitySet.has(String(v))
          if (!inEnum && !inEntities) {
            throw new PlanRejected(
              `literal for "${name}" is not user-originated and not an enum member`)
          }
        }
      } else {
        if (typeof spec.ref !== 'string') throw new PlanRejected(`unresolvable ref for "${name}"`)
        const capMatch = REF_CAP.exec(spec.ref)
        const stepMatch = REF_STEP.exec(spec.ref)
        if (capMatch) {
          if (!capabilityNames.includes(capMatch[1])) {
            throw new PlanRejected(`unknown capability "${capMatch[1]}"`)
          }
        } else if (stepMatch) {
          if (!seen.has(stepMatch[1])) throw new PlanRejected(`forward reference to ${stepMatch[1]}`)
        } else {
          throw new PlanRejected(`unresolvable ref "${spec.ref}"`)
        }
      }
    }

    for (const required of Object.keys(tool.args).filter(k => tool.args[k].required)) {
      if (!(required in step.args)) {
        throw new PlanRejected(`missing required argument "${required}" for ${step.tool}`)
      }
    }

    seen.add(step.id)
  }

  return {
    steps: raw.steps.map(s => ({
      id: s.id,
      tool: s.tool,
      args: Object.fromEntries(Object.entries(s.args).map(([k, v]) => [k, { ...v }])),
    })),
  }
}
