import { useEffect, useMemo, useState } from 'react'
import { SetlistTray } from './components/SetlistTray'
import * as hash from './lib/hashState'
import { getWorker } from './lib/workerClient'
import { useSession } from './state/session'
import { useSetlist } from './state/setlist'
import { Browse } from './views/Browse'
import { Insights } from './views/Insights'
import { OccasionFinder } from './views/OccasionFinder'
import { PrintSheet } from './views/PrintSheet'
import { SetlistView } from './views/SetlistView'
import { SongDetailView } from './views/SongDetail'
import { UnlockGate, UnsupportedBrowser } from './views/UnlockGate'
import type { FacetName } from './lib/types'

export function App() {
  const session = useSession()
  const setlist = useSetlist()
  const [route, setRoute] = useState<hash.AppRoute>(() => hash.parse(location.hash))

  useEffect(() => {
    void session.init()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onHashChange = () => setRoute(hash.parse(location.hash))
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const go = (next: hash.AppRoute, replace = false) => {
    setRoute(next)
    hash.navigate(next, replace)
  }

  /** Resolve a facet label to its dictionary index, then filter by it. */
  const filterByLabel = async (facet: FacetName, label: string) => {
    const rows = await getWorker().call('facetValues', { facet, prefix: label, limit: 400 })
    const match = rows.find((r) => r.label === label) ?? rows[0]
    if (!match) return
    go({
      ...route,
      view: 'browse',
      songId: undefined,
      filters: {
        ...route.filters,
        values: { ...route.filters.values, [facet]: [match.index] },
      },
    })
  }

  const filterByIndex = (facet: FacetName, index: number) => {
    go({
      ...route,
      view: 'browse',
      songId: undefined,
      filters: {
        ...route.filters,
        values: { ...route.filters.values, [facet]: [index] },
      },
    })
  }

  const openOccasion = async (id: string) => {
    const rows = await getWorker().call('facetValues', { facet: 'occasions', prefix: '', limit: 400 })
    const match = rows.find((r) => r.label === id)
    go({
      ...hash.defaultRoute(),
      view: 'browse',
      occasion: id,
      sort: 'occasion',
      filters: match
        ? { values: { occasions: [match.index] }, modes: {}, unset: {} }
        : hash.EMPTY_FILTERS,
    })
  }

  const stats = session.stats

  if (session.phase === 'unsupported') return <UnsupportedBrowser />
  if (session.phase === 'checking') {
    return (
      <div className="unlock">
        <div className="spinner" aria-label="Loading" />
      </div>
    )
  }
  if (session.phase !== 'ready') return <UnlockGate />

  return (
    <div className="shell">
      <header className="topbar">
        <button className="brand" onClick={() => go({ ...hash.defaultRoute() })}>
          <span aria-hidden="true">🪷</span> Madhurageetam
        </button>

        <nav className="topnav">
          <button
            aria-current={route.view === 'home' ? 'page' : undefined}
            onClick={() => go({ ...hash.defaultRoute() })}
          >
            Occasions
          </button>
          <button
            aria-current={route.view === 'browse' ? 'page' : undefined}
            onClick={() => go({ ...route, view: 'browse', songId: undefined })}
          >
            Browse
          </button>
          <button
            aria-current={route.view === 'insights' ? 'page' : undefined}
            onClick={() => go({ ...route, view: 'insights', songId: undefined })}
          >
            Insights
          </button>
          <button
            aria-current={route.view === 'setlist' ? 'page' : undefined}
            onClick={() => go({ ...route, view: 'setlist', songId: undefined })}
          >
            Setlist{setlist.ids.length ? ` (${setlist.ids.length})` : ''}
          </button>
        </nav>

        <div className="searchbar">
          <label className="visually-hidden" htmlFor="search">Search songs</label>
          <input
            id="search"
            className="field"
            type="search"
            placeholder={`Search ${stats?.songs.toLocaleString() ?? ''} kirtans…`}
            value={route.q}
            onChange={(e) =>
              go({ ...route, view: 'browse', songId: undefined, q: e.target.value }, true)
            }
          />
          <ScopeToggle route={route} go={go} />
        </div>

        <button className="btn btn-sm btn-ghost" onClick={() => void session.lock()} title="Lock and forget the key">
          Lock
        </button>

        {/* On phones the scope toggle leaves the search row and gets its own full-width
            row below it. Inside the field it was eating most of a 375px screen. */}
        <div className="scope-row">
          <ScopeToggle route={route} go={go} />
        </div>
      </header>

      <main className="page">
        {route.view === 'home' ? (
          <OccasionFinder
            onOccasion={(id) => void openOccasion(id)}
            onFacet={(facet, label) => void filterByLabel(facet, label)}
            onBrowse={() => go({ ...route, view: 'browse' })}
          />
        ) : null}

        {route.view === 'browse' ? (
          <Browse
            route={route}
            onRoute={go}
            onOpen={(id) => go({ ...route, view: 'song', songId: id })}
            onOpenSetlist={() => go({ ...route, view: 'setlist', songId: undefined })}
          />
        ) : null}

        {route.view === 'song' && route.songId !== undefined ? (
          <SongDetailView
            songId={route.songId}
            onFacet={(facet, label) => void filterByLabel(facet, label)}
            onOccasion={(id) => void openOccasion(id)}
            onBack={() => go({ ...route, view: 'browse', songId: undefined })}
          />
        ) : null}

        {route.view === 'setlist' ? (
          <SetlistView
            onOpen={(id) => go({ ...route, view: 'song', songId: id })}
            onBrowse={() => go({ ...route, view: 'browse' })}
            onPrint={() => go({ ...route, view: 'print', songId: undefined })}
          />
        ) : null}

        {route.view === 'print' ? (
          <PrintSheet onBack={() => go({ ...route, view: 'setlist', songId: undefined })} />
        ) : null}

        {route.view === 'insights' ? (
          <Insights filters={route.filters} onFacetIndex={filterByIndex} />
        ) : null}
      </main>

      <SetlistTray onOpen={() => go({ ...route, view: 'setlist', songId: undefined })} />

      <Footer built={stats?.built ?? ''} lyricsReady={session.lyricsReady} />

      <TabBar route={route} go={go} setlistCount={setlist.ids.length} />
    </div>
  )
}

function ScopeToggle({
  route,
  go,
}: {
  route: hash.AppRoute
  go: (next: hash.AppRoute, replace?: boolean) => void
}) {
  return (
    <div className="scope-toggle" role="group" aria-label="Search scope">
      <button
        aria-pressed={route.scope === 'meta'}
        onClick={() => go({ ...route, scope: 'meta' })}
        title="Search titles, composers, ragams and categories"
      >
        Titles
      </button>
      <button
        aria-pressed={route.scope === 'all'}
        onClick={() => go({ ...route, view: 'browse', scope: 'all' })}
        title="Also search inside the lyrics"
      >
        + Lyrics
      </button>
    </div>
  )
}

const TABS: { view: hash.View; label: string; icon: string }[] = [
  { view: 'home', label: 'Occasions', icon: '🪷' },
  { view: 'browse', label: 'Browse', icon: '🔎' },
  { view: 'insights', label: 'Insights', icon: '📊' },
  { view: 'setlist', label: 'Setlist', icon: '🎵' },
]

/**
 * Phone navigation.
 *
 * Hidden entirely above --bp-md; on a phone it replaces the four top-bar nav links, which
 * is what frees the width the search field needs. Rendered after the tray in the DOM but
 * sits below it in the stacking scale, and the tray is offset upward by the bar's height,
 * so an active setlist never covers navigation.
 */
function TabBar({
  route,
  go,
  setlistCount,
}: {
  route: hash.AppRoute
  go: (next: hash.AppRoute, replace?: boolean) => void
  setlistCount: number
}) {
  return (
    <nav className="tabbar" aria-label="Sections">
      {TABS.map((tab) => {
        // The song view is reached from Browse, so keep Browse lit while reading a song.
        const current = route.view === 'song' ? 'browse' : route.view
        const active = current === tab.view
        return (
          <button
            key={tab.view}
            aria-current={active ? 'page' : undefined}
            onClick={() =>
              tab.view === 'home'
                ? go({ ...hash.defaultRoute() })
                : go({ ...route, view: tab.view, songId: undefined })
            }
          >
            <span className="tab-icon" aria-hidden="true">{tab.icon}</span>
            {tab.label}
            {tab.view === 'setlist' && setlistCount > 0 ? (
              <span className="tab-badge">{setlistCount > 99 ? '99+' : setlistCount}</span>
            ) : null}
          </button>
        )
      })}
    </nav>
  )
}

function Footer({ built, lyricsReady }: { built: string; lyricsReady: number }) {
  const label = useMemo(() => {
    if (lyricsReady >= 1) return 'lyrics cached'
    if (lyricsReady > 0) return `caching lyrics ${Math.round(lyricsReady * 100)}%`
    return ''
  }, [lyricsReady])

  return (
    <footer className="wrap" style={{ paddingTop: 0, paddingBottom: 70, fontSize: 11.5, color: 'var(--ink-3)' }}>
      Indexed from the Madhurageetam master copy (Global Organization For Divinity,
      18-Sep-2025){built ? ` · built ${built}` : ''}
      {label ? ` · ${label}` : ''}. Shared with permission of the copyright holder; not for
      redistribution.
    </footer>
  )
}
