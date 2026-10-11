import sanitize from 'sanitize-html'

/**
 * Allowlist sanitization for GP-authored letter HTML, which is rendered into LP browsers through
 * `dangerouslySetInnerHTML`.
 *
 * WHAT WAS WRONG (SEC-004). The previous implementation was a chain of regular expressions, and it
 * neutralized dangerous URI schemes only inside QUOTED attribute values:
 *
 *     .replace(/(href|src)\s*=\s*"(?:\s*(?:javascript|vbscript|data)\s*:)[^"]*"/gi, …)
 *
 * so `<a href="javascript:alert(1)">` was caught and `<a href=javascript:alert(1)>` — the same
 * thing without quotes, which HTML permits — went through untouched and was then rendered. Regex
 * cannot do this job: it has to agree with a browser's HTML parser about where an attribute
 * begins and ends, and it never will. Every bypass in this class comes from that disagreement —
 * unquoted values, entity-encoded schemes, embedded newlines and nulls, `<svg>` and MathML
 * foreign-content switches, namespace confusion, mixed case.
 *
 * So this parses instead of pattern-matching. sanitize-html runs a real HTML tokenizer (htmlparser2),
 * keeps only what is named below, and re-serializes from the parse — so the output is markup it
 * wrote itself, with every text node and attribute value escaped, never a filtered copy of the
 * input. It runs in the browser and in Node from the same import, which matters because one of the
 * four call sites is a client component (app/(app)/letters/[id]/page.tsx).
 *
 * WHY NOT DOMPURIFY. This was isomorphic-dompurify, which needs jsdom on the server. jsdom would
 * not load in the deployed functions: every route that imported this file — the letter routes, and
 * through lib/lp-report-pdf.ts every PDF route, the assistant's report links included — died at
 * module load with an empty 500, while the same build worked locally. Externalising it moved the
 * failure rather than fixing it. sanitize-html is plain JavaScript with no DOM to provide, so there
 * is nothing to externalise and nothing to fail to load. lib/sanitize.test.ts pins the policy on
 * OUTPUT, which is what made the swap checkable.
 *
 * WHAT IS ALLOWED is deliberately close to what `buildPortfolioTableHtml` actually emits
 * (lib/lp-letters/generate.ts): a table, `colspan`, `<strong>`, and two inline styles. The letter
 * body itself is stored separately as `full_draft` and rendered as TEXT, so nothing here needs to
 * support rich prose.
 *
 * WHERE IT RUNS: at persistence (the generate route) and again at every render/serve boundary. Both
 * ends, because the threat model is a row written directly through the Data API rather than a bad
 * generator — SEC-002 narrowed who can do that, but "narrowed" is not "nobody".
 */

/** Schemes an `href` may use. Everything else — javascript:, data:, vbscript:, file: — is dropped. */
const ALLOWED_SCHEMES = ['http', 'https', 'mailto']

/**
 * CSS declarations that survive on a `style` attribute.
 *
 * An allowlist rather than a filter: `style` is an injection surface of its own (`url(...)`,
 * `expression(...)`, `-moz-binding`), and the generator only ever needs alignment. A declaration
 * that is not exactly one of these is discarded, not repaired.
 */
const ALLOWED_STYLE: Record<string, RegExp> = {
  'text-align': /^(left|right|center|justify)$/,
  'text-transform': /^(capitalize|uppercase|lowercase|none)$/,
  'font-weight': /^(normal|bold|[1-9]00)$/,
  'vertical-align': /^(top|middle|bottom|baseline)$/,
  'white-space': /^(nowrap|normal|pre-wrap)$/,
}

const ALLOWED_TAGS = [
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'p', 'br', 'div', 'span', 'strong', 'em', 'b', 'i', 'u', 'small',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'a',
]
const ALLOWED_ATTR = ['colspan', 'rowspan', 'style', 'title', 'scope', 'align']

/**
 * Reduce a `style` attribute to the declarations named in ALLOWED_STYLE; undefined when none
 * survive, so the attribute goes rather than lingering empty.
 *
 * Done here rather than with sanitize-html's own `allowedStyles`, which lets each value through on
 * a per-property regex but parses with postcss first — a second parser to agree with, for five
 * keyword-only properties. Splitting on `;` and `:` is safe for exactly that reason: no allowed
 * value can contain either, so a declaration that does is one we drop anyway.
 */
function filterStyle(style: string | undefined): string | undefined {
  if (!style) return undefined
  const kept = style
    .split(';')
    .map(declaration => {
      const index = declaration.indexOf(':')
      if (index === -1) return null
      const property = declaration.slice(0, index).trim().toLowerCase()
      const value = declaration.slice(index + 1).trim().toLowerCase()
      const allowed = ALLOWED_STYLE[property]
      return allowed && allowed.test(value) ? `${property}:${value}` : null
    })
    .filter((declaration): declaration is string => declaration !== null)
  return kept.length ? kept.join(';') : undefined
}

const CONFIG: sanitize.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    '*': ALLOWED_ATTR,
    a: ['href', 'target', 'rel'],
  },
  allowedSchemes: ALLOWED_SCHEMES,
  allowedSchemesAppliedToAttributes: ['href'],
  // Our own filter above; turning sanitize-html's off keeps postcss out of the path entirely.
  parseStyleAttributes: false,
  // A disallowed element is dropped and its text kept — a disallowed wrapper should not take the
  // letter's words with it. EXCEPT for the elements whose content is not text: keeping their
  // children would re-parent bytes that were never markup into a context where they are.
  disallowedTagsMode: 'discard',
  nonTextTags: [
    'script', 'style', 'textarea', 'option', 'noscript', 'template', 'iframe', 'object', 'embed',
    'svg', 'math', 'video', 'audio', 'noembed', 'noframes', 'xmp', 'plaintext', 'title',
  ],
  allowVulnerableTags: false,
  transformTags: {
    '*': (tagName, attribs) => {
      const { style, ...rest } = attribs
      const filtered = filterStyle(style)
      return { tagName, attribs: filtered ? { ...rest, style: filtered } : rest }
    },
    /**
     * An `<a>` still opens in the LP's tab and still hands the destination a `window.opener`.
     * Letters are read by people who did not write them, so links leave with the usual
     * mitigations attached — whatever the source said about target and rel is overwritten.
     */
    a: (tagName, attribs) => {
      const { style, target: _target, rel: _rel, ...rest } = attribs
      const filtered = filterStyle(style)
      return {
        tagName,
        attribs: {
          ...rest,
          ...(filtered ? { style: filtered } : {}),
          ...(rest.href ? { target: '_blank', rel: 'noopener noreferrer nofollow' } : {}),
        },
      }
    },
  },
}

/**
 * Sanitize letter HTML for storage or for rendering.
 *
 * Null and undefined pass through unchanged so the call sites can keep treating "no table" as a
 * distinct state from "an empty table".
 */
export function sanitizeLetterHtml(html: string | null | undefined): string | null {
  if (!html) return html ?? null
  return sanitize(html, CONFIG)
}
