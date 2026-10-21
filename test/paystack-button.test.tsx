import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fake, lastTransaction } from './fake-paystack'
import { PaystackButton, PaystackError } from '../src'

beforeEach(() => fake.reset())

describe('PaystackButton', () => {
  it('renders a plain button and passes other props through', () => {
    render(
      <PaystackButton publicKey="pk_test_1" options={{ email: 'a@b.co', amount: 100 }} className="pay" data-testid="btn">
        Pay N1
      </PaystackButton>,
    )
    const button = screen.getByTestId('btn')
    expect(button.tagName).toBe('BUTTON')
    expect(button).toHaveProperty('type', 'button')
    expect(button.className).toBe('pay')
    expect(button.textContent).toBe('Pay N1')
  })

  it('is disabled with aria-busy while checkout is open, then calls onSuccess', async () => {
    const onSuccess = vi.fn()
    render(
      <PaystackButton publicKey="pk_test_1" options={{ email: 'a@b.co', amount: 100, reference: 'r-1' }} onSuccess={onSuccess}>
        Pay
      </PaystackButton>,
    )
    const button = screen.getByRole('button')
    expect(button.hasAttribute('disabled')).toBe(false)
    expect(button.getAttribute('aria-busy')).toBeNull()

    fireEvent.click(button)
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(true))
    expect(button.getAttribute('aria-busy')).toBe('true')

    const tx = await lastTransaction()
    tx.options.onSuccess({ id: 3, reference: 'r-1', message: 'Approved' })
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith({
      status: 'success',
      reference: 'r-1',
      transactionId: 3,
      message: 'Approved',
    }))
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
    expect(button.getAttribute('aria-busy')).toBeNull()
  })

  it('evaluates an options function at click time', async () => {
    let amount = 100
    render(<PaystackButton publicKey="pk_test_1" options={() => ({ email: 'a@b.co', amount })} />)
    amount = 250
    fireEvent.click(screen.getByRole('button'))
    const tx = await lastTransaction()
    expect(tx.options.amount).toBe(250)
  })

  it('calls onPending (not onCancel) for a pending transfer', async () => {
    const onPending = vi.fn()
    const onCancel = vi.fn()
    render(<PaystackButton publicKey="pk_test_1" accessCode="ac_1" onPending={onPending} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button'))
    const tx = await lastTransaction()
    expect(tx.options.accessCode).toBe('ac_1')
    tx.options.onCancel()
    tx.options.onBankTransferConfirmationPending()
    await waitFor(() => expect(onPending).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending' })))
    await new Promise((r) => setTimeout(r, 10))
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('calls onCancel when the customer closes checkout', async () => {
    const onCancel = vi.fn()
    render(<PaystackButton publicKey="pk_test_1" options={{ email: 'a@b.co', amount: 100, reference: 'r-2' }} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button'))
    const tx = await lastTransaction()
    tx.options.onCancel()
    await waitFor(() => expect(onCancel).toHaveBeenCalledWith({ status: 'cancelled', reference: 'r-2' }))
  })

  it('calls onError with a PaystackError for invalid options', async () => {
    const onError = vi.fn()
    render(<PaystackButton publicKey="pk_test_1" options={{ email: 'a@b.co', amount: 1.5 }} onError={onError} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(onError).toHaveBeenCalled())
    const error = onError.mock.calls[0]![0] as PaystackError
    expect(error).toBeInstanceOf(PaystackError)
    expect(error.code).toBe('invalid_options')
  })

  it('calls onError when the options function throws', async () => {
    const onError = vi.fn()
    render(
      <PaystackButton
        publicKey="pk_test_1"
        options={() => {
          throw new Error('cart is empty')
        }}
        onError={onError}
      />,
    )
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(onError).toHaveBeenCalled())
    expect((onError.mock.calls[0]![0] as PaystackError).message).toBe('cart is empty')
  })

  it('does not open checkout when onClick calls preventDefault', async () => {
    render(
      <PaystackButton
        publicKey="pk_test_1"
        options={{ email: 'a@b.co', amount: 100 }}
        onClick={(event) => event.preventDefault()}
      />,
    )
    fireEvent.click(screen.getByRole('button'))
    await new Promise((r) => setTimeout(r, 20))
    expect(fake.transactions).toHaveLength(0)
  })
})
