import { Check, KeyRound } from 'lucide-react'
import { AI_CAPABILITIES } from '@/lib/ai/capabilities'

/**
 * What works with no server AI key and what needs one, from the one list in
 * lib/ai/capabilities.ts. Shown in the onboarding wizard and in Settings → AI providers.
 */
export function AICapabilitiesList() {
  const works = AI_CAPABILITIES.filter(c => c.keyless === 'assistant')
  const needs = AI_CAPABILITIES.filter(c => c.keyless === 'needs_key')
  return (
    <div className="grid gap-4 sm:grid-cols-2 text-sm">
      <div className="space-y-1.5">
        <p className="font-medium">Works from your assistant</p>
        <ul className="space-y-1">
          {works.map(c => (
            <li key={c.key} className="flex gap-2" title={c.why}>
              <Check className="h-3.5 w-3.5 mt-0.5 shrink-0 text-success" aria-hidden />
              <span>{c.label}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="space-y-1.5">
        <p className="font-medium">Needs a server key</p>
        <ul className="space-y-1">
          {needs.map(c => (
            <li key={c.key} className="flex gap-2">
              <KeyRound className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
              <span>
                {c.label}
                <span className="block text-xs text-muted-foreground">{c.why}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
