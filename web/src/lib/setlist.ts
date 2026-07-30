/**
 * Setlist ordering, following the sampradaya bhajan paddhati.
 *
 * The source document tags many songs with an ordinal role ("01 - Thodaya Mangalam",
 * "09 - Mangalam"), which encodes the traditional order of a session. Auto-order uses
 * that so a selection comes out as a sequence somebody could actually sing, rather than
 * in whatever order it was clicked.
 */

import type { RoleMeta, SongDetail } from './types'

export interface SetlistEntry {
  id: number
  title: string
}

export function autoOrder(songs: SongDetail[], roles: RoleMeta[]): SongDetail[] {
  const roleById = new Map(roles.map((r) => [r.id, r] as const))

  const rank = (song: SongDetail): number => {
    const role = song.role ? roleById.get(song.role) : undefined
    if (role) {
      if (role.pin === 'first') return -1_000_000
      if (role.pin === 'last') return 1_000_000
      return role.order
    }
    // The bare "NN - " ordinal is a weaker signal than a named role but still real.
    if (song.seq !== null) return song.seq * 10
    // Everything unclassified keeps its insertion order, between the pinned ends.
    return 500
  }

  return songs
    .map((song, index) => ({ song, index, rank: rank(song) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.song)
}

export function describeRole(song: SongDetail, roles: RoleMeta[]): string {
  const role = song.role ? roles.find((r) => r.id === song.role) : undefined
  if (role) return role.label
  if (song.seq !== null) return `Step ${String(song.seq).padStart(2, '0')}`
  return ''
}
