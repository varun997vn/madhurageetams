import { SCRIPT_LABELS, type NativeScript, type ScriptChoice } from '../lib/types'

/**
 * Choosing the script lyrics are read in.
 *
 * A native `<select>` rather than a row of buttons, and it lists **only what is actually
 * available**. The master copy prints each song beside exactly one Indic script, so two of
 * three buttons were always dead — and a disabled control reads as "broken" far more often
 * than it reads as "not applicable to this song".
 *
 * The select earns its keep on a phone too: iOS and Android render their own picker, which
 * is a better target than three cramped segments and costs nothing to ship.
 */
export function ScriptPicker({
  value,
  available,
  bilingual,
  onChange,
  onBilingual,
  label = 'Read in',
}: {
  value: ScriptChoice
  /** The Indic scripts on offer here — one song's, or the union across a setlist. */
  available: NativeScript[]
  bilingual: boolean
  onChange: (choice: ScriptChoice) => void
  onBilingual?: (bilingual: boolean) => void
  label?: string
}) {
  // Nothing to choose between: every song here is Roman-only, so a one-option select would
  // be pure furniture. SongDetail explains why in its own note.
  if (available.length === 0) return null

  const effective = value === 'roman' || available.includes(value as NativeScript) ? value : 'roman'

  return (
    <div className="script-toggle">
      <label className="script-select">
        <span>{label}</span>
        <select
          value={effective}
          onChange={(event) => onChange(event.target.value as ScriptChoice)}
        >
          <option value="roman">{SCRIPT_LABELS.roman}</option>
          {available.map((script) => (
            <option key={script} value={script}>
              {SCRIPT_LABELS[script]}
            </option>
          ))}
        </select>
      </label>

      {onBilingual && effective !== 'roman' ? (
        <button
          className={`btn btn-sm ${bilingual ? 'btn-primary' : ''}`}
          aria-pressed={bilingual}
          title="Show the Roman transliteration beside each line"
          onClick={() => onBilingual(!bilingual)}
        >
          + Roman
        </button>
      ) : null}
    </div>
  )
}
