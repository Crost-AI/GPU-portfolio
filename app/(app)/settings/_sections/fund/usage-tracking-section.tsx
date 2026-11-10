'use client'

import { useState } from 'react'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Loader2 } from 'lucide-react'
import { Section } from '@/components/settings/section'

export function UsageTrackingSection({
  disableUserTracking,
  onSaved,
}: {
  disableUserTracking: boolean
  onSaved: () => void
}) {
  const [disabled, setDisabled] = useState(disableUserTracking)
  const [saving, setSaving] = useState(false)

  // The switch reads as "tracking on", so it is the inverse of the stored flag.
  const handleToggle = async (tracking: boolean) => {
    setDisabled(!tracking)
    setSaving(true)
    const res = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disableUserTracking: !tracking }),
    })
    setSaving(false)
    if (res.ok) onSaved()
  }

  return (
    <Section title="Usage tracking">
      <p className="text-xs text-muted-foreground mb-4">
        AI token usage is always tracked to help you monitor costs. User activity tracking (logins, actions, and the activity feed on the Usage page) can be turned off if you prefer not to log individual user actions.
      </p>
      <div className="flex items-center gap-3">
        <Switch
          id="track-user-activity"
          checked={!disabled}
          onCheckedChange={handleToggle}
          disabled={saving}
        />
        <Label htmlFor="track-user-activity" className="text-sm font-normal">
          Track user activity
        </Label>
        <span className="text-xs text-muted-foreground">{disabled ? 'Off' : 'On'}</span>
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      </div>
    </Section>
  )
}
