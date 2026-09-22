/**
 * Unsur tampilan percakapan yang dipakai bersama CLI dan web.
 *
 * Riwayat pesan mentah memuat hal yang tidak pernah ditampilkan apa adanya: isi
 * berkas di hasil tool, catatan /undo, permintaan mode spec yang panjang, dan tanda
 * pembatalan. Unsur di sini adalah bentuk yang sudah siap ditampilkan; CLI
 * menggambarnya sebagai teks berwarna, web sebagai elemen HTML.
 *
 * Modul ini tidak mengimpor apa pun dari Node, agar dapat dipakai di browser.
 */

import type { TodoItem } from '../tools/todo.ts'
import type { Phase } from './phases.ts'

export type ViewItem =
  | {
      kind: 'user'
      id: string
      text: string
      /** Nama attachment gambar; byte gambar tidak pernah masuk event UI. */
      attachments?: string[]
      /** Judul permintaan mode spec; isinya yang panjang tidak ditampilkan. */
      spec?: string
      /** Permintaan ini didahului /undo. */
      afterUndo?: boolean
      /** Koreksi yang dikirim ketika request sebelumnya masih berjalan. */
      steering?: boolean
    }
  | { kind: 'answer'; id: string; markdown: string }
  | {
      kind: 'phase'
      id: string
      phase: Phase
      summary: string
      durationMs?: number
      /** Fase masih berjalan; ringkasannya dapat berubah. */
      live?: boolean
    }
  | { kind: 'todos'; id: string; items: TodoItem[] }
  /** Keputusan izin, misalnya "Ubah berkas app.ts · diizinkan". */
  | { kind: 'decision'; id: string; allowed: boolean; text: string }
  | { kind: 'notice'; id: string; variant: NoticeVariant; text: string }

export type NoticeVariant =
  | 'cancelled'
  | 'error'
  | 'turn-limit'
  | 'info'
  | 'retry'
  | 'compacted'
  | 'undo'
  | 'success'
