import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { FacetName, ResultRow } from '../lib/types'
import { useSetlist } from '../state/setlist'

interface Props {
  rows: ResultRow[]
  total: number
  loading: boolean
  onOpen: (id: number) => void
  onFacet: (facet: FacetName, label: string) => void
}

export function ResultsList({ rows, total, loading, onOpen, onFacet }: Props) {
  const parentRef = useRef<HTMLDivElement>(null)
  const setlist = useSetlist()

  // 7,898 rows will not render as DOM nodes; only what fits the viewport is mounted.
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 78,
    overscan: 8,
  })

  if (!loading && rows.length === 0) {
    return (
      <div className="empty">
        <p style={{ fontSize: 15, marginBottom: 4 }}>No songs match these filters.</p>
        <p style={{ fontSize: 13 }}>Try removing a filter, or search titles and lyrics instead.</p>
      </div>
    )
  }

  return (
    <div className="virtual-viewport" ref={parentRef}>
      <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]
          if (!row) return null
          const inList = setlist.ids.includes(row.id)
          return (
            <div
              key={row.id}
              className="result-row"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${item.start}px)`,
              }}
              ref={virtualizer.measureElement}
              data-index={item.index}
            >
              <div className="result-main">
                <button className="result-title" onClick={() => onOpen(row.id)}>
                  {row.title}
                </button>
                <div className="result-meta">
                  {row.boosted ? <span className="chip badge-core">core</span> : null}
                  {row.deity ? (
                    <button className="chip" onClick={() => onFacet('deity', row.deity)}>
                      {row.deity}
                    </button>
                  ) : null}
                  {row.ragam.map((r) => (
                    <button key={r} className="chip" onClick={() => onFacet('ragam', r)}>
                      {r}
                    </button>
                  ))}
                  {row.thalam.map((t) => (
                    <button key={t} className="chip" onClick={() => onFacet('thalam', t)}>
                      {t}
                    </button>
                  ))}
                  {row.composer ? (
                    <button className="chip chip-muted" onClick={() => onFacet('composer', row.composer)}>
                      {row.composer}
                    </button>
                  ) : null}
                  {row.language ? (
                    <button className="chip chip-muted" onClick={() => onFacet('language', row.language)}>
                      {row.language}
                    </button>
                  ) : null}
                </div>
                {row.snippet ? <div className="result-snippet">{row.snippet}</div> : null}
              </div>

              <div className="result-actions">
                <button
                  className={`btn btn-sm ${inList ? 'btn-primary' : ''}`}
                  onClick={() => setlist.toggle(row.id)}
                  aria-pressed={inList}
                  title={inList ? 'Remove from setlist' : 'Add to setlist'}
                >
                  {inList ? '✓ In set' : '+ Set'}
                </button>
                <span className="result-id">#{row.id}</span>
              </div>
            </div>
          )
        })}
      </div>
      {rows.length < total ? (
        <div style={{ padding: '12px', textAlign: 'center', fontSize: 12, color: 'var(--ink-3)' }}>
          Showing the first {rows.length.toLocaleString()} of {total.toLocaleString()} — narrow the
          filters to see the rest.
        </div>
      ) : null}
    </div>
  )
}
