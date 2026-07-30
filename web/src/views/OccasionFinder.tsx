import { useEffect, useState } from 'react'
import { getWorker } from '../lib/workerClient'
import { useSession } from '../state/session'
import type { FacetName, OccasionMeta } from '../lib/types'

const GROUP_META: Record<string, { title: string; blurb: string }> = {
  festival: {
    title: 'Festivals',
    blurb: 'Songs traditionally sung on each occasion, with the most apt ones first.',
  },
  sampradaya: {
    title: 'Bhajan sampradaya',
    blurb: 'The sections of a session, in the order they are sung.',
  },
  life: {
    title: 'Themes & occasions',
    blurb: 'Weddings, pilgrimage, cradle songs and the complete works.',
  },
}

interface Props {
  onOccasion: (id: string) => void
  onFacet: (facet: FacetName, label: string) => void
  onBrowse: () => void
}

export function OccasionFinder({ onOccasion, onFacet, onBrowse }: Props) {
  const { stats, meta } = useSession()
  const [counts, setCounts] = useState<Map<string, number>>(new Map())
  const [topDeities, setTopDeities] = useState<{ label: string; value: number }[]>([])
  const [topRagams, setTopRagams] = useState<{ label: string; value: number }[]>([])

  // Live counts, so a card never promises songs the rules no longer produce.
  useEffect(() => {
    let cancelled = false
    const worker = getWorker()
    const empty = { values: {}, modes: {}, unset: {} }
    void (async () => {
      const [occasions, deities, ragams] = await Promise.all([
        worker.call('chartData', { spec: 'sunburst', filters: empty }),
        worker.call('chartData', { spec: 'deity', filters: empty }),
        worker.call('chartData', { spec: 'ragam', filters: empty }),
      ])
      if (cancelled) return
      void occasions
      setTopDeities(deities.slices.slice(0, 8).map((s) => ({ label: s.label, value: s.value })))
      setTopRagams(ragams.slices.slice(0, 10).map((s) => ({ label: s.label, value: s.value })))
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const response = await getWorker().call('query', {
        text: '',
        scope: 'meta',
        filters: { values: {}, modes: {}, unset: {} },
        sort: 'id',
        offset: 0,
        limit: 0,
      })
      if (cancelled) return
      setCounts(new Map(response.counts.occasions.map((row) => [row.label, row.count])))
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const groups = new Map<string, OccasionMeta[]>()
  for (const occasion of meta?.occasions ?? []) {
    const list = groups.get(occasion.group) ?? []
    list.push(occasion)
    groups.set(occasion.group, list)
  }

  return (
    <div className="wrap">
      <header className="hero">
        <h1>Which song for this occasion?</h1>
        <p>
          The whole Madhurageetam master copy, indexed by occasion, deity, ragam, thalam,
          composer and language — and searchable inside the lyrics.
        </p>
        {stats ? (
          <div className="hero-stats">
            <span><b>{stats.songs.toLocaleString()}</b> kirtans</span>
            <span><b>{stats.ragams}</b> ragams</span>
            <span><b>{stats.thalams}</b> thalams</span>
            <span><b>{stats.composers}</b> composers</span>
            <span><b>{stats.deities}</b> deities</span>
            <span><b>{stats.languages}</b> languages</span>
          </div>
        ) : null}
      </header>

      {['festival', 'sampradaya', 'life'].map((group) => {
        const occasions = groups.get(group) ?? []
        if (occasions.length === 0) return null
        return (
          <section key={group}>
            <div className="section-head">
              <h2>{GROUP_META[group]?.title ?? group}</h2>
              <p>{GROUP_META[group]?.blurb}</p>
            </div>
            <div className="occasion-grid">
              {occasions.map((occasion) => {
                const count = counts.get(occasion.id) ?? 0
                return (
                  <button
                    key={occasion.id}
                    className="occasion-card"
                    onClick={() => onOccasion(occasion.id)}
                  >
                    <span className="icon" aria-hidden="true">{occasion.icon}</span>
                    <span className="label">{occasion.label}</span>
                    <span className="blurb">{occasion.blurb}</span>
                    <span className="foot">
                      <span>{occasion.month_hint}</span>
                      <span className="count">
                        {count ? `${count.toLocaleString()} songs` : '—'}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </section>
        )
      })}

      <section>
        <div className="section-head">
          <h2>Browse by deity</h2>
        </div>
        <div className="quick-row">
          {topDeities.map((d) => (
            <button key={d.label} className="chip" onClick={() => onFacet('deity', d.label)}>
              {d.label} <span className="dim">{d.value.toLocaleString()}</span>
            </button>
          ))}
        </div>
      </section>

      <section>
        <div className="section-head">
          <h2>Browse by ragam</h2>
        </div>
        <div className="quick-row">
          {topRagams.map((r) => (
            <button key={r.label} className="chip" onClick={() => onFacet('ragam', r.label)}>
              {r.label} <span className="dim">{r.value}</span>
            </button>
          ))}
          <button className="btn btn-sm btn-ghost" onClick={onBrowse}>
            All {stats?.ragams ?? ''} ragams →
          </button>
        </div>
      </section>
    </div>
  )
}
