import { redirect } from 'next/navigation'

/**
 * The standalone list is gone: drafts are approved in the Analyst panel, which lists any still
 * waiting. This keeps old links working and renders nothing itself, so it needs no gate.
 */
export default function PendingActionsRedirect() {
  redirect('/dashboard')
}
