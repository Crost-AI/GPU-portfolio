'use client'

import { useEffect } from 'react'
import { Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAnalystContext } from '@/components/analyst-context'
import { AskYourAssistant } from '@/components/ask-your-assistant'

export function AnalystButton({ companyId, companyName, pushRight }: { companyId: string; companyName: string; pushRight?: boolean }) {
  const { open, toggleOpen, setCompanyId, hasAIKey } = useAnalystContext()

  useEffect(() => {
    setCompanyId(companyId)
    return () => setCompanyId(null)
  }, [companyId, setCompanyId])

  if (!hasAIKey) return <AskYourAssistant prompt={`How is ${companyName} doing? Summarise its latest update and metrics.`} className={pushRight ? 'ml-auto' : ''} />

  return (
    <Button
      variant="outline"
      size="sm"
      className={`gap-1.5 h-8 py-2 text-muted-foreground hover:text-foreground ${open ? 'bg-accent' : ''} ${pushRight ? 'ml-auto' : ''}`}
      onClick={toggleOpen}
    >
      <Sparkles className="h-3.5 w-3.5" />
      Analyst
    </Button>
  )
}
