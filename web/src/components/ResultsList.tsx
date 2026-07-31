import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useWindowVirtualizer } from '@tanstack/react-virtual'
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
  const listRef = useRef<HTMLDivElement>(null)
  const setlist = useSetlist()

  /**
   * Distance from the top of the document to the top of the list.
   *
   * Held in state rather than read inline from the ref: on the first render the ref is
   * still null, so an inline read yields 0 and every row renders one header-height too
   * high. It also has to be re-measured when the viewport changes, because the toolbar
   * and active-filter chips above the list wrap to different heights per width.
   */
  const [listOffset, setListOffset] = useState(0)

  useLayoutEffect(() => {
    const measure = () => setListOffset(listRef.current?.offsetTop ?? 0)
    measure()
    const observer = new ResizeObserver(measure)
    if (listRef.current?.parentElement) observer.observe(listRef.current.parentElement)
    return () => observer.disconnect()
  })

  useEffect(() => {
    const onResize = () => setListOffset(listRef.current?.offsetTop ?? 0)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  /**
   * Virtualised against the *window*, not an inner scroll box.
   *
   * This list used to live in a `height: calc(100vh - 250px); overflow-y: auto` container,
   * which nested a scroll area inside a page that also scrolls — on a phone that traps
   * momentum scrolling and strands the outer page, and `100vh` resolves to the largest
   * viewport so the box was taller than the visible area. Scrolling the document itself
   * also restores the browser's own scroll restoration and address-bar collapse.
   *
   * `scrollMargin` is what keeps rows positioned correctly: without it the virtualiser
   * assumes the list starts at the top of the document and every row is offset by the
   * height of the header, filters and toolbar above it.
   */
  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: () => 96,
    overscan: 6,
    scrollMargin: listOffset,
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
    <>
      <div className="results-list" ref={listRef}>
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
                  transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)`,
                }}
                // Rows are measured rather than fixed-height: chips wrap to a second line
                // on a narrow screen, so a single estimate is wrong at most widths.
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
                  <span className="result-id">#{row.id}</span>
                  <button
                    className={`btn btn-sm ${inList ? 'btn-primary' : ''}`}
                    onClick={() => setlist.toggle(row.id)}
                    aria-pressed={inList}
                    aria-label={inList ? `Remove ${row.title} from setlist` : `Add ${row.title} to setlist`}
                  >
                    {inList ? '✓ In set' : '+ Set'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
      {rows.length < total ? (
        <div style={{ padding: '14px 12px', textAlign: 'center', fontSize: 12.5, color: 'var(--ink-3)' }}>
          Showing the first {rows.length.toLocaleString()} of {total.toLocaleString()} — narrow the
          filters to see the rest.
        </div>
      ) : null}
    </>
  )
}
