/**
 * Boo design tokens — sumber kebenaran tunggal.
 *
 * File ini sengaja tidak mengimpor apa pun dan tidak menyebut CSS maupun DOM,
 * supaya bisa dipakai oleh web (digenerate jadi CSS custom property) dan oleh
 * CLI `boo` (dibaca langsung sebagai hex untuk Ink). Jangan tambahkan
 * dependency ke file ini.
 *
 * Alur: ubah di sini -> `pnpm tokens` -> src/design/tokens.css ikut terbarui.
 */

/** Nilai yang berbeda antara light dan dark mode. */
export interface ThemedValue {
  light: string
  dark: string
}

export type Theme = 'light' | 'dark'

/** Warna yang membalik mengikuti tema aplikasi. */
export const themedColor = {
  /** Teks dan garis utama. */
  ink: { light: '#000000', dark: '#ffffff' },
  /** Latar halaman dan kartu. */
  surface: { light: '#ffffff', dark: '#171717' },
  /** Latar satu tingkat di atas surface. */
  raised: { light: '#f5f5f5', dark: '#262626' },
  /** Teks sekunder. */
  muted: { light: '#737373', dark: '#a3a3a3' },
  /** Tautan di dalam markdown. */
  link: { light: '#0369a1', dark: '#7dd3fc' },
  /** Warna shadow chunky pada permukaan normal. */
  shadow: { light: '#000000', dark: '#525252' },
  /** Shadow lembut untuk elemen di dalam markdown (tabel, gambar, blok kode). */
  shadowSoft: { light: '#a3a3a3', dark: '#525252' },
} as const satisfies Record<string, ThemedValue>

/** Warna yang sama di kedua tema karena permukaannya memang tidak ikut membalik. */
export const fixedColor = {
  /** Aksen utama Boo. */
  accent: '#7dd3fc',
  accentStrong: '#38bdf8',
  accentInk: '#0c4a6e',
  /** Status merusak / hapus. */
  danger: '#ef4444',
  /** Baris yang ditambah dan dihapus pada pratinjau diff. */
  added: '#4ade80',
  removed: '#f87171',
  dangerStrong: '#dc2626',
  /** Shadow di atas permukaan gelap (bubble user, tombol hitam). */
  shadowInverse: '#a3a3a3',
  /** Shadow di atas permukaan merah. */
  shadowDanger: '#7f1d1d',
  /** Inline code pada jawaban, sama dengan web dark mode. */
  inlineCode: '#fda4af',
  /** Syntax highlighting blok kode. Dipilih agar terbaca di latar gelap. */
  syntaxKeyword: '#c4b5fd',
  syntaxString: '#86efac',
  syntaxNumber: '#fdba74',
  syntaxComment: '#737373',
  syntaxFunction: '#7dd3fc',
  syntaxType: '#fcd34d',
} as const satisfies Record<string, string>

/**
 * Kedalaman shadow chunky 3D dalam piksel.
 * Nilai ini juga dipakai CLI untuk menentukan tebal garis bingkai.
 */
export const depth = {
  xs: 1,
  sm: 2,
  md: 3,
  lg: 4,
  xl: 5,
  '2xl': 8,
} as const

export type DepthName = keyof typeof depth

export const radius = {
  md: '0.5rem',
  lg: '0.75rem',
  xl: '1rem',
  '2xl': '1.25rem',
} as const

export const borderWidth = {
  DEFAULT: '2px',
  thick: '3px',
} as const

export const fontFamily = 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'

/** Bobot huruf khas Boo — tebal dan blocky. */
export const fontWeight = {
  body: 500,
  strong: 800,
  black: 900,
} as const

/**
 * Meratakan token menjadi peta hex untuk satu tema.
 * Dipakai CLI: `resolve('dark').ink` -> '#ffffff'.
 */
export function resolve(theme: Theme): Record<string, string> {
  const resolved: Record<string, string> = { ...fixedColor }
  for (const [name, value] of Object.entries(themedColor)) {
    resolved[name] = value[theme]
  }
  return resolved
}

export const booTokens = {
  themedColor,
  fixedColor,
  depth,
  radius,
  borderWidth,
  fontFamily,
  fontWeight,
  resolve,
} as const
