/**
 * Where /auth sends a user after it exchanges a landing `?code=`.
 *
 * Recovery is decided by the flow that sent the link, never by `user.recovery_sent_at`: GoTrue sets
 * that on a magic-link sign-in of an existing user too (it logs `user_recovery_requested`), so a
 * magic-link landing used to be sent to the password-reset page. The recovery flow says so
 * explicitly: `next=/auth/reset-password` (forgot-password's redirectTo) or `type=recovery`.
 */
export const RESET_PASSWORD_PATH = '/auth/reset-password'

/** `next` is the already-validated (safeNextPath) value; `type` is the raw `type` query param. */
export function isRecoveryLanding(next: string | null, type: string | null): boolean {
  return next === RESET_PASSWORD_PATH || type === 'recovery'
}

export function codeLandingDestination(opts: {
  next: string | null
  recovery: boolean
  /** Only consulted when not a recovery: a password reset keeps its destination without a fund. */
  hasFund: boolean
  mfaPending: boolean
}): string {
  let destination = opts.recovery ? RESET_PASSWORD_PATH : (opts.next ?? '/')
  // Everything but a recovery (including a pending OAuth authorization) needs a fund to land in.
  if (!opts.recovery && !opts.hasFund) destination = '/onboarding?confirmed=true'
  return opts.mfaPending ? `/auth/mfa-verify?next=${encodeURIComponent(destination)}` : destination
}
