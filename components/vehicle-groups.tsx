'use client'

import { useEffect, useState } from 'react'
import { EMPTY_VEHICLE_GROUPS, type VehicleGroupsPayload } from '@/lib/vehicle-groups'

// The client half of lib/vehicle-groups.ts: the fetch every entity list shares, and the section
// heading row they render. A failed fetch (or a database without the migration) leaves the list
// flat, exactly as it was before groups existed.

export function useVehicleGroups(): VehicleGroupsPayload {
  const [payload, setPayload] = useState<VehicleGroupsPayload>(EMPTY_VEHICLE_GROUPS)
  useEffect(() => {
    let live = true
    fetch('/api/vehicle-groups')
      .then(r => (r.ok ? r.json() : EMPTY_VEHICLE_GROUPS))
      .then((d: VehicleGroupsPayload) => {
        if (live && Array.isArray(d?.groups) && Array.isArray(d?.assignments)) setPayload(d)
      })
      .catch(() => {})
    return () => { live = false }
  }, [])
  return payload
}

/** A group's heading inside a table body. */
export function GroupHeadingRow({ label, count, colSpan }: { label: string; count: number; colSpan: number }) {
  return (
    <tr className="border-t bg-muted/20">
      <td colSpan={colSpan} className="px-3 pt-3 pb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
        <span className="ml-1.5 font-normal normal-case tracking-normal tabular-nums">· {count}</span>
      </td>
    </tr>
  )
}
