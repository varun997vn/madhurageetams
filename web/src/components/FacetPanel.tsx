import { useMemo, useState } from 'react'
import { fold } from '../lib/fold'
import { clearFacet, toggleFacet } from '../lib/hashState'
import { ALL_FACETS, type FacetName, type FacetValueCount, type Filters } from '../lib/types'

const LABELS: Record<FacetName, string> = {
  occasions: 'Occasion',
  deity: 'Deity',
  ragam: 'Ragam',
  thalam: 'Thalam',
  composer: 'Composer',
  language: 'Language',
  catalog: 'Category',
  albums: 'Album',
  singers: 'Singer',
}

// The facet order is the order people actually reach for, not alphabetical.
const ORDER: FacetName[] = [
  'occasions', 'deity', 'ragam', 'thalam', 'composer', 'language', 'catalog', 'albums', 'singers',
]

const MULTI_VALUED = new Set<FacetName>(['ragam', 'thalam', 'catalog', 'occasions', 'albums', 'singers'])
const COLLAPSED_COUNT = 10

interface Props {
  counts: Record<FacetName, FacetValueCount[]>
  unsetCounts: Partial<Record<FacetName, number>>
  filters: Filters
  occasionLabels: Map<string, string>
  onChange: (filters: Filters) => void
}

export function FacetPanel({ counts, unsetCounts, filters, occasionLabels, onChange }: Props) {
  return (
    <div className="facets">
      {ORDER.map((facet) => (
        <FacetGroup
          key={facet}
          facet={facet}
          rows={counts[facet] ?? []}
          unsetCount={unsetCounts[facet] ?? 0}
          filters={filters}
          occasionLabels={occasionLabels}
          onChange={onChange}
        />
      ))}
    </div>
  )
}

function FacetGroup({
  facet,
  rows,
  unsetCount,
  filters,
  occasionLabels,
  onChange,
}: {
  facet: FacetName
  rows: FacetValueCount[]
  unsetCount: number
  filters: Filters
  occasionLabels: Map<string, string>
  onChange: (filters: Filters) => void
}) {
  const selectedCount = (filters.values[facet]?.length ?? 0) + (filters.unset[facet] ? 1 : 0)
  const [open, setOpen] = useState(selectedCount > 0 || facet === 'occasions' || facet === 'deity')
  const [needle, setNeedle] = useState('')
  const [showAll, setShowAll] = useState(false)

  const display = (row: FacetValueCount) =>
    facet === 'occasions' ? (occasionLabels.get(row.label) ?? row.label) : row.label

  const filtered = useMemo(() => {
    const folded = fold(needle)
    const matching = folded
      ? rows.filter((r) => fold(display(r)).includes(folded))
      : rows
    // Selected first, then by count. Zero-count values sink but are never hidden:
    // options that disappear as you filter make the corpus feel smaller than it is.
    return [...matching].sort((a, b) => {
      if (a.selected !== b.selected) return a.selected ? -1 : 1
      if ((a.count === 0) !== (b.count === 0)) return a.count === 0 ? 1 : -1
      return b.count - a.count
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, needle, facet, occasionLabels])

  if (rows.length === 0 && unsetCount === 0) return null

  const visible = showAll ? filtered : filtered.slice(0, COLLAPSED_COUNT)
  // 294 ragams and 543 categories are unusable as a flat list.
  const searchable = rows.length > 14

  return (
    <section className="facet-group">
      <button
        className="facet-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        {LABELS[facet]}
        <span className="count">{selectedCount > 0 ? `${selectedCount} selected` : rows.length}</span>
      </button>

      {open ? (
        <div className="facet-body">
          {searchable ? (
            <input
              className="field facet-search"
              placeholder={`Filter ${LABELS[facet].toLowerCase()}…`}
              value={needle}
              onChange={(e) => setNeedle(e.target.value)}
            />
          ) : null}

          {MULTI_VALUED.has(facet) && (filters.values[facet]?.length ?? 0) > 1 ? (
            <div className="facet-mode">
              match
              <button
                className={`chip ${filters.modes[facet] !== 'and' ? 'chip-active' : ''}`}
                onClick={() => onChange({ ...filters, modes: { ...filters.modes, [facet]: 'or' } })}
              >
                any
              </button>
              <button
                className={`chip ${filters.modes[facet] === 'and' ? 'chip-active' : ''}`}
                onClick={() => onChange({ ...filters, modes: { ...filters.modes, [facet]: 'and' } })}
              >
                all
              </button>
            </div>
          ) : null}

          <div className="facet-options">
            {visible.map((row) => (
              <button
                key={row.index}
                className="facet-option"
                data-selected={row.selected}
                data-empty={row.count === 0}
                onClick={() => onChange(toggleFacet(filters, facet, row.index))}
                aria-pressed={row.selected}
              >
                <span aria-hidden="true">{row.selected ? '☑' : '☐'}</span>
                <span className="name" title={display(row)}>{display(row)}</span>
                <span className="n">{row.count.toLocaleString()}</span>
              </button>
            ))}

            {unsetCount > 0 ? (
              <button
                className="facet-option"
                data-selected={filters.unset[facet] ?? false}
                onClick={() =>
                  onChange({
                    ...filters,
                    unset: { ...filters.unset, [facet]: !filters.unset[facet] },
                  })
                }
                aria-pressed={filters.unset[facet] ?? false}
              >
                <span aria-hidden="true">{filters.unset[facet] ? '☑' : '☐'}</span>
                {/* An explicit bucket, because 4,290 songs have no recorded thalam and
                    silently omitting them would misrepresent the corpus. */}
                <span className="name dim">Not specified</span>
                <span className="n">{unsetCount.toLocaleString()}</span>
              </button>
            ) : null}
          </div>

          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {filtered.length > COLLAPSED_COUNT ? (
              <button className="btn btn-ghost btn-sm" onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Show less' : `Show all ${filtered.length}`}
              </button>
            ) : null}
            {selectedCount > 0 ? (
              <button className="btn btn-ghost btn-sm" onClick={() => onChange(clearFacet(filters, facet))}>
                Clear
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  )
}

export function ActiveFilters({
  filters,
  counts,
  occasionLabels,
  onChange,
}: {
  filters: Filters
  counts: Record<FacetName, FacetValueCount[]>
  occasionLabels: Map<string, string>
  onChange: (filters: Filters) => void
}) {
  const chips: { key: string; label: string; onRemove: () => void }[] = []

  for (const facet of ALL_FACETS) {
    for (const index of filters.values[facet] ?? []) {
      const row = counts[facet]?.find((r) => r.index === index)
      const raw = row?.label ?? `#${index}`
      const label = facet === 'occasions' ? (occasionLabels.get(raw) ?? raw) : raw
      chips.push({
        key: `${facet}-${index}`,
        label: `${LABELS[facet]}: ${label}`,
        onRemove: () => onChange(toggleFacet(filters, facet, index)),
      })
    }
    if (filters.unset[facet]) {
      chips.push({
        key: `${facet}-unset`,
        label: `${LABELS[facet]}: not specified`,
        onRemove: () => onChange({ ...filters, unset: { ...filters.unset, [facet]: false } }),
      })
    }
  }

  if (chips.length === 0) return null

  return (
    <div className="active-filters">
      {chips.map((chip) => (
        <button key={chip.key} className="chip chip-active" onClick={chip.onRemove}>
          {chip.label}
          <span aria-hidden="true">×</span>
          <span className="visually-hidden">remove filter</span>
        </button>
      ))}
      <button
        className="btn btn-ghost btn-sm"
        onClick={() => onChange({ values: {}, modes: {}, unset: {} })}
      >
        Clear all
      </button>
    </div>
  )
}

export { LABELS as FACET_LABELS }
