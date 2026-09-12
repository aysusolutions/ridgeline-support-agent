# Checkout links

**Date:** 2026-08-07
**Status:** implemented 2026-08-08. Four things changed during the build; each is marked
**[built]** below where it differs from what was designed.

The agent can build a basket from products the shopper has chosen and hand back a
working checkout link. Payment still happens on the site — the agent never takes money.

## Why this needs a design at all

"No cart, no checkout" was a stated non-goal, and the purchase route currently declines
outright. Reversing that touches three invariants the rest of the system rests on:

- **Code owns every fact.** A price or a total that came from the model is a bug.
- **The provenance firewall** already treats URLs as fact-shaped atoms
  (`/\bhttps?:\/\/[^\s)]+/g` in `src/ai/firewall.js`), so a link the model invents is
  rejected today. A real link has to arrive via a typed tool result.
- **`verifyNoFalseAction`** rejects any claim of a deed when the turn wrote nothing to
  the ledger. "Your basket is ready" is only sayable if a basket really exists.

The design below satisfies all three rather than working around them.

## Decisions

| # | Decision | Rejected alternative |
|---|---|---|
| 1 | Link points at a cart page inside this demo | An external configurable URL, which is a dead link here |
| 2 | Creating a link **writes** a `CART-####` record | A stateless URL, which would make "I made you a basket" a false claim |
| 3 | No confirm tap | A preview/confirm gate like `cancel_order`, unnecessary for something reversible |
| 4 | Size and colour are chosen on the cart page | Slot-filling them first, which adds two turns before any link appears |
| 5 | Pay creates a real trackable order | A stub notice, which leaves the link at a dead end |
| 6 | The ledger persists to `localStorage` | In-page cart view (not a real link) or URL-encoded state (breaks tracking) |

## 1. Storage

`src/backend/db.js` gains an optional storage adapter:

```js
createDb(seed, { storage })   // [built] the first argument is already the seed
```

With no `storage` the behaviour is byte-for-byte what it is today, so the existing 403
tests are unaffected and keep running in memory.

- Key: `ridgeline:ledger:v1`.
- First load seeds from JSON and writes. Later loads rehydrate. `mutate()` mirrors after
  each change.
- **Only mutable records persist:** `orders` and `carts`. Products stay static config —
  persisting them would mean an edit to `products.json` silently stops taking effect.
- Corrupt JSON, or a `v1` mismatch, falls back to the seed rather than throwing. A demo
  that will not boot because of a stale key is worse than one that resets.

### Durable id counter

`session.seq` resets on reload, so a persisted `CART-1001` could be minted twice. Carts
and orders take their ids from a counter stored in the ledger, via `db.nextId(prefix)`.
**[built]** The counter is per-prefix, and the floor for `RO` is *derived* from the orders
already on file rather than hardcoded — so changing `orders.json` cannot silently create a
collision with a fixture.
Ticket, RMA, claim and credit ids stay session-scoped exactly as they are now — they do
not outlive the conversation, so they cannot collide.

## 2. `TOOLS.create_checkout`

```js
args: { items: [{ sku, qty }] }
scope: null                                          // [built] was 'checkout'
subject: () => null                                  // [built]
consequential: false                                 // [built] was true
preconditions: ['stock_available']                   // qty >= 1, <= stock, <= maxQtyPerLine
idemKey: a => `checkout:${sig(a.items)}`             // same request returns the same cart
```

**[built]** Two corrections, both about what these fields mean in *this* kernel:

- `consequential: true` does not mean "it writes" — it means **halt for a confirm tap**
  (`kernel.js` gate 6 returns `PENDING_CONFIRMATION` and calls `tool.preview`). Decision 3
  says no confirm tap, so the flag is `false`. `subscribe_restock` and
  `create_handoff_ticket` are the precedent: they produce records, carry an `idemKey`, and
  are not `consequential`.
- `scope: 'checkout'` would demand a capability grant, and there is nothing to verify
  ownership of — no order, no PII. `scope: null` with a null subject is the honest shape,
  and it also means the tool can never hold authority over an order.

Returns a typed result, never prose:

```js
{ kind: 'checkout',
  cartId: 'CART-1001',
  url: '/cart.html?id=CART-1001',
  items: [{ sku, name, qty, unitPriceCents, lineTotalCents }],
  subtotalCents, currency: 'USD', expiresAt }
```

`sig(items)` is a stable signature: SKUs uppercased, sorted, joined as `SKU:qty` pairs with
commas — so `[{B,1},{A,2}]` and `[{A,2},{B,1}]` share one idempotency key. `expiresAt` is
an ISO-8601 UTC string.

**Prices are computed from the product record. Any price present in `args` is ignored** —
the same rule that makes `cancel_order` compute its own refund instead of trusting one.

`cartId` and `subtotalCents` appearing in the typed result is precisely what lets the
firewall accept them in prose. The `url` is relative, so it is not matched by the URL atom
pattern at all; the button takes its `href` from this field rather than from anything the
model wrote.

The tool is invoked through the kernel like every other tool, so the resolve, taint,
capability, precondition and idempotency gates all apply. Nothing calls `execute` directly.

New precondition `stock_available` lives in `src/kernel/preconditions.js` alongside the
existing ones.

### Config

`src/config/brand.js` gains:

```js
brand.checkout = {
  path: '/cart.html',
  ttlHours: 24,
  maxQtyPerLine: 10,
}
```

## 3. Routing the purchase intent

`case 'purchase'` in `src/dialog/turn.js` stops declining unconditionally:

1. **SKU** from the existing `resolveProduct(text, { lastShown, db })`, falling back to
   `session.focus`.
2. **Quantity** from `notes.quantity`, already validated to 1–99 in `router.js`.
   Default 1.
3. **No SKU resolvable → ask which one.** It must not guess a product.
4. **Over a limit → state the real number** and offer the maximum. Two limits can bind:
   available stock, and `maxQtyPerLine`. The refusal names **whichever one binds**, with the
   actual figure. Code owns that figure; the model only phrases it.
5. Otherwise create the basket and reply with a `checkout` card.

`brand.voice.cannotSell` survives as the no-model fallback and as the reply when a basket
genuinely cannot be built.

## 4. Surface

**Widget** — a new `checkout` card kind in `src/ui/widget.js`: line items, subtotal, and an
`[ Open checkout ]` anchor with `target="_blank" rel="noopener"` so the conversation stays
open. The `href` comes from the typed result.

**Cart page** — `cart.html` plus `src/ui/cart.js`:

- Reads `?id=`, opens the persisted ledger, renders the lines.
- Offers size and colour from `product.attrs`. The chosen values are written to the order
  item's existing `variant` field at Pay, not stored on the cart — so a cart is never in a
  half-configured state.
- Expiry is checked against `Date.now()` on this page. The injectable `clock()` belongs to
  the agent; a static page has no session to thread it through.
- `[ Pay ]` writes an `RO-####` order — status `processing`, `placedAt` now, fixture
  `Visa`/`4291` payment and fixture `shipTo` — marks the cart `ordered` with its
  `orderId`, and shows the new order id with a link back to the chat.
- An unknown, expired or already-ordered cart shows a plain notice, not an error.

**No server change.** Linking to `/cart.html` rather than `/cart` keeps `tools/serve.mjs`
untouched.

## 5. Two statements that become lies

Both must change in the same commit, or the agent starts contradicting itself:

- `agentFacts` in `src/config/brand.js` currently says it cannot *"add anything to a
  basket"*. It can now — it must say it builds a basket but cannot take payment.
- The `purchase` block in the `converse` prompt (`src/ai/prompts.js`) says *"you cannot
  take an order"*. Same correction: it cannot take **payment**.

`verifyNoFalseAction` needs no change. This path genuinely writes, so it is called with
`true` and an honest "your basket is ready" passes — which is the entire reason decision 2
chose a record over a bare URL.

## 6. Tests

**Tool**
- Price comes from the product record, not from `args`.
- Unknown SKU refused.
- `qty` of 0, negative, above stock, and above `maxQtyPerLine` all refused.
- A product with **zero** stock (`LIN-SILK-R`, the Silk Bag Liner, is 0 in the fixtures)
  refuses cleanly and does not offer a maximum of 0 — "you can have 0 of these" is not a
  reply. It should say the item is out of stock and offer the back-in-stock notification
  that `subscribe_restock` already provides.
- The same request twice returns the same `cartId` (idempotency).

**Storage**
- Rehydrate round-trip preserves orders and carts.
- Corrupt JSON falls back to the seed.
- `createDb()` with no storage is unchanged (the existing suite is the assertion).
- No id collision across a simulated reload.

**Expiry**
- A cart past `ttlHours` is refused by the cart page.

**Prose**
- The firewall accepts the real `cartId` and subtotal.
- The firewall rejects an invented total, **and an invented `CART-####`**. Writing that
  second assertion found a real gap: `CART` was not in the firewall's record-identifier
  pattern, so a made-up basket id was not fact-shaped and passed unchecked. Fixed in
  `src/ai/firewall.js`.
- `verifyNoFalseAction` passes on this path because the ledger changed.

**Turn**
- `"give me 2 of those"` after products are shown produces the right SKU and quantity.
- `"give me 50 ridgeline hikers"` refuses on `maxQtyPerLine` and names 10 — the per-line
  cap binds first there, because that product has 13 in stock.
- `"give me 5 ultralight tents"` refuses on **stock** and names 4 — that product has 4, so
  stock is the binding limit. Both cases exist so the "whichever binds" rule is actually
  exercised rather than assumed.
- `agentFacts` no longer claims it cannot build a basket.

**Browser**
- chat → link → cart page → Pay → track the resulting order in the chat.

**Prompt budget** — `converse` is at 374 of its 400-token budget. The `purchase` block is
being reworded, not grown; if the guard test in `tests/unit/ai.test.mjs` fails, the wording
gets tightened rather than the budget raised.

## Accepted limitation — **[built: reversed]**

The design accepted that Pay would not decrement stock. It does.

The objection was real — products are not persisted, so a decrement would vanish on reload,
and persisting the catalogue would mean edits to `products.json` stop taking effect. The way
out is to persist only a **per-SKU overlay** of what has been *consumed*
(`stockDelta: { [sku]: -n }`), never the stock figure itself. Effective stock is applied in
`getProduct` and `searchProducts`, so the storefront, the recommender, `variant_in_stock`
and `sku_out_of_stock` all see the smaller number with no changes of their own — and a SKU
bought down to zero becomes restock-subscribable for free.

Stock is consumed at **Pay**, not when the basket is built: gear nobody paid for stays on
the shelf.

## Out of scope

- Taking payment. The card details on the resulting order are fixtures.
- Discounts, promotion codes, tax and shipping calculation. `subtotalCents` only.
- Multiple concurrent baskets per session. One live cart at a time: creating a basket marks
  any earlier open cart `superseded`, so an old link cannot be paid twice. An identical
  request is *not* a new basket — idempotency returns the existing one.
- Editing a basket by conversation ("make it 3 instead"). Create a new one.
