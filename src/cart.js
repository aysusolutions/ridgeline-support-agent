// Wiring only. No logic lives in this file — see ui/cart.js.
import { createDb } from './backend/db.js'
import { mountCart } from './ui/cart.js'

// The same persisted ledger the chat writes to. Without storage the basket built in the
// widget would not exist here, and the link would open onto nothing.
const db = createDb(null, { storage: localStorage })

mountCart(document.getElementById('cart-root'), db, { search: location.search })

globalThis.ridgeline = { db }
