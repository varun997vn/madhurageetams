import { useSetlist } from '../state/setlist'

export function SetlistTray({ onOpen }: { onOpen: () => void }) {
  const { ids, clear } = useSetlist()
  if (ids.length === 0) return null
  return (
    <div className="tray" role="region" aria-label="Setlist">
      <span className="tray-count">
        {ids.length} song{ids.length === 1 ? '' : 's'} in setlist
      </span>
      <div className="tray-actions">
        <button className="btn btn-sm btn-ghost" onClick={clear}>
          Clear
        </button>
        <button className="btn btn-sm btn-primary" onClick={onOpen}>
          Open setlist
        </button>
      </div>
    </div>
  )
}
