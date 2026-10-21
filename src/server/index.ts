// Server helpers for Paystack. No React and no browser globals: runs on
// Node 18+, Deno, Bun, Cloudflare Workers and the Vercel/Next.js edge runtime.

export const DEFAULT_BASE_URL = 'https://api.paystack.co'

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface PaystackServerOptions {
  /** Your Paystack secret key (sk_test_... or sk_live_...). Keep it on the server. */
  secretKey: string
  /** Custom fetch, for tests or instrumentation. Defaults to the global fetch. */
  fetch?: FetchLike
  /** Defaults to https://api.paystack.co */
  baseUrl?: string
}

/** The Paystack API answered with an error, or an unexpected body. */
export class PaystackApiError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.name = 'PaystackApiError'
    this.status = status
    this.body = body
  }
}

/** The webhook signature did not match. Treat the request as forged. */
export class PaystackSignatureError extends Error {
  constructor(message = 'Invalid Paystack webhook signature.') {
    super(message)
    this.name = 'PaystackSignatureError'
  }
}

function assertSecretKey(secretKey: unknown): asserts secretKey is string {
  if (typeof secretKey !== 'string' || secretKey.trim() === '') {
    throw new TypeError('A Paystack secret key is required (sk_test_... or sk_live_...).')
  }
  if (secretKey.startsWith('pk_')) {
    throw new TypeError(
      'You passed a Paystack PUBLIC key where the secret key is needed. Use your sk_test_ or sk_live_ key, ' +
        'loaded from an environment variable on the server.',
    )
  }
}

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  options: PaystackServerOptions,
  body?: unknown,
): Promise<T> {
  assertSecretKey(options.secretKey)
  const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')

  const response = await doFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${options.secretKey}`,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  const text = await response.text()
  let json: unknown
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    json = text
  }

  const envelope = json as { status?: boolean; message?: string; data?: T } | undefined
  if (!response.ok || !envelope || typeof envelope !== 'object' || envelope.status === false) {
    const message =
      envelope && typeof envelope === 'object' && typeof envelope.message === 'string'
        ? envelope.message
        : `Paystack API request failed with HTTP ${response.status}`
    throw new PaystackApiError(message, response.status, json)
  }
  return envelope.data as T
}

// Initialize

/**
 * Body for POST /transaction/initialize. Field names follow the Paystack REST
 * API (snake_case). Any other documented field can be passed through.
 */
export interface InitializeTransactionParams {
  email: string
  /** Lowest currency unit (kobo for NGN). Positive integer. Optional when `plan` is set. */
  amount?: number
  currency?: string
  reference?: string
  callback_url?: string
  plan?: string
  invoice_limit?: number
  metadata?: Record<string, unknown>
  channels?: string[]
  split_code?: string
  subaccount?: string
  transaction_charge?: number
  bearer?: 'account' | 'subaccount'
  [key: string]: unknown
}

export interface InitializeTransactionResult {
  accessCode: string
  authorizationUrl: string
  reference: string
}

/**
 * Starts a transaction on your server. The amount is fixed here, where the
 * customer cannot change it; pass `accessCode` to `resume()` in the browser.
 */
export async function initializeTransaction(
  params: InitializeTransactionParams,
  options: PaystackServerOptions,
): Promise<InitializeTransactionResult> {
  if (!params || typeof params.email !== 'string' || !params.email) {
    throw new TypeError('initializeTransaction needs a customer email.')
  }
  if (params.amount === undefined ? !params.plan : !Number.isSafeInteger(params.amount) || params.amount <= 0) {
    throw new TypeError(
      'amount must be a positive integer in the lowest currency unit (kobo for NGN), unless plan is set.',
    )
  }
  const { metadata, ...rest } = params
  const body = {
    ...rest,
    // The API documents metadata as a JSON string.
    ...(metadata !== undefined ? { metadata: JSON.stringify(metadata) } : {}),
  }
  const data = await request<{ access_code: string; authorization_url: string; reference: string }>(
    'POST',
    '/transaction/initialize',
    options,
    body,
  )
  return { accessCode: data.access_code, authorizationUrl: data.authorization_url, reference: data.reference }
}

// Verify

export type PaystackTransactionStatus =
  | 'success'
  | 'failed'
  | 'abandoned'
  | 'ongoing'
  | 'pending'
  | 'processing'
  | 'queued'
  | 'reversed'
  | (string & {})

/** The `data` object from GET /transaction/verify/:reference. */
export interface PaystackTransaction {
  id: number
  status: PaystackTransactionStatus
  reference: string
  amount: number
  currency: string
  gateway_response?: string
  paid_at?: string | null
  created_at?: string
  channel?: string
  fees?: number | null
  metadata?: unknown
  customer?: { id: number; email: string; customer_code: string; [key: string]: unknown }
  authorization?: Record<string, unknown>
  [key: string]: unknown
}

export interface ExpectedPayment {
  /** Lowest currency unit, as you priced the order. */
  amount: number
  /** Checked case-insensitively when given. */
  currency?: string
}

export interface VerifyTransactionOptions extends PaystackServerOptions {
  /** What you expected the customer to pay. Strongly recommended. */
  expected?: ExpectedPayment
}

export interface PaymentMismatch {
  amount?: { expected: number; received: number }
  currency?: { expected: string; received: string }
}

export interface VerifyTransactionResult {
  /** True only when status is 'success' and the amount and currency match `expected`. */
  paid: boolean
  status: PaystackTransactionStatus
  /** Present when the payment succeeded but did not match `expected`. Do not fulfil the order. */
  mismatch?: PaymentMismatch
  transaction: PaystackTransaction
}

/**
 * Looks up a transaction by reference. Always pass `expected`: a successful
 * transaction for the wrong amount or currency is not a paid order.
 */
export async function verifyTransaction(
  reference: string,
  options: VerifyTransactionOptions,
): Promise<VerifyTransactionResult> {
  if (typeof reference !== 'string' || reference.trim() === '') {
    throw new TypeError('verifyTransaction needs a transaction reference.')
  }
  const transaction = await request<PaystackTransaction>(
    'GET',
    `/transaction/verify/${encodeURIComponent(reference)}`,
    options,
  )

  const { expected } = options
  let mismatch: PaymentMismatch | undefined
  if (expected) {
    if (transaction.amount !== expected.amount) {
      mismatch = { ...mismatch, amount: { expected: expected.amount, received: transaction.amount } }
    }
    if (
      expected.currency !== undefined &&
      String(transaction.currency).toUpperCase() !== expected.currency.toUpperCase()
    ) {
      mismatch = { ...mismatch, currency: { expected: expected.currency, received: transaction.currency } }
    }
  }

  const status = transaction.status
  return {
    paid: status === 'success' && !mismatch,
    status,
    ...(mismatch ? { mismatch } : {}),
    transaction,
  }
}

// Webhooks

export type RawBody = string | ArrayBuffer | Uint8Array

export interface PaystackWebhookEvent<TData = Record<string, unknown>> {
  event: 'charge.success' | 'transfer.success' | 'transfer.failed' | 'refund.processed' | (string & {})
  data: TData & {
    reference?: string
    amount?: number
    currency?: string
    status?: string
    [key: string]: unknown
  }
}

const encoder = new TextEncoder()

function toBytes(body: RawBody): Uint8Array {
  if (typeof body === 'string') return encoder.encode(body)
  if (body instanceof Uint8Array) return body
  return new Uint8Array(body)
}

function toHex(buffer: ArrayBuffer): string {
  let hex = ''
  for (const byte of new Uint8Array(buffer)) hex += byte.toString(16).padStart(2, '0')
  return hex
}

function constantTimeEqual(a: string, b: string): boolean {
  // Length is not secret: a valid signature is always 128 hex characters.
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function getSubtle(): Promise<SubtleCrypto> {
  if (globalThis.crypto?.subtle) return globalThis.crypto.subtle
  // Node 18 has Web Crypto but does not expose it as a global without a flag.
  const nodeCrypto = (await import(/* webpackIgnore: true */ 'node:crypto' as string)) as {
    webcrypto?: { subtle?: SubtleCrypto }
  }
  if (!nodeCrypto.webcrypto?.subtle) throw new Error('Web Crypto is not available in this runtime.')
  return nodeCrypto.webcrypto.subtle
}

/**
 * Checks the `x-paystack-signature` header: a hex HMAC-SHA512 of the raw
 * request body, keyed with your secret key. Pass the body exactly as received
 * (`await request.text()`), not re-serialized JSON.
 */
export async function verifyWebhookSignature(
  rawBody: RawBody,
  signature: string | null | undefined,
  secretKey: string,
): Promise<boolean> {
  assertSecretKey(secretKey)
  if (typeof signature !== 'string' || signature === '') return false
  const subtle = await getSubtle()
  const key = await subtle.importKey('raw', encoder.encode(secretKey), { name: 'HMAC', hash: 'SHA-512' }, false, [
    'sign',
  ])
  const digest = await subtle.sign('HMAC', key, toBytes(rawBody) as BufferSource)
  return constantTimeEqual(toHex(digest), signature.trim().toLowerCase())
}

/** Verifies the signature, then parses the event. Throws PaystackSignatureError if it does not match. */
export async function parseWebhookEvent<TData = Record<string, unknown>>(
  rawBody: RawBody,
  signature: string | null | undefined,
  secretKey: string,
): Promise<PaystackWebhookEvent<TData>> {
  if (!(await verifyWebhookSignature(rawBody, signature, secretKey))) {
    throw new PaystackSignatureError()
  }
  const text = typeof rawBody === 'string' ? rawBody : new TextDecoder().decode(toBytes(rawBody))
  return JSON.parse(text) as PaystackWebhookEvent<TData>
}

// Bound client

export interface PaystackServerClient {
  initializeTransaction(params: InitializeTransactionParams): Promise<InitializeTransactionResult>
  verifyTransaction(reference: string, options?: { expected?: ExpectedPayment }): Promise<VerifyTransactionResult>
  verifyWebhookSignature(rawBody: RawBody, signature: string | null | undefined): Promise<boolean>
  parseWebhookEvent<TData = Record<string, unknown>>(
    rawBody: RawBody,
    signature: string | null | undefined,
  ): Promise<PaystackWebhookEvent<TData>>
}

/** Binds every helper to one secret key (and optional fetch and base URL). */
export function createPaystack(options: PaystackServerOptions): PaystackServerClient {
  assertSecretKey(options?.secretKey)
  const { secretKey } = options
  return {
    initializeTransaction: (params) => initializeTransaction(params, options),
    verifyTransaction: (reference, extra) => verifyTransaction(reference, { ...options, ...extra }),
    verifyWebhookSignature: (rawBody, signature) => verifyWebhookSignature(rawBody, signature, secretKey),
    parseWebhookEvent: (rawBody, signature) => parseWebhookEvent(rawBody, signature, secretKey),
  }
}
