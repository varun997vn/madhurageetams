import { useEffect, useMemo, useRef, useState } from 'react'
import { ActiveFilters, FacetPanel } from '../components/FacetPanel'
import { ResultsList } from '../components/ResultsList'
import { Sheet } from '../components/Sheet'
import { useCompactViewport } from '../lib/useCompactViewport'
import { getWorker } from '../lib/workerClient'
import { useSession } from '../state/session'
import { useSetlist } from '../state/setlist'
import type { AppRoute } from '../lib/hashState'
import { countActiveFilters } from '../lib/hashState'
import type { FacetName, QueryResponse, SortKey } from '../lib/types'

const PAGE_SIZE = 200

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'relevance', label: 'Relevance' },
  { key: 'occasion', label: 'Session order' },
  { key: 'title', label: 'Title' },
  { key: 'composer', label: 'Composer' },
  { key: 'ragam', label: 'Ragam' },
  { key: 'id', label: 'Song ID' },
]

interface Props {
  route: AppRoute
  onRoute: (route: AppRoute, replace?: boolean) => void
  onOpen: (id: number) => void
  onOpenSetlist: () => void
}

export function Browse({ route, onRoute, onOpen, onOpenSetlist }: Props) {
  const { meta, indexReady } = useSession()
  const setlist = useSetlist()
  const [response, setResponse] = useState<QueryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [facetsOpen, setFacetsOpen] = useState(false)
  const compact = useCompactViewport()
  const requestId = useRef(0)

  const occasionLabels = useMemo(
    () => new Map((meta?.occasions ?? []).map((o) => [o.id, o.label] as const)),
    [meta],
  )

  const filterKey = JSON.stringify(route.filters)

  useEffect(() => {
    const mine = ++requestId.current
    setLoading(true)
    const timer = setTimeout(() => {
      void getWorker()
        .call('query', {
          text: route.q,
          scope: route.scope,
          filters: route.filters,
          sort: route.sort,
          offset: 0,
          limit: PAGE_SIZE,
          ...(route.occasion ? { occasion: route.occasion } : {}),
        })
        .then((result) => {
          // Ignore a response that a newer keystroke has already superseded.
          if (mine !== requestId.current) return
          setResponse(result)
          setLoading(false)
        })
        .catch(() => {
          if (mine === requestId.current) setLoading(false)
        })
      // Coalesce typing without making the UI feel laggy.
    }, route.q ? 130 : 0)
    return () => clearTimeout(timer)
  }, [route.q, route.scope, filterKey, route.sort, route.occasion, indexReady])

  const activeCount = countActiveFilters(route.filters)
  const occasionMeta = route.occasion
    ? meta?.occasions.find((o) => o.id === route.occasion)
    : undefined

  return (
    <div className="wrap">
      {occasionMeta ? (
        <header className="section-head" style={{ marginTop: 0 }}>
          <h2>
            <span aria-hidden="true">{occasionMeta.icon} </span>
            {occasionMeta.label}
          </h2>
          <p>{occasionMeta.blurb}</p>
        </header>
      ) : null}

      <div className="browse">
        {/* Below --bp-md the facet panel moves into a sheet so it stops pushing the
            results off the bottom of the screen; above it, it stays a live sidebar. */}
        {compact ? (
          <>
            <button
              className="btn btn-block"
              style={{ marginBottom: 12 }}
              onClick={() => setFacetsOpen(true)}
            >
              Filters{activeCount ? ` · ${activeCount}` : ''}
            </button>
            <Sheet
              open={facetsOpen}
              title="Filters"
              onClose={() => setFacetsOpen(false)}
              footer={
                <>
                  <button
                    className="btn"
                    disabled={activeCount === 0}
                    onClick={() =>
                      onRoute({ ...route, filters: { values: {}, modes: {}, unset: {} } })
                    }
                  >
                    Clear all
                  </button>
                  <button className="btn btn-primary" onClick={() => setFacetsOpen(false)}>
                    Show {(response?.total ?? 0).toLocaleString()} song
                    {response?.total === 1 ? '' : 's'}
                  </button>
                </>
              }
            >
              {response ? (
                <FacetPanel
                  counts={response.counts}
                  unsetCounts={response.unsetCounts}
                  filters={route.filters}
                  occasionLabels={occasionLabels}
                  onChange={(filters) => onRoute({ ...route, view: 'browse', filters })}
                />
              ) : null}
            </Sheet>
          </>
        ) : (
          <div>
            {response ? (
              <FacetPanel
                counts={response.counts}
                unsetCounts={response.unsetCounts}
                filters={route.filters}
                occasionLabels={occasionLabels}
                onChange={(filters) => onRoute({ ...route, view: 'browse', filters })}
              />
            ) : null}
          </div>
        )}

        <div>
          <div className="results-head">
            <span className="results-count tabular">
              {loading && !response
                ? 'Searching…'
                : `${(response?.total ?? 0).toLocaleString()} song${response?.total === 1 ? '' : 's'}`}
            </span>
            {loading && response ? <span className="spinner" aria-hidden="true" /> : null}
            {response?.indexPending ? (
              <span className="chip chip-muted">loading lyrics index…</span>
            ) : null}
            <div className="results-tools">
              <label className="visually-hidden" htmlFor="sort">Sort</label>
              <select
                id="sort"
                className="field sort-select"
                value={route.sort}
                onChange={(e) => onRoute({ ...route, sort: e.target.value as SortKey })}
              >
                {SORTS.map((s) => (
                  <option key={s.key} value={s.key}>{s.label}</option>
                ))}
              </select>
              <button
                className="btn btn-sm"
                disabled={!response?.rows.length}
                onClick={() => setlist.addMany(response!.rows.map((r) => r.id))}
              >
                + Add {response?.rows.length ?? 0}
                <span className="add-all-suffix"> to setlist</span>
              </button>
            </div>
          </div>

          {response ? (
            <ActiveFilters
              filters={route.filters}
              counts={response.counts}
              occasionLabels={occasionLabels}
              onChange={(filters) => onRoute({ ...route, filters })}
            />
          ) : null}

          <ResultsList
            rows={response?.rows ?? []}
            total={response?.total ?? 0}
            loading={loading}
            onOpen={onOpen}
            onFacet={(facet, label) => applyFacet(facet, label, route, onRoute, response)}
          />

          {response ? (
            <p className="dim" style={{ fontSize: 11.5, marginTop: 8 }}>
              {response.tookMs} ms
              {setlist.ids.length > 0 ? (
                <>
                  {' · '}
                  <button className="btn btn-ghost btn-sm" onClick={onOpenSetlist}>
                    {setlist.ids.length} in setlist
                  </button>
                </>
              ) : null}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** Clicking a chip on a result row filters by that value. */
function applyFacet(
  facet: FacetName,
  label: string,
  route: AppRoute,
  onRoute: (route: AppRoute) => void,
  response: QueryResponse | null,
) {
  const index = response?.counts[facet]?.find((r) => r.label === label)?.index
  if (index === undefined) return
  const current = route.filters.values[facet] ?? []
  if (current.includes(index)) return
  onRoute({
    ...route,
    view: 'browse',
    filters: {
      ...route.filters,
      values: { ...route.filters.values, [facet]: [...current, index] },
    },
  })
}
