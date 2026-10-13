// The query tools' engine: filter, group, aggregate, sort and trim rows a dataset already loaded.
//
// It never touches the database. Every dataset (datasets.ts) loads its rows through the same
// scoped function a named tool uses, so this can only ever reshape what the caller could already
// read; the long tail of questions becomes a matter of arithmetic over those rows, not a new way in.

export type ColumnType = 'string' | 'number' | 'date' | 'boolean' | 'list'

export interface Column {
  name: string
  type: ColumnType
  description?: string
}

export const FILTER_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'not_in', 'contains', 'is_null', 'not_null'] as const
export type FilterOp = typeof FILTER_OPS[number]
export const AGGREGATES = ['count', 'count_distinct', 'sum', 'avg', 'min', 'max', 'median'] as const
export type AggregateFn = typeof AGGREGATES[number]
export const DATE_BUCKETS = ['day', 'month', 'quarter', 'year'] as const
export type DateBucket = typeof DATE_BUCKETS[number]

export interface Filter { column: string; op: FilterOp; value?: unknown }
export interface Aggregate { fn: AggregateFn; column?: string; as?: string }
export interface OrderBy { column: string; direction?: 'asc' | 'desc' }
export interface QuerySpec {
  columns?: string[]
  where?: Filter[]
  /** A column, or `column:bucket` for a date column (e.g. `date:quarter`). */
  group_by?: string[]
  aggregates?: Aggregate[]
  order_by?: OrderBy[]
  limit?: number
}

export interface QueryResult {
  columns: string[]
  rows: Record<string, unknown>[]
  /** Rows matching the filters (before grouping and the limit). */
  matched: number
  truncated: boolean
}

export const MAX_ROWS = 500
const DEFAULT_ROWS = 100

export class QueryError extends Error {}

function columnOf(columns: Column[], name: unknown, what: string): Column {
  const c = columns.find(c => c.name === name)
  if (!c) throw new QueryError(`${what}: unknown column "${String(name)}". Columns: ${columns.map(c => c.name).join(', ')}`)
  return c
}

const isNil = (v: unknown) => v === null || v === undefined || v === ''

function toNumber(v: unknown): number | null {
  if (isNil(v)) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** Comparable form: numbers as numbers, dates and strings as lower-cased strings (ISO dates sort). */
function comparable(col: Column, v: unknown): number | string | null {
  if (isNil(v)) return null
  if (col.type === 'number') return toNumber(v)
  if (col.type === 'boolean') return v === true || v === 'true' ? 1 : 0
  if (col.type === 'date') return String(v).slice(0, 10)
  return String(v).toLowerCase()
}

function matches(col: Column, raw: unknown, f: Filter): boolean {
  if (f.op === 'is_null') return isNil(raw) || (Array.isArray(raw) && raw.length === 0)
  if (f.op === 'not_null') return !(isNil(raw) || (Array.isArray(raw) && raw.length === 0))

  if (col.type === 'list') {
    const items = (Array.isArray(raw) ? raw : []).map(x => String(x).toLowerCase())
    const wanted = (Array.isArray(f.value) ? f.value : [f.value]).map(x => String(x).toLowerCase())
    switch (f.op) {
      case 'contains': return items.some(i => wanted.some(w => i.includes(w)))
      case 'eq': case 'in': return items.some(i => wanted.includes(i))
      case 'neq': case 'not_in': return !items.some(i => wanted.includes(i))
      default: throw new QueryError(`${col.name} is a list: use contains, in, not_in, eq, neq, is_null or not_null.`)
    }
  }

  const v = comparable(col, raw)
  if (f.op === 'contains') return v !== null && String(v).includes(String(f.value ?? '').toLowerCase())
  if (f.op === 'in' || f.op === 'not_in') {
    if (!Array.isArray(f.value)) throw new QueryError(`${f.op} on ${col.name} needs a list of values.`)
    const hit = f.value.map(x => comparable(col, x)).includes(v)
    return f.op === 'in' ? hit : !hit
  }
  if (f.op === 'between') {
    if (!Array.isArray(f.value) || f.value.length !== 2) throw new QueryError(`between on ${col.name} needs [low, high].`)
    const [lo, hi] = f.value.map(x => comparable(col, x))
    return v !== null && lo !== null && hi !== null && v >= lo && v <= hi
  }
  const w = comparable(col, f.value)
  if (f.op === 'eq') return v === w
  if (f.op === 'neq') return v !== w
  if (v === null || w === null) return false
  switch (f.op) {
    case 'gt': return v > w
    case 'gte': return v >= w
    case 'lt': return v < w
    case 'lte': return v <= w
  }
  throw new QueryError(`Unknown filter op "${String(f.op)}". Use one of ${FILTER_OPS.join(', ')}.`)
}

function bucket(value: unknown, b: DateBucket): string | null {
  if (isNil(value)) return null
  const d = String(value).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null
  if (b === 'day') return d
  if (b === 'month') return d.slice(0, 7)
  if (b === 'year') return d.slice(0, 4)
  return `${d.slice(0, 4)}-Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`
}

const round = (n: number) => Math.round(n * 1e6) / 1e6

function aggregate(fn: AggregateFn, values: unknown[]): number | string | null {
  if (fn === 'count') return values.length
  const present = values.filter(v => !isNil(v))
  if (fn === 'count_distinct') return new Set(present.map(v => String(v))).size
  if (fn === 'min' || fn === 'max') {
    if (present.length === 0) return null
    const nums = present.map(toNumber)
    if (nums.every(n => n !== null)) return (fn === 'min' ? Math.min : Math.max)(...(nums as number[]))
    const s = present.map(String).sort()
    return fn === 'min' ? s[0] : s[s.length - 1]
  }
  const nums = present.map(toNumber).filter((n): n is number => n !== null)
  if (nums.length === 0) return fn === 'sum' ? 0 : null
  if (fn === 'sum') return round(nums.reduce((a, b) => a + b, 0))
  if (fn === 'avg') return round(nums.reduce((a, b) => a + b, 0) / nums.length)
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2)
}

export function runQuery(rows: Record<string, unknown>[], columns: Column[], spec: QuerySpec = {}): QueryResult {
  const where = Array.isArray(spec.where) ? spec.where : []
  for (const f of where) {
    if (!(FILTER_OPS as readonly string[]).includes(f?.op)) throw new QueryError(`Unknown filter op "${String(f?.op)}". Use one of ${FILTER_OPS.join(', ')}.`)
  }
  const filters = where.map(f => ({ f, col: columnOf(columns, f.column, 'where') }))
  const matched = rows.filter(r => filters.every(({ f, col }) => matches(col, r[col.name], f)))

  const groupBy = Array.isArray(spec.group_by) ? spec.group_by : []
  const aggs = Array.isArray(spec.aggregates) ? spec.aggregates : []
  let out: Record<string, unknown>[]
  let outColumns: Column[]

  if (groupBy.length || aggs.length) {
    const keys = groupBy.map(g => {
      const [name, b] = String(g).split(':')
      const col = columnOf(columns, name, 'group_by')
      if (b && (col.type !== 'date' || !(DATE_BUCKETS as readonly string[]).includes(b))) {
        throw new QueryError(`group_by "${g}": only a date column takes a bucket (${DATE_BUCKETS.join(', ')}).`)
      }
      if (col.type === 'list') throw new QueryError(`group_by: ${col.name} is a list; filter on it with contains instead.`)
      return { label: b ? `${name}_${b}` : name, read: (r: Record<string, unknown>) => (b ? bucket(r[name], b as DateBucket) : r[name] ?? null) }
    })
    const specs = (aggs.length ? aggs : [{ fn: 'count' as const }]).map(a => {
      if (!(AGGREGATES as readonly string[]).includes(a?.fn)) throw new QueryError(`Unknown aggregate "${String(a?.fn)}". Use one of ${AGGREGATES.join(', ')}.`)
      if (a.fn !== 'count' && !a.column) throw new QueryError(`${a.fn} needs a column.`)
      const col = a.column ? columnOf(columns, a.column, a.fn) : null
      if (col && ['sum', 'avg', 'median'].includes(a.fn) && col.type !== 'number') throw new QueryError(`${a.fn} needs a number column; ${col.name} is ${col.type}.`)
      return { ...a, label: a.as || (col ? `${a.fn}_${col.name}` : a.fn) }
    })
    const groups = new Map<string, { key: unknown[]; rows: Record<string, unknown>[] }>()
    for (const r of matched) {
      const key = keys.map(k => k.read(r))
      const id = JSON.stringify(key)
      const g = groups.get(id) ?? { key, rows: [] }
      g.rows.push(r)
      groups.set(id, g)
    }
    out = Array.from(groups.values()).map(g => {
      const row: Record<string, unknown> = {}
      keys.forEach((k, i) => { row[k.label] = g.key[i] })
      for (const a of specs) row[a.label] = aggregate(a.fn, a.column ? g.rows.map(r => r[a.column!]) : g.rows)
      return row
    })
    outColumns = [
      ...keys.map(k => ({ name: k.label, type: 'string' as const })),
      ...specs.map(a => ({ name: a.label, type: 'number' as const })),
    ]
  } else {
    const pick = Array.isArray(spec.columns) && spec.columns.length ? spec.columns.map(c => columnOf(columns, c, 'columns')) : columns
    out = matched.map(r => Object.fromEntries(pick.map(c => [c.name, r[c.name] ?? null])))
    outColumns = pick
  }

  const order = Array.isArray(spec.order_by) ? spec.order_by : []
  if (order.length) {
    const sorters = order.map(o => {
      const col = outColumns.find(c => c.name === o.column) ?? columnOf(columns, o.column, 'order_by')
      if (!outColumns.some(c => c.name === col.name)) throw new QueryError(`order_by: ${col.name} is not in the result.`)
      return { col, dir: o.direction === 'desc' ? -1 : 1 }
    })
    out.sort((a, b) => {
      for (const { col, dir } of sorters) {
        const x = comparable(col.type === 'list' ? { ...col, type: 'string' } : col, a[col.name])
        const y = comparable(col.type === 'list' ? { ...col, type: 'string' } : col, b[col.name])
        if (x === y) continue
        if (x === null) return 1
        if (y === null) return -1
        return (x < y ? -1 : 1) * dir
      }
      return 0
    })
  }

  const limit = Math.max(1, Math.min(Number(spec.limit) || DEFAULT_ROWS, MAX_ROWS))
  return { columns: outColumns.map(c => c.name), rows: out.slice(0, limit), matched: matched.length, truncated: out.length > limit }
}

/** The JSON Schema for a query against these columns, for a tool's inputSchema. */
export function querySchema(columns: string[]) {
  const col = { type: 'string', enum: columns }
  return {
    columns: { type: 'array', items: col, description: 'Columns to return (ungrouped). Default: all.' },
    where: {
      type: 'array',
      description: 'Filters, all of which must hold. between takes [low, high]; in and not_in take a list; is_null and not_null take no value.',
      items: {
        type: 'object',
        properties: { column: col, op: { type: 'string', enum: FILTER_OPS }, value: {} },
        required: ['column', 'op'],
      },
    },
    group_by: {
      type: 'array', items: { type: 'string' },
      description: `Columns to group by. A date column can be bucketed as column:${DATE_BUCKETS.join('|')} (e.g. date:quarter).`,
    },
    aggregates: {
      type: 'array',
      description: 'Per group (or over every row when there is no group_by). Default: count.',
      items: {
        type: 'object',
        properties: { fn: { type: 'string', enum: AGGREGATES }, column: col, as: { type: 'string' } },
        required: ['fn'],
      },
    },
    order_by: {
      type: 'array',
      items: { type: 'object', properties: { column: { type: 'string' }, direction: { type: 'string', enum: ['asc', 'desc'] } }, required: ['column'] },
    },
    limit: { type: 'integer', minimum: 1, maximum: MAX_ROWS, description: `Rows to return. Default ${DEFAULT_ROWS}.` },
  }
}
