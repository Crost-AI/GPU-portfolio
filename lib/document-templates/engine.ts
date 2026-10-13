// A logic-less document template language, interpreted — never compiled to code.
//
// WHY NOT HANDLEBARS. A fund keeps its own LP letter layouts in the database, written by its
// admins, and they are rendered on a server every fund shares. Handlebars compiles a template to
// JavaScript, and its own guidance is not to compile templates from people you don't trust; one
// fund's admin is exactly that to every other fund. So this is a small interpreter over a parsed
// tree: it can look values up, loop, branch and call the fixed helpers below, and nothing else.
// The HTML it produces is printed with JavaScript off and the network blocked
// (renderHtmlToPdf's `offline`), so markup in a template cannot reach anything either.
//
// Syntax (a subset of Handlebars, so templates read familiarly):
//   {{path}}                     value, HTML-escaped     {{status.current.nav}}  {{this}}  {{@index}}  {{../name}}  {{@root.fund}}
//   {{helper arg arg}}           helper call            {{usd status.current.nav}}  {{pct (div a b)}}
//   {{#each list}}…{{else}}…{{/each}}                  @index @first @last; names not found on the item are looked up outward
//   {{#if expr}}…{{else}}…{{/if}}  {{#unless expr}}…{{/unless}}  {{#with expr}}…{{/with}}
//   {{! comment }}
// Strings in arguments use double or single quotes. Helper output that is markup (donut, swatch)
// is passed through; everything else is escaped.

export class SafeHtml {
  constructor(readonly html: string) {}
  toString() { return this.html }
}

export class TemplateError extends Error {}

// ---------------------------------------------------------------- parse

type Expr =
  | { t: 'lit'; v: string | number | boolean | null }
  | { t: 'path'; up: number; root: boolean; local: string | null; parts: string[] }
  | { t: 'call'; name: string; args: Expr[] }

type Node =
  | { t: 'text'; v: string }
  | { t: 'out'; e: Expr }
  | { t: 'block'; name: 'each' | 'if' | 'unless' | 'with'; e: Expr; body: Node[]; alt: Node[] }

const BLOCKS = new Set(['each', 'if', 'unless', 'with'])
const MAX_TEMPLATE = 400_000

function tokenizeExpr(src: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    if (c === '(' || c === ')') { out.push(c); i++; continue }
    if (c === '"' || c === "'") {
      let j = i + 1, s = ''
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) { s += src[j + 1]; j += 2; continue }
        s += src[j++]
      }
      if (j >= src.length) throw new TemplateError(`Unclosed string in {{${src}}}`)
      out.push('\u0000' + s) // marks a string literal
      i = j + 1
      continue
    }
    let j = i
    while (j < src.length && !/[\s()]/.test(src[j])) j++
    out.push(src.slice(i, j))
    i = j
  }
  return out
}

function parseAtom(tok: string, src: string): Expr {
  if (tok.startsWith('\u0000')) return { t: 'lit', v: tok.slice(1) }
  if (/^-?\d+(\.\d+)?$/.test(tok)) return { t: 'lit', v: Number(tok) }
  if (tok === 'true' || tok === 'false') return { t: 'lit', v: tok === 'true' }
  if (tok === 'null') return { t: 'lit', v: null }
  let rest = tok, up = 0, root = false, local: string | null = null
  while (rest.startsWith('../')) { up++; rest = rest.slice(3) }
  if (rest.startsWith('@root')) { root = true; rest = rest.slice(5).replace(/^\./, '') }
  else if (rest.startsWith('@')) { local = rest.slice(1); rest = '' }
  if (rest === 'this' || rest === '.') rest = ''
  else if (rest.startsWith('this.')) rest = rest.slice(5)
  const parts = rest ? rest.split('.') : []
  for (const p of parts) {
    if (!/^[A-Za-z_$][\w$-]*$|^\d+$/.test(p)) throw new TemplateError(`Bad name "${tok}" in {{${src}}}`)
  }
  return { t: 'path', up, root, local, parts }
}

function parseExpr(src: string, helpers: Record<string, unknown>): Expr {
  const toks = tokenizeExpr(src)
  let i = 0
  const seq = (end: string | null): Expr => {
    const items: Expr[] = []
    const heads: string[] = []
    while (i < toks.length && toks[i] !== end) {
      const tok = toks[i++]
      if (tok === ')') throw new TemplateError(`Unbalanced ) in {{${src}}}`)
      if (tok === '(') {
        items.push(seq(')'))
        if (toks[i] !== ')') throw new TemplateError(`Unclosed ( in {{${src}}}`)
        i++
        heads.push('')
      } else {
        items.push(parseAtom(tok, src))
        heads.push(tok)
      }
    }
    if (items.length === 0) throw new TemplateError(`Empty expression in {{${src}}}`)
    const head = heads[0]
    // A lone name is a value, even if a helper shares it (a data field called "quarter").
    if (items.length === 1) return items[0]
    if (head && Object.prototype.hasOwnProperty.call(helpers, head)) return { t: 'call', name: head, args: items.slice(1) }
    if (items.length > 1) throw new TemplateError(`Unknown helper "${head}" in {{${src}}}`)
    return items[0]
  }
  const e = seq(null)
  if (i < toks.length) throw new TemplateError(`Unexpected ) in {{${src}}}`)
  return e
}

export function parseTemplate(src: string, helpers: Record<string, unknown> = HELPERS): Node[] {
  if (src.length > MAX_TEMPLATE) throw new TemplateError(`Template is over ${MAX_TEMPLATE.toLocaleString('en-US')} characters`)
  const root: Node[] = []
  const stack: { node: Extract<Node, { t: 'block' }>; inAlt: boolean }[] = []
  const push = (n: Node) => {
    const top = stack[stack.length - 1]
    if (!top) root.push(n)
    else (top.inAlt ? top.node.alt : top.node.body).push(n)
  }
  const re = /\{\{([\s\S]*?)\}\}/g
  let last = 0, m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    if (m.index > last) push({ t: 'text', v: src.slice(last, m.index) })
    last = re.lastIndex
    const raw = m[1].trim()
    if (raw.startsWith('!')) continue
    if (raw.startsWith('#')) {
      const [, name, rest] = raw.match(/^#(\w+)\s*([\s\S]*)$/) ?? []
      if (!name || !BLOCKS.has(name)) throw new TemplateError(`Unknown block {{${raw}}}`)
      if (!rest) throw new TemplateError(`{{#${name}}} needs an argument`)
      const node = { t: 'block' as const, name: name as 'each', e: parseExpr(rest, helpers), body: [], alt: [] }
      push(node)
      stack.push({ node, inAlt: false })
      continue
    }
    if (raw.startsWith('/')) {
      const top = stack.pop()
      if (!top || top.node.name !== raw.slice(1).trim()) throw new TemplateError(`Unexpected {{${raw}}}`)
      continue
    }
    if (raw === 'else') {
      const top = stack[stack.length - 1]
      if (!top || top.inAlt) throw new TemplateError('Unexpected {{else}}')
      top.inAlt = true
      continue
    }
    push({ t: 'out', e: parseExpr(raw, helpers) })
  }
  if (last < src.length) push({ t: 'text', v: src.slice(last) })
  if (stack.length) throw new TemplateError(`Unclosed {{#${stack[stack.length - 1].node.name}}}`)
  return root
}

// ---------------------------------------------------------------- evaluate

interface Frame { value: unknown; locals: Record<string, unknown> }

const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor'])

/** Own, plain properties only: a template can never reach a prototype. */
export function getPath(value: unknown, parts: string[]): unknown {
  let cur = value
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object' || FORBIDDEN.has(p)) return undefined
    if (!Object.prototype.hasOwnProperty.call(cur, p)) return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

const truthy = (v: unknown) => Array.isArray(v) ? v.length > 0 : !!v

export interface RenderResult { html: string; warnings: string[] }

const MAX_OUTPUT = 8_000_000
const MAX_ITERATIONS = 200_000

export function renderTemplate(src: string | Node[], data: unknown, helpers: Record<string, Helper> = HELPERS): RenderResult {
  const nodes = typeof src === 'string' ? parseTemplate(src, helpers) : src
  const warnings: string[] = []
  const ctx: HelperContext = { warn: m => { if (!warnings.includes(m)) warnings.push(m) } }
  let size = 0, iterations = 0
  const rootFrame: Frame = { value: data, locals: {} }

  const evalExpr = (e: Expr, frames: Frame[]): unknown => {
    if (e.t === 'lit') return e.v
    if (e.t === 'call') return helpers[e.name](ctx, ...e.args.map(a => evalExpr(a, frames)))
    if (e.root) return getPath(data, e.parts)
    const idx = frames.length - 1 - e.up
    if (idx < 0) return undefined
    if (e.local !== null) {
      for (let k = idx; k >= 0; k--) if (e.local in frames[k].locals) return frames[k].locals[e.local]
      return undefined
    }
    if (e.parts.length === 0) return frames[idx].value
    // Not on the current item: look outward, so a loop body can still name top-level fields.
    for (let k = idx; k >= 0; k--) {
      const v = frames[k].value
      if (v != null && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, e.parts[0])) return getPath(v, e.parts)
    }
    return undefined
  }

  const run = (list: Node[], frames: Frame[]): string => {
    let out = ''
    for (const n of list) {
      let piece: string
      if (n.t === 'text') piece = n.v
      else if (n.t === 'out') piece = stringify(evalExpr(n.e, frames))
      else {
        const v = evalExpr(n.e, frames)
        if (n.name === 'if') piece = run(truthy(v) ? n.body : n.alt, frames)
        else if (n.name === 'unless') piece = run(!truthy(v) ? n.body : n.alt, frames)
        else if (n.name === 'with') piece = v != null ? run(n.body, [...frames, { value: v, locals: {} }]) : run(n.alt, frames)
        else {
          const items = Array.isArray(v) ? v : []
          if (items.length === 0) piece = run(n.alt, frames)
          else {
            piece = ''
            items.forEach((item, index) => {
              if (++iterations > MAX_ITERATIONS) throw new TemplateError('Template loops too many times')
              piece += run(n.body, [...frames, { value: item, locals: { index, first: index === 0, last: index === items.length - 1 } }])
            })
          }
        }
      }
      size += piece.length
      if (size > MAX_OUTPUT) throw new TemplateError('Rendered document is too large')
      out += piece
    }
    return out
  }

  return { html: run(nodes, [rootFrame]), warnings }
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

function stringify(v: unknown): string {
  if (v instanceof SafeHtml) return v.html
  if (v == null || v === false) return ''
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  if (typeof v === 'object') return '' // never dump an object into a document
  return escapeHtml(String(v))
}

// ---------------------------------------------------------------- helpers

export interface HelperContext { warn: (message: string) => void }
export type Helper = (ctx: HelperContext, ...args: any[]) => unknown

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const pathParts = (p: unknown) => (typeof p === 'string' && p ? p.split('.') : [])
const at = (item: unknown, path: unknown) => (path ? getPath(item, pathParts(path)) : item)
const fixed = (v: number, d: number) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const dec = (d: unknown, dflt: number) => { const n = num(d); return n === null ? dflt : Math.max(0, Math.min(6, Math.round(n))) }

/** Categorical slots for charts, in fixed order (never cycled); "Other" and overflow are gray. */
export const CHART_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300']
const OTHER = '#8a8983'

export interface Part { label: string; value: number; share: number; color: string }

function toParts(rows: { label: string; value: number }[]): Part[] {
  const total = rows.reduce((s, r) => s + Math.max(0, r.value), 0)
  let slot = 0
  return rows.map(r => ({
    label: r.label,
    value: r.value,
    share: total > 0 ? Math.max(0, r.value) / total : 0,
    color: /^other$/i.test(r.label) || slot >= CHART_COLORS.length ? OTHER : CHART_COLORS[slot++],
  }))
}

const COMPARE: Record<string, (a: any, b: any) => boolean> = {
  eq: (a, b) => a === b, ne: (a, b) => a !== b,
  gt: (a, b) => a > b, gte: (a, b) => a >= b, lt: (a, b) => a < b, lte: (a, b) => a <= b,
}

function donutSvg(parts: Part[], top: string, bottom: string): string {
  const R = 100, r = 62, c = 105, gap = 0.012
  let a = -Math.PI / 2
  const pt = (rad: number, ang: number) => `${(c + rad * Math.cos(ang)).toFixed(2)} ${(c + rad * Math.sin(ang)).toFixed(2)}`
  const arcs = parts.filter(p => p.share > 0).map(p => {
    const sweep = p.share * 2 * Math.PI
    const pad = p.share > gap * 2 ? gap : 0
    const a0 = a + pad, a1 = a + sweep - pad
    a += sweep
    if (p.share >= 0.9999) return `<circle cx="${c}" cy="${c}" r="${(R + r) / 2}" fill="none" stroke="${p.color}" stroke-width="${R - r}"/>`
    const large = a1 - a0 > Math.PI ? 1 : 0
    return `<path d="M${pt(R, a0)} A${R} ${R} 0 ${large} 1 ${pt(R, a1)} L${pt(r, a1)} A${r} ${r} 0 ${large} 0 ${pt(r, a0)} Z" fill="${p.color}"/>`
  }).join('')
  return `<svg viewBox="0 0 210 210" width="210" height="210" role="img" aria-label="${escapeHtml(top)}">${arcs}` +
    `<text x="105" y="101" text-anchor="middle" font-size="11" fill="#76756f">${escapeHtml(top)}</text>` +
    `<text x="105" y="119" text-anchor="middle" font-size="14" font-weight="600" fill="#1a1a19">${escapeHtml(bottom)}</text></svg>`
}

const HELPER_LIST: Record<string, Helper> = {
  // ---- formatting
  /** $1,234 — negatives in parentheses. usd value [decimals=0] */
  usd: (_c, v, d) => { const n = num(v); if (n === null) return ''; const s = '$' + fixed(Math.abs(n), dec(d, 0)); return n < 0 ? `(${s})` : s },
  /** 1,234 — "-" for zero, a leading minus for negatives (schedule style). num value [decimals=0] */
  num: (_c, v, d) => { const n = num(v); if (n === null) return ''; const k = dec(d, 0); if (Math.abs(n) < 0.5 * 10 ** -k) return '-'; return (n < 0 ? '-' : '') + fixed(Math.abs(n), k) },
  /** A fraction as a percentage: pct 0.873 → 87.3%. pct value [decimals=1] */
  pct: (_c, v, d) => { const n = num(v); return n === null ? '' : fixed(n * 100, dec(d, 1)) + '%' },
  /** 0.95x. mult value [decimals=2] */
  mult: (_c, v, d) => { const n = num(v); return n === null ? '' : fixed(n, dec(d, 2)) + 'x' },
  /** date iso ["long" (March 31, 2026) | "short" (3/31) | "month" (Mar-26)] */
  date: (_c, v, style) => {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) return ''
    const d = new Date(v.slice(0, 10) + 'T00:00:00Z')
    if (style === 'short') return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`
    if (style === 'month') return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short' }) + '-' + v.slice(2, 4)
    return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' })
  },
  /** quarter "2026-03-31" → "Q1 2026" */
  quarter: (_c, v) => typeof v === 'string' && /^\d{4}-\d{2}/.test(v) ? `Q${Math.floor((Number(v.slice(5, 7)) - 1) / 3) + 1} ${v.slice(0, 4)}` : '',
  upper: (_c, v) => (v == null ? '' : String(v).toUpperCase()),

  // ---- arithmetic (null in, null out; division by zero is null)
  add: (_c, ...a) => { const n = a.map(num); return n.some(x => x === null) ? null : (n as number[]).reduce((s, x) => s + x, 0) },
  sub: (_c, a, b) => { const x = num(a), y = num(b); return x === null || y === null ? null : x - y },
  mul: (_c, a, b) => { const x = num(a), y = num(b); return x === null || y === null ? null : x * y },
  div: (_c, a, b) => { const x = num(a), y = num(b); return x === null || y === null || y === 0 ? null : x / y },
  abs: (_c, a) => { const x = num(a); return x === null ? null : Math.abs(x) },
  round: (_c, a, d) => { const x = num(a); if (x === null) return null; const f = 10 ** dec(d, 0); return Math.round(x * f) / f },

  // ---- logic
  eq: (_c, a, b) => a === b, ne: (_c, a, b) => a !== b,
  gt: (_c, a, b) => (num(a) ?? NaN) > (num(b) ?? NaN), gte: (_c, a, b) => (num(a) ?? NaN) >= (num(b) ?? NaN),
  lt: (_c, a, b) => (num(a) ?? NaN) < (num(b) ?? NaN), lte: (_c, a, b) => (num(a) ?? NaN) <= (num(b) ?? NaN),
  and: (_c, ...a) => a.every(truthy), or: (_c, ...a) => a.some(truthy), not: (_c, a) => !truthy(a),
  /** near a b [tolerance=0.5] — for tie-outs that rounding can move by a dollar. */
  near: (_c, a, b, t) => { const x = num(a), y = num(b); return x !== null && y !== null && Math.abs(x - y) <= (num(t) ?? 0.5) },
  /** check condition "message" — renders nothing; a false condition is returned to the caller as a warning. */
  check: (c, cond, message) => { if (!truthy(cond)) c.warn(String(message ?? 'A template check failed')); return '' },

  // ---- lists
  count: (_c, l) => list(l).length,
  /** sum list "path.to.number" */
  sum: (_c, l, path) => list(l).reduce<number>((s, item) => s + (num(at(item, path)) ?? 0), 0),
  /** where list "path" op value — op is eq ne gt gte lt lte. */
  where: (_c, l, path, op, value) => {
    const cmp = COMPARE[String(op)]
    if (!cmp) throw new TemplateError(`where: unknown comparison "${op}"`)
    return list(l).filter(item => { const v = at(item, path); return cmp(typeof value === 'number' ? num(v) : v, value) })
  },
  /** join list ["path"] [separator=", "] [lastSeparator=" and "] */
  join: (_c, l, path, sep, lastSep) => {
    const vals = list(l).map(item => at(item, path)).filter(v => v != null && v !== '').map(String)
    const s = typeof sep === 'string' ? sep : ', ', ls = typeof lastSep === 'string' ? lastSep : ' and '
    return vals.length <= 1 ? vals.join('') : vals.slice(0, -1).join(s) + ls + vals[vals.length - 1]
  },
  /**
   * groupSum list "key.path" "value.path" ["Key=Label|Key=Label"] → [{label, value, share, color}].
   * The optional spec fixes the order (and so the colors) and renames keys; keys it doesn't name
   * follow in first-seen order.
   */
  groupSum: (c, l, keyPath, valuePath, spec) => {
    const totals = new Map<string, number>()
    for (const item of list(l)) {
      const k = String(at(item, keyPath) ?? '')
      totals.set(k, (totals.get(k) ?? 0) + (num(at(item, valuePath)) ?? 0))
    }
    const named = typeof spec === 'string' && spec
      ? spec.split('|').map(s => { const [k, label] = s.split('='); return { k: k.trim(), label: (label ?? k).trim() } })
      : []
    const rows: { label: string; value: number }[] = []
    for (const { k, label } of named) if (totals.has(k)) { rows.push({ label, value: totals.get(k)! }); totals.delete(k) }
    for (const [k, value] of totals) {
      if (named.length) c.warn(`groupSum: "${k}" is not in the chart's categories`)
      rows.push({ label: k, value })
    }
    return toParts(rows)
  },
  /** parts list "label.path" "value.path" → [{label, value, share, color}], for a chart or legend. */
  parts: (_c, l, labelPath, valuePath) =>
    toParts(list(l).map(item => ({ label: String(at(item, labelPath) ?? ''), value: num(at(item, valuePath)) ?? 0 }))),
  /** sortBy list "path" ["desc"] */
  sortBy: (_c, l, path, dir) => {
    const s = [...list(l)].sort((a, b) => { const x = at(a, path) as any, y = at(b, path) as any; return x < y ? -1 : x > y ? 1 : 0 })
    return dir === 'desc' ? s.reverse() : s
  },
  /** get object "dynamic.path" */
  get: (_c, o, path) => at(o, path),

  // ---- charts (markup)
  /** donut parts ["center label"] ["center value"] — parts from groupSum or parts. */
  donut: (_c, ps, top, bottom) => new SafeHtml(donutSvg(list(ps) as Part[], String(top ?? ''), String(bottom ?? ''))),
  /** A legend swatch in a part's color. */
  swatch: (_c, color) => {
    const col = typeof color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : OTHER
    return new SafeHtml(`<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${col};margin-right:7px;vertical-align:-1px"></span>`)
  },
}

export const HELPERS: Record<string, Helper> = HELPER_LIST
export const HELPER_NAMES = Object.keys(HELPER_LIST)
