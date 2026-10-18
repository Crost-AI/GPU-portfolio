import * as React from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'

// The pieces every GPU SPV page shell is built from. The shells render the real layout of each
// page — its regions, its table columns, its actions — before the data behind them exists, so a
// later PR only fills them in. Nothing here fetches.

/** A titled region of a page: a card with a section heading and, optionally, an action. */
export function ShellSection({ title, description, action, children, className }: {
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn('rounded-card border bg-card p-4 shadow-sm dark:shadow-none md:p-5', className)}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

export interface ShellColumn { label: string; align?: 'right' }

/** A table's header row with nothing under it yet, and the empty state that says why. */
export function HeaderTable({ columns, children }: { columns: ShellColumn[]; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-card border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              {columns.map(c => (
                <th key={c.label} scope="col" className={cn('whitespace-nowrap px-3 py-2 font-medium', c.align === 'right' ? 'text-right' : 'text-left')}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
        </table>
      </div>
      <EmptyState compact>{children}</EmptyState>
    </div>
  )
}

/** An action that is designed but not wired yet: disabled, with the reason beside it. */
export function PendingAction({ label, hint, icon: Icon }: {
  label: string
  hint: string
  icon?: React.ComponentType<{ className?: string }>
}) {
  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" variant="outline" disabled title={hint}>
        {Icon && <Icon className="mr-1.5 h-4 w-4" />}{label}
      </Button>
      <p className="text-caption text-muted-foreground">{hint}</p>
    </div>
  )
}
