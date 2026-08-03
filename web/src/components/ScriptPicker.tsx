import { SCRIPT_CHOICES, SCRIPT_LABELS, type ScriptChoice } from '../lib/types'

/**
 * Choosing the script lyrics are read in.
 *
 * Every song now carries all six scripts (Roman plus five Indic — the master copy's own
 * column, and machine transliterations for the rest), so the select always lists all
 * six. A native `<select>` rather than a row of buttons: iOS and Android render their
 * own picker, which is a better target than six cramped segments and costs nothing to
 * ship.
 */
export function ScriptPicker({
  value,
  bilingual,
  onChange,
  onBilingual,
  label = 'Language',
}: {
  value: ScriptChoice
  bilingual: boolean
  onChange: (choice: ScriptChoice) => void
  onBilingual?: (bilingual: boolean) => void
  label?: string
}) {
  return (
    <div className="script-toggle">
      <label className="script-select">
        <span>{label}</span>
        <select
          value={value}
          onChange={(event) => onChange(event.target.value as ScriptChoice)}
        >
          {SCRIPT_CHOICES.map((script) => (
            <option key={script} value={script}>
              {SCRIPT_LABELS[script]}
            </option>
          ))}
        </select>
      </label>

      {onBilingual && value !== 'roman' ? (
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
