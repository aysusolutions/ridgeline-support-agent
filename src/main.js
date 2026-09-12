// Wiring only. No logic lives in this file.
import { createDb } from './backend/db.js'
import { createAgent } from './dialog/turn.js'
import { createMemory } from './dialog/memory.js'
import { createAdapter } from './ai/adapter.js'
import { nullAdapter } from './ai/nullAdapter.js'
import { mountStorefront } from './ui/storefront.js'
import { mountWidget } from './ui/widget.js'
import { mountTrace } from './ui/trace.js'

// Persisted, so a basket built in the chat still exists when the checkout link opens in
// another tab, and the order that comes back is one the agent can then track.
const db = createDb(null, { storage: localStorage })

// The adapter posts to /api/llm, which holds the key. With no function deployed the
// endpoint 404s, the adapter returns null, and the deterministic path takes over — the
// page behaves identically, just in template voice.
const ai = location.protocol === 'file:' ? nullAdapter : createAdapter()

// Preferences across visits, never authority: no grant, no pending plan, no confirmation
// token and nothing about which order was verified ever reaches storage. See memory.js.
const memory = createMemory({ storage: localStorage })
const agent = createAgent({ db, ai, memory })

// The trace panel is a fixed overlay and mounts on <body>. It must NOT share a root with
// the widget, which clears its own container on mount.
const trace = mountTrace(document.body)
const widget = mountWidget(document.getElementById('widget-root'), agent, {
  onTrace: (out, opts) => trace.update(out, opts),
  memory,
})
mountStorefront(document.getElementById('storefront'), db, { onOpenChat: () => widget.open() })

// Exposed for the demo and for manual poking in devtools. Read-only from the page's
// point of view — the kernel is still the only thing that can execute a tool.
globalThis.ridgeline = { db, agent, widget }
console.info('ridgeline: ready')
