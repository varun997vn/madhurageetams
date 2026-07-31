import { useEffect, useRef, type ReactNode } from 'react'

/**
 * Bottom sheet used for the filter panel on phones.
 *
 * Four behaviours that a plain absolutely-positioned div does not give you, each of which
 * is a visible bug on a real phone if missed:
 *
 * 1. **Body scroll lock.** Without pinning the body, iOS scrolls the page behind the
 *    sheet as soon as the sheet's own content reaches its end. Pinning loses the scroll
 *    position unless it is saved and restored, which is the classic half-fix.
 * 2. **Back gesture closes the sheet.** Routing here is hash-based, so on Android the
 *    system back gesture would otherwise navigate away from the page entirely rather than
 *    dismissing the sheet.
 * 3. **Focus trap.** Tab must not escape into the inert page behind the scrim, and focus
 *    returns to whatever opened the sheet on close.
 * 4. **Escape to close**, for the keyboard and for tablets with one attached.
 */
export function Sheet({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreFocusTo = useRef<Element | null>(null)

  /**
   * `onClose` is re-created on every parent render, and the history effect below calls
   * `history.back()` in its cleanup. Depending on the callback directly therefore tore
   * the sheet down and reopened it on every keystroke or facet tick — which read as the
   * sheet closing by itself the moment you selected a filter. Holding it in a ref keeps
   * the effect keyed on `open` alone.
   */
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  // --- body scroll lock, with scroll-position restore ------------------------------
  useEffect(() => {
    if (!open) return
    const scrollY = window.scrollY
    const body = document.body
    body.dataset.scrollLocked = 'true'
    body.style.top = `-${scrollY}px`
    return () => {
      delete body.dataset.scrollLocked
      body.style.top = ''
      window.scrollTo(0, scrollY)
    }
  }, [open])

  // --- back gesture / back button dismisses the sheet -------------------------------
  useEffect(() => {
    if (!open) return

    // The marker entry keeps the same URL, so a genuine back lands on the hash the sheet
    // was opened at.
    let hashAtOpen = location.hash
    history.pushState({ sheet: true }, '')

    const onPop = () => {
      // Chrome fires popstate for the app's *own* same-document navigation too, not just
      // for a back gesture — and ticking a facet rewrites the hash query string. Both
      // arrive with state `null`, so state cannot tell them apart. The URL can: a back
      // out of the marker entry leaves the hash where it was, while an app navigation
      // changes it (and by popstate time location.hash already holds the new value).
      if (location.hash === hashAtOpen) {
        closeRef.current()
        return
      }
      hashAtOpen = location.hash
      history.pushState({ sheet: true }, '')
    }

    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      // If the sheet was closed by anything other than back, retire the entry we pushed
      // so the next back press does not become a no-op.
      if (history.state?.sheet) history.back()
    }
  }, [open])

  // --- focus management --------------------------------------------------------------
  useEffect(() => {
    if (!open) return
    restoreFocusTo.current = document.activeElement
    const panel = panelRef.current
    panel?.querySelector<HTMLElement>('button, input, [tabindex]')?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !panel) return
      const focusable = panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (focusable.length === 0) return
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      ;(restoreFocusTo.current as HTMLElement | null)?.focus?.()
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <>
      <div className="sheet-scrim" onClick={onClose} aria-hidden="true" />
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={panelRef}
      >
        <div className="sheet-head">
          <div className="sheet-grab" aria-hidden="true" />
          <h2>{title}</h2>
          <button
            className="btn btn-sm btn-ghost"
            style={{ marginLeft: 'auto' }}
            onClick={onClose}
            aria-label="Close filters"
          >
            Close
          </button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer ? <div className="sheet-foot">{footer}</div> : null}
      </div>
    </>
  )
}
