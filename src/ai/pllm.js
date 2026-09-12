// The privileged planner.
//
// buildPlannerPayload is the ONLY function that decides what the planner sees. Anything
// added here that derives from a record breaks the indirect-injection defence and fails
// the isolation test in tests/unit/isolation.test.mjs. Read that test before editing.
//
// The tool catalogue is PASSED IN, not imported: src/ai may not reach into src/kernel.

export function buildPlannerPayload (session, sanitizedText, toolCatalogue) {
  return {
    userMessage: sanitizedText,

    // Names and scopes only. The kernel holds the values; the model holds the handles.
    capabilities: session.grants.manifest(),

    // User-originated values only — this is what a {lit:} is validated against.
    knownEntities: [...session.entitySet],

    // Prior turns as structure, not content. The planner learns that lookup_order
    // succeeded, never what it returned.
    history: (session.history ?? []).slice(-6).map(h => ({ tool: h.tool, status: h.status })),

    tools: Object.entries(toolCatalogue).map(([name, t]) => ({
      name,
      consequential: t.consequential,
      args: Object.fromEntries(Object.entries(t.args).map(([k, v]) => [
        k, { type: v.type, enum: v.enum, required: !!v.required },
      ])),
    })),
  }
}

export async function proposePlan (adapter, session, sanitizedText, toolCatalogue) {
  const raw = await adapter.run('plan', buildPlannerPayload(session, sanitizedText, toolCatalogue))
  if (!raw) return null
  try {
    // Strip a markdown fence if the model wrapped it despite instructions.
    const cleaned = String(raw).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
    return JSON.parse(cleaned)
  } catch {
    return null            // parsePlan does the real validation; this only shapes.
  }
}
