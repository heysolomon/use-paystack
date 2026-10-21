# use-paystack

Paystack checkout for React 18 and 19, plus server helpers to initialize transactions, verify payments and receive webhooks.

- Safe in Next.js, Remix and any other server-rendered app: nothing touches `window` until a customer clicks Pay.
- A promise-based hook that resolves to `success`, `pending` or `cancelled`.
- Pending bank transfers are reported as `pending`, never as a cancel.
- `use-paystack/server` works on Node 18+, Deno, Bun, Cloudflare Workers and the Next.js edge runtime.
- Written in TypeScript, ships ESM and CJS.

```bash
npm install use-paystack
```

## Why this exists

[react-paystack](https://github.com/iamraphson/react-paystack) is the library Paystack's docs link to. It has three problems this package fixes.

1. **It crashes server rendering.** `@paystack/inline-js` reads `window` the moment it is imported. In Node, `require('@paystack/inline-js')` throws `window is not defined`. react-paystack imports it at the top of the module, so Next.js prerendering and SSR fail. use-paystack never imports inline-js at the top level. It loads it with a cached dynamic `import()`, only in the browser, inside an effect or a click handler. If that load fails (a flaky network, say), the cache is cleared so the next click retries.
2. **It stops at React 18.** Its peer dependencies don't include React 19. use-paystack supports `react@^18.0.0 || ^19.0.0`.
3. **It reports pending bank transfers as cancels.** When a customer pays by bank transfer and Paystack hasn't confirmed it yet, inline-js calls `onCancel` first and only then calls `onBankTransferConfirmationPending`. So your cancel handler runs for a customer who has actually sent money. use-paystack settles a cancel on the next tick, so a pending signal that follows it wins. You get `{ status: 'pending' }`.

## Quick start

```tsx
'use client'
import { usePaystack } from 'use-paystack'

export function PayButton() {
  const { pay, isOpen } = usePaystack({ publicKey: process.env.NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY! })

  async function handleClick() {
    try {
      const result = await pay({
        email: 'ada@example.com',
        amount: 500000, // NGN 5,000 in kobo
        currency: 'NGN',
      })

      if (result.status === 'success') {
        // Confirm on your server before you fulfil the order. See "Verify on the server".
        await fetch(`/api/paystack/verify?reference=${result.reference}`)
      } else if (result.status === 'pending') {
        // Bank transfer sent, not yet confirmed. See "Pending payments".
      } else {
        // status === 'cancelled': the customer closed checkout.
      }
    } catch (error) {
      // PaystackError: the script failed to load, the options were invalid, etc.
    }
  }

  return (
    <button onClick={handleClick} disabled={isOpen}>
      Pay NGN 5,000
    </button>
  )
}
```

Or use the button component:

```tsx
'use client'
import { PaystackButton } from 'use-paystack'

<PaystackButton
  publicKey={process.env.NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY!}
  options={{ email: 'ada@example.com', amount: 500000 }}
  onSuccess={(result) => console.log('paid', result.reference)}
  onPending={(result) => console.log('awaiting transfer', result.reference)}
  onCancel={() => console.log('closed')}
  onError={(error) => console.error(error.code, error.message)}
  className="btn"
>
  Pay NGN 5,000
</PaystackButton>
```

`amount` is always in the lowest currency unit: kobo for NGN, pesewas for GHS, cents for ZAR, KES and USD. NGN 5,000 is `500000`. Decimals are rejected.

## Recommended: initialize on the server

With `pay()`, the amount comes from the browser, and a customer can change it before checkout opens. The safer flow fixes the amount on your server, where the customer can't touch it:

1. Your server calls `initializeTransaction` with the price from your database.
2. The browser opens checkout with `resume(accessCode)`.
3. Your server verifies the reference (and/or receives the webhook) before it fulfils the order.

### Next.js App Router example

```ts
// app/checkout/actions.ts
'use server'
import { initializeTransaction } from 'use-paystack/server'
import { db } from '@/lib/db'

export async function startCheckout(orderId: string) {
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId } })

  const { accessCode, reference } = await initializeTransaction(
    {
      email: order.email,
      amount: order.totalKobo, // from your database, never from the client
      currency: 'NGN',
      metadata: { orderId },
    },
    { secretKey: process.env.PAYSTACK_SECRET_KEY! },
  )

  await db.order.update({ where: { id: orderId }, data: { reference } })
  return { accessCode }
}
```

```tsx
// app/checkout/pay-button.tsx
'use client'
import { usePaystack } from 'use-paystack'
import { startCheckout } from './actions'

export function PayButton({ orderId }: { orderId: string }) {
  const { resume, isOpen } = usePaystack({ publicKey: process.env.NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY! })

  async function handleClick() {
    const { accessCode } = await startCheckout(orderId)
    const result = await resume(accessCode)

    if (result.status === 'success') window.location.href = `/orders/${orderId}`
    if (result.status === 'pending') window.location.href = `/orders/${orderId}?awaiting=transfer`
  }

  return (
    <button onClick={handleClick} disabled={isOpen}>
      Pay now
    </button>
  )
}
```

The button component works too: `<PaystackButton publicKey={...} accessCode={accessCode} onSuccess={...} />`.

If you prefer a route handler to a server action, call `initializeTransaction` from `app/api/paystack/initialize/route.ts` and `fetch` it from the client in the same way.

## Verify on the server

Never fulfil an order because the browser said `success`. Ask Paystack, and check that the amount and currency are what you charged:

```ts
// app/api/paystack/verify/route.ts
import { verifyTransaction } from 'use-paystack/server'
import { db } from '@/lib/db'

export async function GET(request: Request) {
  const reference = new URL(request.url).searchParams.get('reference')
  if (!reference) return Response.json({ error: 'reference is required' }, { status: 400 })

  const order = await db.order.findUniqueOrThrow({ where: { reference } })
  const { paid, status, mismatch } = await verifyTransaction(reference, {
    secretKey: process.env.PAYSTACK_SECRET_KEY!,
    expected: { amount: order.totalKobo, currency: 'NGN' },
  })

  if (paid) await db.order.update({ where: { reference }, data: { status: 'paid' } })
  return Response.json({ paid, status, mismatch })
}
```

`paid` is `true` only when the status is `success` and the amount and currency match `expected`. If the customer paid the wrong amount, `paid` is `false` and `mismatch` says what differed. Leaving out `expected` only checks the status, so always pass it.

## Webhooks

Paystack sends a `charge.success` event when a payment completes, including bank transfers confirmed after the customer left your site. This is the most reliable way to know an order is paid.

```ts
// app/api/paystack/webhook/route.ts
import { parseWebhookEvent, verifyTransaction } from 'use-paystack/server'
import { db } from '@/lib/db'

const secretKey = process.env.PAYSTACK_SECRET_KEY!

export async function POST(request: Request) {
  // Read the raw body first. The signature covers the exact bytes Paystack sent,
  // so request.json() followed by JSON.stringify would not match.
  const rawBody = await request.text()

  let event
  try {
    event = await parseWebhookEvent(rawBody, request.headers.get('x-paystack-signature'), secretKey)
  } catch {
    return new Response('Invalid signature', { status: 401 })
  }

  if (event.event === 'charge.success' && event.data.reference) {
    const order = await db.order.findUnique({ where: { reference: event.data.reference } })
    if (order && order.status !== 'paid') {
      const { paid } = await verifyTransaction(event.data.reference, {
        secretKey,
        expected: { amount: order.totalKobo, currency: 'NGN' },
      })
      if (paid) await db.order.update({ where: { id: order.id }, data: { status: 'paid' } })
    }
  }

  return new Response('ok')
}
```

Paystack retries a webhook until you return `200`, so make the handler idempotent (the `status !== 'paid'` check above) and respond quickly. Set the webhook URL in your Paystack dashboard under Settings > API Keys & Webhooks.

`verifyWebhookSignature(rawBody, signature, secretKey)` returns a boolean if you'd rather parse the body yourself. Both use Web Crypto (HMAC-SHA512 with a constant-time compare), so they run on the edge runtime as well as Node.

## Pending payments

`{ status: 'pending' }` means the customer chose bank transfer and told Paystack they've sent the money, but Paystack hasn't confirmed it yet. The money is probably on its way.

- **Never treat pending as a cancel.** Don't release the cart, show "payment failed" or let the customer pay twice.
- Show "We're confirming your transfer", and keep the order in an awaiting-payment state.
- Fulfil the order when the `charge.success` webhook arrives, or re-verify the reference later with `verifyTransaction`.

Every payment has a reference you can verify, including a pending one. If you don't pass `reference` to `pay()`, use-paystack generates one and returns it in the result. For `resume()`, the reference comes from `initializeTransaction` on your server.

## API

### `usePaystack({ publicKey, preload = true })`

Returns `{ pay, resume, isOpen, isReady }`.

| | |
| --- | --- |
| `pay(options)` | Opens checkout for a new transaction. Returns `Promise<PaystackResult>`. |
| `resume(accessCode)` | Opens checkout for a transaction initialized on your server. Returns `Promise<PaystackResult>`. |
| `isOpen` | `true` while checkout is open. |
| `isReady` | `true` once inline-js has loaded. With `preload: true` (the default) it starts loading after mount, so the first click is faster. |

```ts
type PaystackResult =
  | { status: 'success'; reference: string; transactionId?: number; message?: string }
  | { status: 'pending'; reference?: string; transactionId?: number; accessCode?: string }
  | { status: 'cancelled'; reference?: string }
```

A customer closing checkout is a result, not an error. Failures reject with a `PaystackError` whose `code` is one of:

| Code | Meaning |
| --- | --- |
| `invalid_options` | Validation failed before anything loaded: a secret key, a non-integer amount, a bad email or reference. |
| `load_failed` | inline-js could not be downloaded. The next call retries. |
| `checkout_error` | inline-js reported an error (for example an invalid key or a declined setup). |
| `already_open` | `pay` or `resume` was called while checkout was already open. |
| `not_in_browser` | Called during server rendering. |

### Options

Option names match [`@paystack/inline-js`](https://github.com/PaystackHQ/inline-js) exactly:

`email`, `amount`, `currency`, `reference`, `firstName`, `lastName`, `phone`, `customerCode`, `channels`, `metadata` (with `custom_fields` to show on the dashboard), `planCode`, `subscriptionCount`, `planInterval`, `subscriptionLimit`, `subscriptionStartDate`, `subaccountCode`, `split_code`, `bearer`, `transactionCharge`, `paymentRequest`, `paymentPage`, and `onLoad`.

Checked before checkout opens:

- The key must be a public key (`pk_test_...` or `pk_live_...`). A secret key (`sk_...`) is rejected with a message telling you to rotate it, because it has already been exposed.
- `amount` must be a positive integer in the lowest currency unit. It may be left out when `planCode` is set.
- `email` must be valid unless `customerCode` is given.
- `reference` may only contain letters, numbers, `-`, `.` and `=`.

### `<PaystackButton>`

A plain `<button>` that takes every normal button prop, plus:

| Prop | |
| --- | --- |
| `publicKey` | Required. |
| `options` | Transaction options, or a function returning them, called at click time. |
| `accessCode` | Use instead of `options` for a server-initialized transaction. |
| `onSuccess`, `onPending`, `onCancel` | Receive the matching `PaystackResult`. |
| `onError` | Receives a `PaystackError`. Errors are logged to the console if you don't pass it. |
| `preload` | Defaults to `true`. |

While checkout is open the button is `disabled` and has `aria-busy="true"`. If your own `onClick` calls `event.preventDefault()`, checkout does not open.

### `use-paystack/server`

No React and no browser globals.

| | |
| --- | --- |
| `initializeTransaction(params, { secretKey })` | `POST /transaction/initialize`. Returns `{ accessCode, authorizationUrl, reference }`. `params` uses the REST API's field names (`email`, `amount`, `currency`, `reference`, `callback_url`, `plan`, `metadata`, `channels`, `split_code`, `subaccount`, ...). |
| `verifyTransaction(reference, { secretKey, expected? })` | `GET /transaction/verify/:reference`. Returns `{ paid, status, mismatch?, transaction }`. |
| `verifyWebhookSignature(rawBody, signature, secretKey)` | Resolves `true` if the `x-paystack-signature` header matches. |
| `parseWebhookEvent(rawBody, signature, secretKey)` | Verifies, then parses. Throws `PaystackSignatureError` on a bad signature. |
| `createPaystack({ secretKey, fetch?, baseUrl? })` | Returns all four helpers bound to one key. |

API failures throw `PaystackApiError` with `status` (HTTP status) and `body` (the parsed response). Passing a public key (`pk_...`) where a secret key belongs throws straight away.

```ts
import { createPaystack } from 'use-paystack/server'

export const paystack = createPaystack({ secretKey: process.env.PAYSTACK_SECRET_KEY! })

await paystack.verifyTransaction(reference, { expected: { amount: 500000, currency: 'NGN' } })
```

## Migrating from react-paystack

| react-paystack | use-paystack |
| --- | --- |
| `usePaystackPayment(config)` returning `initializePayment({ onSuccess, onClose })` | `usePaystack({ publicKey })` returning `pay(options)`, which resolves to a result |
| `onSuccess(response)` | `result.status === 'success'` (or the button's `onSuccess`) |
| `onClose()` | `result.status === 'cancelled'` (or the button's `onCancel`) |
| Pending bank transfer reported through `onClose` | `result.status === 'pending'` (or the button's `onPending`) |
| `<PaystackButton {...config} text="Pay" onSuccess onClose />` | `<PaystackButton publicKey options={...} onSuccess onCancel onPending>Pay</PaystackButton>` |
| `<PaystackConsumer>` | `usePaystack` |
| `firstname`, `lastname` | `firstName`, `lastName` |
| `plan`, `quantity` | `planCode`, `subscriptionCount` |
| `subaccount`, `transaction_charge` | `subaccountCode`, `transactionCharge` |
| `reference` required for verification | Generated automatically when omitted |
| Crashes on SSR, needed `next/dynamic` with `ssr: false` | Import it normally |

Before:

```tsx
const initializePayment = usePaystackPayment({ publicKey, email, amount, reference })
initializePayment({ onSuccess: (res) => verify(res.reference), onClose: () => setCancelled(true) })
```

After:

```tsx
const { pay } = usePaystack({ publicKey })
const result = await pay({ email, amount, reference })
if (result.status === 'success') verify(result.reference)
else if (result.status === 'pending') showAwaitingTransfer(result.reference)
else setCancelled(true)
```

## Development

```bash
npm install
npm run verify   # typecheck, tests, build, then smoke-test the built files in Node
```

The project is pinned to TypeScript 6 because TypeScript 7 has no JavaScript compiler API, which tsup needs to generate type declarations.

## License

MIT © Solomon Akuson
