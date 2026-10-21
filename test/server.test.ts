// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  createPaystack,
  initializeTransaction,
  parseWebhookEvent,
  PaystackApiError,
  PaystackSignatureError,
  verifyTransaction,
  verifyWebhookSignature,
} from '../src/server'

const SECRET = 'sk_test_webhook_secret'
const BODY = '{"event":"charge.success","data":{"reference":"order-42","amount":50000,"currency":"NGN","status":"success"}}'
// printf '%s' "$BODY" | openssl dgst -sha512 -hmac sk_test_webhook_secret -hex
const SIGNATURE =
  '1bc246171be4fb565d6169a2b45f0b930f40a7476e8e273832f6c8761841c64570d2759fa77253d9ac7ac7593623ef188745aaaca1e4986f4ae41f2572388e3c'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function mockFetch(body: unknown, status = 200) {
  return vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(body, status))
}

function verifyBody(data: Record<string, unknown>) {
  return { status: true, message: 'Verification successful', data: { id: 1, reference: 'order-42', ...data } }
}

describe('verifyWebhookSignature', () => {
  it('accepts the known HMAC-SHA512 signature', async () => {
    await expect(verifyWebhookSignature(BODY, SIGNATURE, SECRET)).resolves.toBe(true)
    await expect(verifyWebhookSignature(BODY, SIGNATURE.toUpperCase(), SECRET)).resolves.toBe(true)
    await expect(verifyWebhookSignature(new TextEncoder().encode(BODY), SIGNATURE, SECRET)).resolves.toBe(true)
  })

  it('rejects a tampered body, a wrong key, and a missing header', async () => {
    await expect(verifyWebhookSignature(BODY.replace('50000', '5000000'), SIGNATURE, SECRET)).resolves.toBe(false)
    await expect(verifyWebhookSignature(BODY, SIGNATURE, 'sk_test_other')).resolves.toBe(false)
    await expect(verifyWebhookSignature(BODY, null, SECRET)).resolves.toBe(false)
    await expect(verifyWebhookSignature(BODY, 'abc', SECRET)).resolves.toBe(false)
  })

  it('refuses a public key', async () => {
    await expect(verifyWebhookSignature(BODY, SIGNATURE, 'pk_test_123')).rejects.toThrow(/PUBLIC key/)
  })
})

describe('parseWebhookEvent', () => {
  it('returns the parsed event for a valid signature', async () => {
    const event = await parseWebhookEvent(BODY, SIGNATURE, SECRET)
    expect(event.event).toBe('charge.success')
    expect(event.data.reference).toBe('order-42')
  })

  it('throws PaystackSignatureError for a bad signature', async () => {
    await expect(parseWebhookEvent(BODY, '0'.repeat(128), SECRET)).rejects.toBeInstanceOf(PaystackSignatureError)
  })
})

describe('verifyTransaction', () => {
  const expected = { amount: 50000, currency: 'NGN' }

  it('is paid when status is success and amount and currency match', async () => {
    const fetch = mockFetch(verifyBody({ status: 'success', amount: 50000, currency: 'NGN' }))
    const result = await verifyTransaction('order-42', { secretKey: SECRET, fetch, expected })
    expect(result).toMatchObject({ paid: true, status: 'success' })
    expect(result.mismatch).toBeUndefined()

    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://api.paystack.co/transaction/verify/order-42')
    expect(init?.method).toBe('GET')
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`)
  })

  it('is not paid when the amount does not match', async () => {
    const fetch = mockFetch(verifyBody({ status: 'success', amount: 100, currency: 'NGN' }))
    const result = await verifyTransaction('order-42', { secretKey: SECRET, fetch, expected })
    expect(result.paid).toBe(false)
    expect(result.status).toBe('success')
    expect(result.mismatch).toEqual({ amount: { expected: 50000, received: 100 } })
  })

  it('is not paid when the currency does not match', async () => {
    const fetch = mockFetch(verifyBody({ status: 'success', amount: 50000, currency: 'GHS' }))
    const result = await verifyTransaction('order-42', { secretKey: SECRET, fetch, expected })
    expect(result.paid).toBe(false)
    expect(result.mismatch).toEqual({ currency: { expected: 'NGN', received: 'GHS' } })
  })

  it('is not paid when the transaction failed', async () => {
    const fetch = mockFetch(verifyBody({ status: 'failed', amount: 50000, currency: 'NGN' }))
    const result = await verifyTransaction('order-42', { secretKey: SECRET, fetch, expected })
    expect(result).toMatchObject({ paid: false, status: 'failed' })
    expect(result.mismatch).toBeUndefined()
  })

  it('encodes the reference in the URL', async () => {
    const fetch = mockFetch(verifyBody({ status: 'success', amount: 1, currency: 'NGN' }))
    await verifyTransaction('a/b?c', { secretKey: SECRET, fetch })
    expect(fetch.mock.calls[0]![0]).toBe('https://api.paystack.co/transaction/verify/a%2Fb%3Fc')
  })

  it('throws PaystackApiError with status and body on an API error', async () => {
    const body = { status: false, message: 'Transaction reference not found' }
    const fetch = mockFetch(body, 400)
    const error = await verifyTransaction('missing', { secretKey: SECRET, fetch }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PaystackApiError)
    expect((error as PaystackApiError).status).toBe(400)
    expect((error as PaystackApiError).body).toEqual(body)
    expect((error as PaystackApiError).message).toBe('Transaction reference not found')
  })

  it('refuses a public key before calling the API', async () => {
    const fetch = mockFetch({})
    await expect(verifyTransaction('order-42', { secretKey: 'pk_live_123', fetch })).rejects.toThrow(/PUBLIC key/)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('initializeTransaction', () => {
  it('posts to /transaction/initialize and maps the response', async () => {
    const fetch = mockFetch({
      status: true,
      message: 'Authorization URL created',
      data: { authorization_url: 'https://checkout.paystack.com/abc', access_code: 'abc', reference: 'order-42' },
    })
    const result = await initializeTransaction(
      { email: 'ada@example.com', amount: 50000, currency: 'NGN', reference: 'order-42', metadata: { cartId: 7 } },
      { secretKey: SECRET, fetch },
    )
    expect(result).toEqual({
      accessCode: 'abc',
      authorizationUrl: 'https://checkout.paystack.com/abc',
      reference: 'order-42',
    })

    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://api.paystack.co/transaction/initialize')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({
      email: 'ada@example.com',
      amount: 50000,
      currency: 'NGN',
      reference: 'order-42',
      metadata: '{"cartId":7}',
    })
  })

  it('rejects a decimal amount without calling the API', async () => {
    const fetch = mockFetch({})
    await expect(
      initializeTransaction({ email: 'ada@example.com', amount: 10.5 }, { secretKey: SECRET, fetch }),
    ).rejects.toThrow(/positive integer/)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('createPaystack', () => {
  it('binds the key, fetch and base URL', async () => {
    const fetch = mockFetch(verifyBody({ status: 'success', amount: 50000, currency: 'NGN' }))
    const paystack = createPaystack({ secretKey: SECRET, fetch, baseUrl: 'https://proxy.test/' })
    const result = await paystack.verifyTransaction('order-42', { expected: { amount: 50000 } })
    expect(result.paid).toBe(true)
    expect(fetch.mock.calls[0]![0]).toBe('https://proxy.test/transaction/verify/order-42')
    await expect(paystack.verifyWebhookSignature(BODY, SIGNATURE)).resolves.toBe(true)
    await expect(paystack.parseWebhookEvent(BODY, SIGNATURE)).resolves.toMatchObject({ event: 'charge.success' })
  })

  it('throws on a public key', () => {
    expect(() => createPaystack({ secretKey: 'pk_test_123' })).toThrow(/PUBLIC key/)
  })
})
