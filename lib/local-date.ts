/**
 * Calendar dates in the user's own time zone, for client-side defaults.
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC date: a US user after ~5pm gets tomorrow,
 * which lands an entry in the next period (or is refused when that period is closed). A default
 * the user sees as "today" must read the local calendar.
 */

/** YYYY-MM-DD of `d` in the local time zone. */
export function toLocalIsoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Today's YYYY-MM-DD in the local time zone. */
export function todayLocalIso(): string {
  return toLocalIsoDate(new Date())
}
