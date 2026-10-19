'use client'

import * as React from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { GpuAssetStatus } from '@/lib/gpu/types'
import { STATUS_LABEL, STATUS_TONE } from './fleet-math'

// ── GPU fleet (P5) ── The small pieces the fleet forms share: a status badge, the alert a route's
// refusal is shown in, a labelled field, and a dialog that submits one request.

export function StatusBadge({ status }: { status: GpuAssetStatus }) {
  return (
    <span className={cn('inline-flex rounded-md px-1.5 py-0.5 text-caption font-medium', STATUS_TONE[status])}>
      {STATUS_LABEL[status]}
    </span>
  )
}

/** A route's refusal, in its own words. */
export function ErrorAlert({ children }: { children: React.ReactNode }) {
  return (
    <Alert variant="destructive" className="bg-destructive-subtle">
      <AlertDescription className="text-sm">{children}</AlertDescription>
    </Alert>
  )
}

export function Field({ id, label, hint, children, className }: {
  id: string; label: string; hint?: React.ReactNode; children: React.ReactNode; className?: string
}) {
  return (
    <div className={cn('space-y-1', className)}>
      <label htmlFor={id} className="text-xs text-muted-foreground">{label}</label>
      {children}
      {hint && <p className="text-caption text-muted-foreground">{hint}</p>}
    </div>
  )
}

export const selectCls = 'h-9 w-full rounded-md border border-input bg-background px-2 text-sm disabled:cursor-not-allowed disabled:opacity-50'

/**
 * A dialog that runs one request. `onSubmit` returns the route's error text, or null on success
 * (the dialog then closes); the error stays on screen until the next attempt or a close.
 */
export function FormDialog({ open, onOpenChange, title, description, submitLabel, canSubmit = true, onSubmit, children }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: React.ReactNode
  submitLabel: string
  canSubmit?: boolean
  onSubmit: () => Promise<string | null>
  children: React.ReactNode
}) {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const close = (o: boolean) => { onOpenChange(o); if (!o) setError(null) }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    const err = await onSubmit()
    setBusy(false)
    if (err) setError(err)
    else close(false)
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          {children}
          {error && <ErrorAlert>{error}</ErrorAlert>}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" size="sm" onClick={() => close(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" size="sm" disabled={busy || !canSubmit}>
              {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}{submitLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** An action that needs a grant the caller lacks: disabled, with the reason as its tooltip. */
export function GatedButton({ allowed, hint, onClick, children, variant = 'outline' }: {
  allowed: boolean; hint: string; onClick: () => void; children: React.ReactNode; variant?: 'outline' | 'ghost' | 'default'
}) {
  return (
    <Button type="button" size="sm" variant={variant} disabled={!allowed} title={allowed ? undefined : hint} onClick={onClick}>
      {children}
    </Button>
  )
}

export const ACCOUNTING_WRITE_HINT = 'Booking this to the ledger needs write access to Accounting.'
export const FLEET_WRITE_HINT = 'Changing the fleet register needs write access to the GPU fleet.'
