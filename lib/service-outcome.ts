// What a shared write function returns when the web route and the agent tool both call it.
//
// The route turns it into a response with the same status and body it always sent; the tool turns
// a failure into an error the assistant reads. So a refusal is worded once, and a rule added to the
// function reaches both doors.

import { NextResponse } from 'next/server'

export type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string; extra?: Record<string, unknown> }

export const done = <T>(value: T): Outcome<T> => ({ ok: true, value })

export const fail = (status: number, error: string, extra?: Record<string, unknown>): Outcome<never> =>
  ({ ok: false, status, error, ...(extra ? { extra } : {}) })

/** A database error: logged with its context, reported without its detail. */
export function dbFail(error: { message: string } | null | undefined, context: string): Outcome<never> {
  console.error(`[${context}]`, error?.message ?? 'unknown error')
  return fail(500, 'An unexpected error occurred.')
}

/** For a route: the value as the JSON body, or the refusal with its status. */
export function outcomeResponse<T>(o: Outcome<T>, body?: (value: T) => unknown): NextResponse {
  if (o.ok) return NextResponse.json(body ? body(o.value) : o.value)
  return NextResponse.json({ error: o.error, ...(o.extra ?? {}) }, { status: o.status })
}

/** For a tool: the value, or the refusal as an error. */
export function unwrap<T>(o: Outcome<T>): T {
  if (o.ok) return o.value
  throw new Error(o.error)
}
