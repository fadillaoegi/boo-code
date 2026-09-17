/**
 * Syntax highlighting ringan untuk blok kode di jawaban.
 *
 * Bukan parser: satu baris dipecah menjadi komentar, string, angka, dan kata
 * dengan ekspresi reguler. Tujuannya membuat kode lebih mudah dipindai, bukan
 * akurat secara tata bahasa — untuk itu pustaka highlighter lengkap terlalu
 * mahal bagi CLI yang dijalankan berkali-kali. Dipakai CLI dan web.
 */

import { fixedColor } from '../design/tokens.ts'

/** Gaya sorotan; cukup kecil untuk dipetakan ke ANSI di CLI maupun CSS di web. */
export interface SyntaxStyle {
  color?: string
  italic?: boolean
}

export interface SyntaxRun {
  text: string
  style: SyntaxStyle
}

type Family = 'c' | 'python' | 'shell' | 'sql' | 'data' | 'diff' | 'plain'

const FAMILY_BY_LANGUAGE: Record<string, Family> = {
  js: 'c', jsx: 'c', mjs: 'c', cjs: 'c', javascript: 'c',
  ts: 'c', tsx: 'c', typescript: 'c',
  java: 'c', kotlin: 'c', kt: 'c', swift: 'c', dart: 'c',
  c: 'c', h: 'c', cpp: 'c', cc: 'c', hpp: 'c', cs: 'c', csharp: 'c',
  go: 'c', golang: 'c', rust: 'c', rs: 'c', php: 'c', scala: 'c',
  py: 'python', python: 'python', rb: 'python', ruby: 'python',
  sh: 'shell', bash: 'shell', zsh: 'shell', shell: 'shell', console: 'shell', fish: 'shell',
  sql: 'sql', psql: 'sql', mysql: 'sql',
  json: 'data', jsonc: 'data', yaml: 'data', yml: 'data', toml: 'data', env: 'data', ini: 'data',
  diff: 'diff', patch: 'diff',
}

const C_KEYWORDS = new Set([
  'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'default', 'defer', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'final',
  'finally', 'fn', 'for', 'from', 'func', 'function', 'go', 'if', 'impl', 'implements', 'import',
  'in', 'instanceof', 'interface', 'let', 'match', 'mod', 'mut', 'new', 'nil', 'null', 'of',
  'override', 'package', 'private', 'protected', 'pub', 'public', 'readonly', 'return', 'self',
  'static', 'struct', 'super', 'switch', 'this', 'throw', 'throws', 'trait', 'true', 'try', 'type',
  'typeof', 'undefined', 'use', 'var', 'void', 'where', 'while', 'yield',
])

const PYTHON_KEYWORDS = new Set([
  'and', 'as', 'assert', 'async', 'await', 'begin', 'break', 'class', 'continue', 'def', 'del',
  'do', 'elif', 'else', 'end', 'ensure', 'except', 'False', 'finally', 'for', 'from', 'global',
  'if', 'import', 'in', 'is', 'lambda', 'module', 'nil', 'None', 'nonlocal', 'not', 'or', 'pass',
  'raise', 'rescue', 'return', 'self', 'True', 'try', 'unless', 'while', 'with', 'yield',
])

const SHELL_KEYWORDS = new Set([
  'case', 'do', 'done', 'elif', 'else', 'esac', 'export', 'fi', 'for', 'function', 'if', 'in',
  'local', 'return', 'then', 'until', 'while',
])

const SQL_KEYWORDS = new Set([
  'add', 'alter', 'and', 'as', 'asc', 'by', 'create', 'delete', 'desc', 'distinct', 'drop',
  'from', 'group', 'having', 'in', 'index', 'inner', 'insert', 'into', 'is', 'join', 'key',
  'left', 'like', 'limit', 'not', 'null', 'on', 'or', 'order', 'primary', 'references', 'right',
  'select', 'set', 'table', 'union', 'update', 'values', 'where',
])

const DATA_KEYWORDS = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off'])

const STYLE = {
  plain: {} as SyntaxStyle,
  keyword: { color: fixedColor.syntaxKeyword },
  string: { color: fixedColor.syntaxString },
  number: { color: fixedColor.syntaxNumber },
  comment: { color: fixedColor.syntaxComment, italic: true },
  fn: { color: fixedColor.syntaxFunction },
  type: { color: fixedColor.syntaxType },
  added: { color: fixedColor.added },
  removed: { color: fixedColor.removed },
  hunk: { color: fixedColor.accent },
}

function familyOf(language: string): Family {
  return FAMILY_BY_LANGUAGE[language.toLowerCase()] ?? 'plain'
}

function commentPattern(family: Family): string {
  switch (family) {
    case 'c': return '\\/\\/.*|\\/\\*.*?(?:\\*\\/|$)'
    case 'python':
    case 'shell':
    case 'data': return '#.*'
    case 'sql': return '--.*'
    default: return ''
  }
}

function keywordsOf(family: Family): Set<string> {
  switch (family) {
    case 'c': return C_KEYWORDS
    case 'python': return PYTHON_KEYWORDS
    case 'shell': return SHELL_KEYWORDS
    case 'sql': return SQL_KEYWORDS
    case 'data': return DATA_KEYWORDS
    default: return new Set()
  }
}

/** Menyorot satu baris kode menurut bahasanya; bahasa tak dikenal tidak disorot. */
export function highlightLine(line: string, language: string): SyntaxRun[] {
  const family = familyOf(language)
  if (family === 'plain') return [{ text: line, style: STYLE.plain }]

  if (family === 'diff') {
    if (line.startsWith('+') && !line.startsWith('+++')) return [{ text: line, style: STYLE.added }]
    if (line.startsWith('-') && !line.startsWith('---')) return [{ text: line, style: STYLE.removed }]
    if (line.startsWith('@@')) return [{ text: line, style: STYLE.hunk }]
    return [{ text: line, style: STYLE.plain }]
  }

  const comment = commentPattern(family)
  const token = new RegExp(
    [
      comment && `(?<comment>${comment})`,
      '(?<string>"(?:\\\\.|[^"\\\\])*"?|\'(?:\\\\.|[^\'\\\\])*\'?|`(?:\\\\.|[^`\\\\])*`?)',
      '(?<number>\\b(?:0x[0-9a-fA-F]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b)',
      '(?<word>[A-Za-z_$][\\w$]*)',
    ].filter(Boolean).join('|'),
    'g',
  )
  const keywords = keywordsOf(family)
  const caseInsensitive = family === 'sql'
  const runs: SyntaxRun[] = []
  let cursor = 0

  for (const match of line.matchAll(token)) {
    const index = match.index ?? 0
    if (index > cursor) runs.push({ text: line.slice(cursor, index), style: STYLE.plain })
    const text = match[0]
    const groups = match.groups ?? {}
    let style = STYLE.plain
    if (groups.comment) style = STYLE.comment
    else if (groups.string) style = STYLE.string
    else if (groups.number) style = STYLE.number
    else if (groups.word) {
      const lookup = caseInsensitive ? text.toLowerCase() : text
      if (keywords.has(lookup)) style = STYLE.keyword
      else if (family === 'data' && line.slice(index + text.length).trimStart().startsWith(':')) style = STYLE.fn
      else if (/^\s*\(/.test(line.slice(index + text.length))) style = STYLE.fn
      else if (family !== 'data' && /^[A-Z][a-z]/.test(text)) style = STYLE.type
    }
    runs.push({ text, style })
    cursor = index + text.length
  }
  if (cursor < line.length) runs.push({ text: line.slice(cursor), style: STYLE.plain })
  return runs
}
