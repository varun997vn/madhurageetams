import { SCRIPT_LABELS, type NativeScript, type ScriptChoice } from '../lib/types'

const CHOICES: ScriptChoice[] = ['roman', 'devanagari', 'tamil']

/**
 * Segmented control for choosing the script lyrics are read in.
 *
 * All three options always render, and the one this song does not carry is disabled rather
 * than hidden. A control that appears and disappears as you move between songs reads as a
 * bug, and hiding it would also hide *why* the option is unavailable — which matters here,
 * because the master copy prints each song in exactly one Indic script and the reason is
 * not guessable from the song's language.
 */
export function ScriptPicker({
  value,
  available,
  bilingual,
  onChange,
  onBilingual,
}: {
  value: ScriptChoice
  available: NativeScript | null
  bilingual: boolean
  onChange: (choice: ScriptChoice) => void
  onBilingual?: (bilingual: boolean) => void
}) {
  const effective = value === 'roman' || value === available ? value : 'roman'

  return (
    <div className="script-toggle">
      <div className="scope-toggle" role="group" aria-label="Lyrics script">
        {CHOICES.map((choice) => {
          const unavailable = choice !== 'roman' && choice !== available
          return (
            <button
              key={choice}
              aria-pressed={effective === choice}
              disabled={unavailable}
              title={
                unavailable
                  ? `The master copy does not print this song in ${SCRIPT_LABELS[choice]}`
                  : `Read the lyrics in ${SCRIPT_LABELS[choice]}`
              }
              onClick={() => onChange(choice)}
            >
              {SCRIPT_LABELS[choice]}
            </button>
          )
        })}
      </div>

      {onBilingual ? (
        <button
          className={`btn btn-sm ${bilingual ? 'btn-primary' : ''}`}
          aria-pressed={bilingual}
          disabled={effective === 'roman'}
          title={
            effective === 'roman'
              ? 'Already reading the Roman transliteration'
              : 'Show the Roman transliteration beside each line'
          }
          onClick={() => onBilingual(!bilingual)}
        >
          + Roman
        </button>
      ) : null}
    </div>
  )
}
