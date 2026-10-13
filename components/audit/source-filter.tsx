'use client'

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { CHANGE_SOURCE_KEYS, CHANGE_SOURCE_LABEL, type ChangeSourceKey } from '@/lib/audit/source-labels'

/** Filter a trail by the door each change came through: the app, the API, or a connected assistant. */
export function SourceFilter({ value, onChange }: { value: ChangeSourceKey | null; onChange: (v: ChangeSourceKey | null) => void }) {
  return (
    <Select value={value ?? 'all'} onValueChange={v => onChange(v === 'all' ? null : v as ChangeSourceKey)}>
      <SelectTrigger className="h-8 w-40" aria-label="Source">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All sources</SelectItem>
        {CHANGE_SOURCE_KEYS.map(k => <SelectItem key={k} value={k}>{k === 'mcp' ? 'MCP (assistants)' : CHANGE_SOURCE_LABEL[k]}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}
