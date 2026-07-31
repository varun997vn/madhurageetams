import { useSyncExternalStore } from 'react'

/**
 * True below the --bp-md breakpoint, where the layout switches to the phone treatment.
 *
 * Kept in sync with the 860px used in styles.css. A few places need the breakpoint in JS
 * rather than CSS — the facet panel becomes a modal sheet rather than a sidebar, which is
 * a different component tree, not a different set of styles.
 *
 * `useSyncExternalStore` rather than an effect + state: it reads the correct value on the
 * very first render, so the sidebar never flashes before switching to the sheet.
 */
const QUERY = '(max-width: 860px)'

function subscribe(onChange: () => void): () => void {
  if (typeof matchMedia === 'undefined') return () => {}
  const list = matchMedia(QUERY)
  list.addEventListener('change', onChange)
  return () => list.removeEventListener('change', onChange)
}

function getSnapshot(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia(QUERY).matches
}

export function useCompactViewport(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
