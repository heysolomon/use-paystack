// A separate file so the loader's module-level cache starts empty.
import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import { fake, lastTransaction } from './fake-paystack'
import { PaystackError, usePaystack, type PaystackResult } from '../src'

it('rejects with load_failed, then a later call retries the load and succeeds', async () => {
  const { result } = renderHook(() => usePaystack({ publicKey: 'pk_test_1', preload: false }))
  const order = { email: 'ada@example.com', amount: 1000 }

  fake.failNextLoad = true
  const error = await result.current.pay(order).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(PaystackError)
  expect((error as PaystackError).code).toBe('load_failed')
  expect(result.current.isOpen).toBe(false)
  expect(result.current.isReady).toBe(false)

  let promise!: Promise<PaystackResult>
  act(() => {
    promise = result.current.pay(order)
  })
  const tx = await lastTransaction()
  tx.options.onSuccess({ id: 1, reference: tx.options.reference })
  await expect(promise).resolves.toMatchObject({ status: 'success' })
  expect(result.current.isReady).toBe(true)
})
