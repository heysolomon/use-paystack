import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fake, lastTransaction } from './fake-paystack'
import { PaystackError, usePaystack, type PaystackResult } from '../src'

const PK = 'pk_test_abc123'
const order = { email: 'ada@example.com', amount: 50000, reference: 'order-42' }

function setup(preload = true) {
  return renderHook(() => usePaystack({ publicKey: PK, preload }))
}

async function expectError(promise: Promise<unknown>, code: PaystackError['code']) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(PaystackError)
  expect((error as PaystackError).code).toBe(code)
  return error as PaystackError
}

beforeEach(() => fake.reset())

describe('usePaystack', () => {
  it('preloads inline-js and reports isReady', async () => {
    const { result } = setup()
    expect(result.current.isReady).toBe(false)
    await waitFor(() => expect(result.current.isReady).toBe(true))
  })

  it('passes options, key and callbacks to newTransaction', async () => {
    const { result } = setup()
    const metadata = { custom_fields: [{ display_name: 'Cart', variable_name: 'cart', value: '1' }] }
    let promise!: Promise<PaystackResult>
    act(() => {
      promise = result.current.pay({ ...order, currency: 'NGN', channels: ['card', 'bank_transfer'], metadata })
    })

    const tx = await lastTransaction()
    expect(tx.options).toMatchObject({ ...order, key: PK, currency: 'NGN', metadata })
    expect(typeof tx.options.onSuccess).toBe('function')
    expect(typeof tx.options.onBankTransferConfirmationPending).toBe('function')
    await waitFor(() => expect(result.current.isOpen).toBe(true))

    act(() => tx.options.onSuccess({ id: 99, reference: 'order-42', message: 'Approved' }))
    await expect(promise).resolves.toEqual({
      status: 'success',
      reference: 'order-42',
      transactionId: 99,
      message: 'Approved',
    })
    await waitFor(() => expect(result.current.isOpen).toBe(false))
  })

  it('resolves pending, not cancelled, when onCancel fires right before the pending callback', async () => {
    const { result } = setup()
    let promise!: Promise<PaystackResult>
    act(() => {
      promise = result.current.pay(order)
    })
    const tx = await lastTransaction()
    tx.options.onLoad({ id: 7, accessCode: 'ac_123', customer: {} })

    // Exactly what inline-js does for "transfer:pending": cancel() then the pending callback, synchronously.
    tx.options.onCancel()
    tx.options.onBankTransferConfirmationPending()

    await expect(promise).resolves.toEqual({
      status: 'pending',
      reference: 'order-42',
      transactionId: 7,
      accessCode: 'ac_123',
    })
  })

  it('resolves cancelled when the customer closes checkout', async () => {
    const { result } = setup()
    let promise!: Promise<PaystackResult>
    act(() => {
      promise = result.current.pay(order)
    })
    const tx = await lastTransaction()
    tx.options.onCancel()
    await expect(promise).resolves.toEqual({ status: 'cancelled', reference: 'order-42' })
  })

  it('calls the user onLoad and survives it throwing', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onLoad = vi.fn(() => {
      throw new Error('analytics broke')
    })
    const { result } = setup()
    let promise!: Promise<PaystackResult>
    act(() => {
      promise = result.current.pay({ ...order, onLoad })
    })
    const tx = await lastTransaction()
    const loadResponse = { id: 1, accessCode: 'ac_1', customer: {} }
    tx.options.onLoad(loadResponse)
    expect(onLoad).toHaveBeenCalledWith(loadResponse)
    expect(consoleError).toHaveBeenCalled()

    tx.options.onSuccess({ id: 1, reference: 'order-42' })
    await expect(promise).resolves.toMatchObject({ status: 'success' })
  })

  it('rejects with checkout_error when inline-js calls onError', async () => {
    const { result } = setup()
    let promise!: Promise<PaystackResult>
    act(() => {
      promise = result.current.pay(order)
    })
    const tx = await lastTransaction()
    tx.options.onError({ message: 'Invalid key' })
    const error = await expectError(promise, 'checkout_error')
    expect(error.message).toBe('Invalid key')
    await waitFor(() => expect(result.current.isOpen).toBe(false))
  })

  it('rejects with checkout_error when newTransaction throws', async () => {
    fake.throwOnNewTransaction = new Error('Invalid transaction parameters')
    const { result } = setup()
    const error = await expectError(result.current.pay(order), 'checkout_error')
    expect(error.message).toBe('Invalid transaction parameters')
    await waitFor(() => expect(result.current.isOpen).toBe(false))
  })

  it('rejects a second pay while one is open with already_open', async () => {
    const { result } = setup()
    let first!: Promise<PaystackResult>
    let second!: Promise<PaystackResult>
    act(() => {
      // Same tick, so state has not re-rendered: only the ref can stop this.
      first = result.current.pay(order)
      second = result.current.pay(order)
    })
    await expectError(second, 'already_open')
    const tx = await lastTransaction()
    expect(fake.transactions).toHaveLength(1)
    tx.options.onCancel()
    await expect(first).resolves.toMatchObject({ status: 'cancelled' })

    // Once closed, paying again works.
    let third!: Promise<PaystackResult>
    act(() => {
      third = result.current.pay(order)
    })
    await vi.waitFor(() => expect(fake.transactions).toHaveLength(2))
    ;(fake.transactions[1]!.options.onCancel as () => void)()
    await expect(third).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('generates a valid reference when none is passed', async () => {
    const { result } = setup()
    let promise!: Promise<PaystackResult>
    act(() => {
      promise = result.current.pay({ email: 'ada@example.com', amount: 1000 })
    })
    const tx = await lastTransaction()
    const reference = tx.options.reference as string
    expect(reference).toMatch(/^[A-Za-z0-9.=-]+$/)
    expect(reference.length).toBeGreaterThan(10)

    // Even a pending transfer carries the generated reference, so the server can verify it.
    tx.options.onCancel()
    tx.options.onBankTransferConfirmationPending()
    await expect(promise).resolves.toMatchObject({ status: 'pending', reference })
  })

  it('generates a different reference for each payment', async () => {
    const { result } = setup()
    const refs = new Set<string>()
    for (let i = 0; i < 3; i++) {
      let promise!: Promise<PaystackResult>
      act(() => {
        promise = result.current.pay({ email: 'ada@example.com', amount: 1000 })
      })
      await vi.waitFor(() => expect(fake.transactions).toHaveLength(i + 1))
      const tx = fake.transactions[i]!
      refs.add(tx.options.reference as string)
      ;(tx.options.onCancel as () => void)()
      await promise
    }
    expect(refs.size).toBe(3)
  })

  it('resume() opens a server-initialized transaction and keeps the pending callback', async () => {
    const { result } = setup()
    let promise!: Promise<PaystackResult>
    act(() => {
      promise = result.current.resume('ac_server_123')
    })
    const tx = await lastTransaction()
    expect(tx.options.accessCode).toBe('ac_server_123')
    expect(tx.options.key).toBeUndefined()
    expect(typeof tx.options.onBankTransferConfirmationPending).toBe('function')

    tx.options.onSuccess({ id: 5, reference: 'srv-ref', message: 'Approved' })
    await expect(promise).resolves.toEqual({
      status: 'success',
      reference: 'srv-ref',
      transactionId: 5,
      message: 'Approved',
    })
  })

  it('resume() reports a pending transfer as pending', async () => {
    const { result } = setup()
    let promise!: Promise<PaystackResult>
    act(() => {
      promise = result.current.resume('ac_server_456')
    })
    const tx = await lastTransaction()
    tx.options.onLoad({ id: 11, accessCode: 'ac_server_456', customer: {} })
    tx.options.onCancel()
    tx.options.onBankTransferConfirmationPending()
    await expect(promise).resolves.toEqual({ status: 'pending', transactionId: 11, accessCode: 'ac_server_456' })
  })

  it('resume() rejects an empty access code', async () => {
    const { result } = setup()
    await expectError(result.current.resume(''), 'invalid_options')
  })
})

describe('validation (before anything loads)', () => {
  it('rejects a secret key and says to rotate it', async () => {
    const { result } = renderHook(() => usePaystack({ publicKey: 'sk_live_oops', preload: false }))
    const error = await expectError(result.current.pay(order), 'invalid_options')
    expect(error.message).toMatch(/secret key/i)
    expect(error.message).toMatch(/rotate/i)
    expect(fake.transactions).toHaveLength(0)
  })

  it.each([
    ['a decimal amount', { ...order, amount: 500.5 }, /positive integer/],
    ['a zero amount', { ...order, amount: 0 }, /positive integer/],
    ['a string amount', { ...order, amount: '5000' as unknown as number }, /positive integer/],
    ['a missing amount', { email: 'ada@example.com' }, /amount is required/],
    ['a bad email', { ...order, email: 'not-an-email' }, /email/],
    ['a missing email', { amount: 5000 }, /email/],
    ['a bad reference', { ...order, reference: 'order 42/x' }, /reference/],
    ['an underscore in the reference', { ...order, reference: 'order_42' }, /reference/],
  ])('rejects %s', async (_label, options, message) => {
    const { result } = setup(false)
    const error = await expectError(result.current.pay(options), 'invalid_options')
    expect(error.message).toMatch(message)
    expect(result.current.isOpen).toBe(false)
    expect(fake.transactions).toHaveLength(0)
  })

  it('allows a missing email when customerCode is given, and a missing amount with planCode', async () => {
    const { result } = setup()
    let promise!: Promise<PaystackResult>
    act(() => {
      promise = result.current.pay({ customerCode: 'CUS_123', planCode: 'PLN_abc' })
    })
    const tx = await lastTransaction()
    expect(tx.options).toMatchObject({ customerCode: 'CUS_123', planCode: 'PLN_abc' })
    tx.options.onCancel()
    await promise
  })
})
