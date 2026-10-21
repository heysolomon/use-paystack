// @vitest-environment node
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { fake } from './fake-paystack'
import { PaystackButton, PaystackError, usePaystack, type UsePaystackReturn } from '../src'

describe('server rendering', () => {
  it('renders the hook and the button without touching window or inline-js', () => {
    let captured: UsePaystackReturn | undefined
    function Checkout() {
      const paystack = usePaystack({ publicKey: 'pk_test_123' })
      captured = paystack
      return (
        <div>
          <span>{paystack.isReady ? 'ready' : 'loading'}</span>
          <PaystackButton publicKey="pk_test_123" options={{ email: 'a@b.co', amount: 5000 }}>
            Pay now
          </PaystackButton>
        </div>
      )
    }

    expect(typeof window).toBe('undefined')
    const html = renderToString(<Checkout />)

    expect(html).toContain('Pay now')
    expect(html).toContain('loading')
    expect(captured?.isOpen).toBe(false)
    expect(fake.importCount).toBe(0)
  })

  it('rejects with not_in_browser if pay is called on the server', async () => {
    let pay: UsePaystackReturn['pay'] | undefined
    function Grab() {
      pay = usePaystack({ publicKey: 'pk_test_123' }).pay
      return null
    }
    renderToString(<Grab />)

    const error = await pay!({ email: 'a@b.co', amount: 5000 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PaystackError)
    expect((error as PaystackError).code).toBe('not_in_browser')
    expect(fake.importCount).toBe(0)
  })
})
