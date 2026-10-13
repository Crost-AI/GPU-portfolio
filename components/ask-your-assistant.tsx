'use client'

import { useState, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { Check, Copy, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/**
 * Where an AI button would be on a fund with no server key. A browser button has no model to
 * borrow, so instead of hiding the feature this says how to do it from the person's own assistant
 * (lib/ai/capabilities.ts): the connector URL and a prompt to copy.
 */
export function AskYourAssistant({
  prompt,
  label = 'Analyst',
  className = '',
}: {
  /** What to type into the assistant, e.g. "How is the portfolio doing this quarter?" */
  prompt: string
  label?: string
  className?: string
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={`gap-1.5 h-8 py-2 text-muted-foreground hover:text-foreground ${className}`}>
          <Sparkles className="h-3.5 w-3.5" />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <AskYourAssistantBody prompt={prompt} />
      </PopoverContent>
    </Popover>
  )
}

/** The same guidance inline, for a page that has room for it. */
export function AskYourAssistantBody({ prompt }: { prompt: string }) {
  const origin = useOrigin()
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard blocked: the prompt is on screen to copy by hand.
    }
  }

  return (
    <div className="space-y-2 text-sm">
      <p>
        This fund has no server AI key, so ask your own assistant. Connect Claude or ChatGPT to{' '}
        <span className="font-mono text-xs break-all">{origin}/api/mcp</span>, then ask:
      </p>
      <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-2">
        <span className="flex-1">{prompt}</span>
        <button type="button" onClick={copy} className="text-muted-foreground hover:text-foreground" aria-label="Copy the prompt">
          {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        Or an admin can add a key in <Link href="/settings" className="underline">Settings</Link> to use the AI here.
      </p>
    </div>
  )
}

const noSubscribe = () => () => {}

/** This deployment's origin, for the connector URL; empty during the server render. */
export function useOrigin(): string {
  return useSyncExternalStore(noSubscribe, () => window.location.origin, () => '')
}
