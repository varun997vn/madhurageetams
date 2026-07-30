import { useEffect, useState } from 'react'
import { FACET_LABELS } from '../components/FacetPanel'
import { getWorker } from '../lib/workerClient'
import type { ChartData } from '../worker/rpc'
import type { FacetName, Filters } from '../lib/types'

/**
 * Each card shows one measure (song count) ranked across one dimension, so within a
 * chart every bar carries the same hue — the bar length is the encoding, and giving
 * each category its own colour would imply a distinction that is not in the data.
 * Hues differ *between* cards so the four measures read as separate.
 * Values are labelled on every row, which is also the required relief for the
 * mid-contrast fills.
 */
const SPECS: { spec: FacetName; title: string; hint: string; hue: [string, string] }[] = [
  {
    spec: 'deity',
    title: 'Deity',
    hint: 'Who the song is addressed to',
    hue: ['#2a78d6', '#3987e5'],
  },
  {
    spec: 'ragam',
    title: 'Ragam',
    hint: 'Top 20 of 294 ragams in the corpus',
    hue: ['#eb6834', '#d95926'],
  },
  {
    spec: 'composer',
    title: 'Composer',
    hint: 'Attributed composers',
    hue: ['#1baf7a', '#199e70'],
  },
  {
    spec: 'language',
    title: 'Language',
    hint: 'Language of the lyrics',
    hue: ['#eda100', '#c98500'],
  },
]

interface Props {
  filters: Filters
  onFacetIndex: (facet: FacetName, index: number) => void
}

export function Insights({ filters, onFacetIndex }: Props) {
  const [charts, setCharts] = useState<Record<string, ChartData>>({})
  const [dark, setDark] = useState(
    () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches,
  )
  const filterKey = JSON.stringify(filters)

  useEffect(() => {
    const query = matchMedia('(prefers-color-scheme: dark)')
    const listener = (e: MediaQueryListEvent) => setDark(e.matches)
    query.addEventListener('change', listener)
    return () => query.removeEventListener('change', listener)
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const worker = getWorker()
      const results = await Promise.all(
        SPECS.map((s) => worker.call('chartData', { spec: s.spec as never, filters })),
      )
      if (cancelled) return
      const next: Record<string, ChartData> = {}
      SPECS.forEach((s, i) => {
        next[s.spec] = results[i]!
      })
      setCharts(next)
    })()
    return () => {
      cancelled = true
    }
  }, [filterKey])

  const total = charts.deity?.total ?? 0

  return (
    <div className="wrap">
      <div className="section-head" style={{ marginTop: 0 }}>
        <h2>Corpus at a glance</h2>
        <p>
          {total.toLocaleString()} songs in the current selection — click any bar to filter by it.
        </p>
      </div>

      <div className="charts">
        {SPECS.map((spec) => {
          const data = charts[spec.spec]
          const max = data?.slices[0]?.value ?? 1
          const fill = dark ? spec.hue[1] : spec.hue[0]
          return (
            <section className="chart-card" key={spec.spec}>
              <h3>{spec.title}</h3>
              <p className="hint">{spec.hint}</p>
              {!data ? (
                <div className="dim" style={{ fontSize: 12 }}>Loading…</div>
              ) : data.slices.length === 0 ? (
                <div className="dim" style={{ fontSize: 12 }}>No data in this selection.</div>
              ) : (
                <div role="list">
                  {data.slices.map((slice) => (
                    <button
                      key={slice.label}
                      className="bar-row"
                      role="listitem"
                      onClick={() =>
                        slice.index !== undefined &&
                        onFacetIndex(spec.spec, slice.index)
                      }
                      title={`Filter by ${slice.label}`}
                    >
                      <span className="bar-label" title={slice.label}>{slice.label}</span>
                      <span className="bar-track">
                        <span
                          className="bar-fill"
                          style={{
                            width: `${Math.max(2, (slice.value / max) * 100)}%`,
                            background: fill,
                          }}
                        />
                      </span>
                      <span className="bar-value">{slice.value.toLocaleString()}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          )
        })}
      </div>

      <Sunburst filters={filters} onFacetIndex={onFacetIndex} dark={dark} />
    </div>
  )
}

/**
 * Deity → category, as a two-level breakdown.
 *
 * Rendered as nested rows rather than literal arcs: with 94 deities and 543 categories
 * the arc labels would be unreadable at any size that fits a card, and the point is to
 * see which categories sit under which deity, which a grouped list shows better.
 */
function Sunburst({
  filters,
  onFacetIndex,
  dark,
}: {
  filters: Filters
  onFacetIndex: (facet: FacetName, index: number) => void
  dark: boolean
}) {
  const [data, setData] = useState<ChartData | null>(null)
  const filterKey = JSON.stringify(filters)

  useEffect(() => {
    let cancelled = false
    void getWorker()
      .call('chartData', { spec: 'sunburst', filters })
      .then((result) => !cancelled && setData(result))
    return () => {
      cancelled = true
    }
  }, [filterKey])

  if (!data) return null
  const fill = dark ? '#9085e9' : '#4a3aa7'
  const max = data.slices[0]?.value ?? 1

  return (
    <section className="chart-card" style={{ marginTop: 16 }}>
      <h3>Deity → category</h3>
      <p className="hint">
        What kind of song exists for each deity. Click a row to filter.
      </p>
      <div style={{ display: 'grid', gap: 14 }}>
        {data.slices.map((parent) => (
          <div key={parent.label}>
            <button
              className="bar-row"
              onClick={() => parent.index !== undefined && onFacetIndex('deity', parent.index)}
            >
              <span className="bar-label" style={{ fontWeight: 600 }}>{parent.label}</span>
              <span className="bar-track">
                <span
                  className="bar-fill"
                  style={{ width: `${(parent.value / max) * 100}%`, background: fill }}
                />
              </span>
              <span className="bar-value">{parent.value.toLocaleString()}</span>
            </button>
            <div style={{ paddingLeft: 16, marginTop: 2 }}>
              {(parent.children ?? []).map((child) => (
                <button
                  key={child.label}
                  className="bar-row"
                  onClick={() => child.index !== undefined && onFacetIndex('catalog', child.index)}
                >
                  <span className="bar-label dim" style={{ fontSize: 11.5 }}>{child.label}</span>
                  <span className="bar-track" style={{ height: 9 }}>
                    <span
                      className="bar-fill"
                      style={{
                        width: `${(child.value / parent.value) * 100}%`,
                        background: fill,
                        opacity: 0.55,
                      }}
                    />
                  </span>
                  <span className="bar-value">{child.value.toLocaleString()}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="dim" style={{ fontSize: 11, marginTop: 12, marginBottom: 0 }}>
        Showing the top {data.slices.length} {FACET_LABELS.deity.toLowerCase()} values and up to
        six categories each.
      </p>
    </section>
  )
}
