'use client'

import { useCallback, useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Check, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Section } from '@/components/settings/section'
import { UNGROUPED_LABEL, type VehicleGroup } from '@/lib/vehicle-groups'
import { VEHICLE_KIND_LABELS, type VehicleKind } from '@/lib/vehicle-kinds'

interface GroupedVehicle { id: string; name: string; kind: string; active: boolean; groupId: string | null }

/**
 * Entity groups: the sections the entity lists (Financials, the Admin page and every section
 * landing, Investments) render in. Create, rename, reorder and delete groups, and put each entity
 * in one. An entity in no group is listed under "Other".
 */
export function VehicleGroupsSection() {
  const [groups, setGroups] = useState<VehicleGroup[] | null>(null)
  const [vehicles, setVehicles] = useState<GroupedVehicle[]>([])
  const [migrationPending, setMigrationPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)

  const load = useCallback(async () => {
    const res = await fetch('/api/settings/vehicle-groups').catch(() => null)
    if (!res?.ok) { setError('Could not load entity groups.'); setGroups([]); return }
    const d = await res.json()
    setGroups(d.groups ?? [])
    setVehicles(d.vehicles ?? [])
    setMigrationPending(!!d.migrationPending)
  }, [])
  useEffect(() => { load() }, [load])

  async function call(key: string, method: string, body: unknown) {
    setBusy(key)
    setError(null)
    const res = await fetch('/api/settings/vehicle-groups', {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).catch(() => null)
    const d = await res?.json().catch(() => ({}))
    setBusy(null)
    if (!res?.ok) { setError(d?.error ?? 'Could not save.'); return false }
    await load()
    return true
  }

  async function create() {
    if (!newName.trim()) return
    if (await call('create', 'POST', { name: newName })) setNewName('')
  }

  async function rename() {
    if (!editing?.name.trim()) return
    if (await call(`rename-${editing.id}`, 'PATCH', { id: editing.id, name: editing.name })) setEditing(null)
  }

  function move(index: number, delta: number) {
    if (!groups) return
    const order = groups.map(g => g.id)
    const [id] = order.splice(index, 1)
    order.splice(index + delta, 0, id)
    call(`move-${id}`, 'PATCH', { order })
  }

  function remove(g: VehicleGroup) {
    const n = vehicles.filter(v => v.groupId === g.id).length
    const what = n === 0 ? '' : ` Its ${n} ${n === 1 ? 'entity goes' : 'entities go'} back to ${UNGROUPED_LABEL}.`
    if (!confirm(`Delete the group “${g.name}”?${what}`)) return
    call(`delete-${g.id}`, 'DELETE', { id: g.id })
  }

  const assign = (vehicleId: string, groupId: string) =>
    call(`assign-${vehicleId}`, 'PATCH', { vehicleId, groupId: groupId || null })

  const countIn = (id: string) => vehicles.filter(v => v.groupId === id).length

  return (
    <Section title="Entity groups">
      <p className="text-xs text-muted-foreground mb-3">
        Sections for the entity lists on Financials, Admin and Investments, each with its own
        subtotal. Each entity sits in one group; an entity in none is listed under {UNGROUPED_LABEL}.
        With no groups, the lists stay flat.
      </p>
      {error && <p className="text-sm text-destructive mb-2">{error}</p>}

      {groups === null ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading…</div>
      ) : migrationPending ? (
        <p className="text-xs text-muted-foreground">Entity groups need a database migration that has not been applied yet.</p>
      ) : (
        <div className="space-y-5">
          <div className="space-y-2">
            {groups.length > 0 && (
              <ul className="rounded-card border divide-y">
                {groups.map((g, i) => (
                  <li key={g.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                    {editing?.id === g.id ? (
                      <>
                        <Input
                          autoFocus value={editing.name} maxLength={80}
                          onChange={e => setEditing({ id: g.id, name: e.target.value })}
                          onKeyDown={e => { if (e.key === 'Enter') rename(); if (e.key === 'Escape') setEditing(null) }}
                          className="h-8 flex-1"
                        />
                        <button onClick={rename} disabled={busy !== null} title="Save" className="text-muted-foreground hover:text-foreground">
                          {busy === `rename-${g.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                        </button>
                        <button onClick={() => setEditing(null)} title="Cancel" className="text-muted-foreground hover:text-foreground">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="min-w-0 flex-1 truncate">
                          {g.name}
                          <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">{countIn(g.id)}</span>
                        </span>
                        <button onClick={() => move(i, -1)} disabled={i === 0 || busy !== null} title="Move up" className="text-muted-foreground hover:text-foreground disabled:opacity-30">
                          <ArrowUp className="h-3.5 w-3.5" />
                        </button>
                        <button onClick={() => move(i, 1)} disabled={i === groups.length - 1 || busy !== null} title="Move down" className="text-muted-foreground hover:text-foreground disabled:opacity-30">
                          <ArrowDown className="h-3.5 w-3.5" />
                        </button>
                        <button onClick={() => setEditing({ id: g.id, name: g.name })} title="Rename" className="text-muted-foreground hover:text-foreground">
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button onClick={() => remove(g)} disabled={busy !== null} title="Delete" className="text-muted-foreground hover:text-destructive">
                          {busy === `delete-${g.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-center gap-2">
              <Input
                value={newName} maxLength={80} placeholder="New group, e.g. Flagship funds"
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') create() }}
                className="h-9 max-w-xs"
              />
              <Button size="sm" onClick={create} disabled={!newName.trim() || busy !== null}>
                {busy === 'create' ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}Add group
              </Button>
            </div>
          </div>

          {groups.length > 0 && vehicles.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Entities</p>
              <ul className="rounded-card border divide-y">
                {vehicles.map(v => (
                  <li key={v.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">
                      {v.name}
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        {VEHICLE_KIND_LABELS[v.kind as VehicleKind] ?? v.kind}{v.active ? '' : ' · Inactive'}
                      </span>
                    </span>
                    {busy === `assign-${v.id}` && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                    <select
                      value={v.groupId ?? ''}
                      onChange={e => assign(v.id, e.target.value)}
                      disabled={busy !== null}
                      aria-label={`Group for ${v.name}`}
                      className="h-8 px-2 rounded-md border border-input bg-background text-sm min-w-[160px]"
                    >
                      <option value="">{UNGROUPED_LABEL}</option>
                      {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Section>
  )
}
