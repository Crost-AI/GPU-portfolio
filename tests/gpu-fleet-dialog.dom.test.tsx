// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

/**
 * ── GPU fleet (P5) ── The capex idempotency key, guarded on the REAL dialog in a real mount.
 *
 * The static-render tests in gpu-fleet-ui.test.tsx render each mount once and never re-render, so they
 * cannot tell a key held for the dialog's opening from one minted on every render (#104 review, L1).
 * Here the dialog is opened, typed into (each keystroke re-renders it), submitted twice within one
 * opening, then closed and reopened: one crypto.randomUUID per opening, reused across the retry.
 *
 * This file opts into happy-dom by the comment on its first line; every other test stays on node.
 */

import { CurrencyProvider } from '@/components/currency-context'
import { CapexDialog } from '@/components/gpu/fleet-dialogs'
import type { Fetcher } from '@/components/gpu/fleet-api'
import type { GpuAsset } from '@/lib/gpu/types'

// Vitest globals are off, so Testing Library cannot register its own cleanup.
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const ASSET = { id: 'h200', name: 'H200 NVL', vehicle_id: 'v', status: 'in_service', purchase_entry_id: 'je' } as GpuAsset

/** A host page: the dialog closed, a button that opens it, exactly as the asset page mounts it. */
function Host({ fetcher }: { fetcher: Fetcher }) {
  const [open, setOpen] = useState(false)
  return (
    <CurrencyProvider currency="USD">
      <button type="button" onClick={() => setOpen(true)}>Open capex</button>
      <CapexDialog open={open} onOpenChange={setOpen} fetcher={fetcher} onDone={() => {}} asset={ASSET} />
    </CurrencyProvider>
  )
}

/** Answers each call from the queue and records the body sent. */
function queue(...responses: { status: number; body: unknown }[]) {
  const bodies: Record<string, unknown>[] = []
  const fetcher: Fetcher = async (_path, init) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')))
    const r = responses.shift() ?? { status: 200, body: {} }
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } })
  }
  return { fetcher, bodies }
}

/** Type into the amount field one character at a time: a re-render of the open dialog per keystroke. */
function typeAmount(value: string) {
  const input = screen.getByLabelText('Amount') as HTMLInputElement
  for (let i = 1; i <= value.length; i++) fireEvent.change(input, { target: { value: value.slice(0, i) } })
}

describe('the capex dialog’s idempotency key', () => {
  it('is made once per opening, survives typing and a retry, and is new on the next opening', async () => {
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID')
    const { fetcher, bodies } = queue(
      { status: 409, body: { error: 'This cost is being booked by another request', inProgress: true } },
      { status: 200, body: { entryId: 'je-1' } },
      { status: 200, body: { entryId: 'je-2' } },
    )
    render(<Host fetcher={fetcher} />)
    expect(uuid).not.toHaveBeenCalled()

    // First opening: type (re-rendering on every keystroke), submit, get a 409, submit again.
    fireEvent.click(screen.getByText('Open capex'))
    typeAmount('12,000')
    expect(uuid).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Capitalize' }))
    await screen.findByText('This cost is being booked by another request')
    typeAmount('12,000.00')
    fireEvent.click(screen.getByRole('button', { name: 'Capitalize' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Capitalize' })).toBeNull())
    expect(uuid).toHaveBeenCalledTimes(1)
    expect(bodies).toHaveLength(2)
    expect(bodies[0].key).toBe(bodies[1].key)
    expect(bodies[0]).toMatchObject({ amount: 12_000 })

    // Second opening: a new cost, so a new key.
    fireEvent.click(screen.getByText('Open capex'))
    typeAmount('5,000')
    fireEvent.click(screen.getByRole('button', { name: 'Capitalize' }))
    await waitFor(() => expect(bodies).toHaveLength(3))
    expect(uuid).toHaveBeenCalledTimes(2)
    expect(bodies[2].key).not.toBe(bodies[0].key)
    expect(bodies[2].key).toBe(uuid.mock.results[1].value)
  })
})
