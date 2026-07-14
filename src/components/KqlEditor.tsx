import { useCallback, useId, useState } from 'react';
import { assertKqlPredicate } from '../api/kqlSafety';
import s from './KqlEditor.module.css';

interface Props {
  value: string;
  onChange: (next: string) => void;
  /** Called when the user explicitly applies (Enter / Apply button). */
  onApply: (current: string) => void;
  /** Optional helper text shown above the textarea. */
  helperText?: string;
  disabled?: boolean;
  /** Number of rows for the textarea. */
  rows?: number;
}

/**
 * KqlEditor — the escape hatch. When the typed FilterBuilder can't
 * express what the user needs (regex on body, KQL functions, joins
 * across data, etc.), they can drop into a raw KQL predicate that
 * gets composed with the rest of the query the same way the typed
 * filters are.
 *
 * Validation is intentionally minimal: an empty editor is fine
 * (means "no extra predicate"); a non-empty one is trusted. The
 * actual KQL parser is server-side, and we surface errors via the
 * existing search-result error banner.
 */
export default function KqlEditor({
  value,
  onChange,
  onApply,
  helperText = 'Optional raw KQL predicate. Composed with `and` against the rest of the search.',
  disabled,
  rows = 3,
}: Props) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleChange = useCallback(
    (next: string) => {
      setDraft(next);
      setValidationError(null);
      onChange(next);
    },
    [onChange],
  );

  const apply = useCallback(() => {
    try {
      onApply(assertKqlPredicate(draft));
      setValidationError(null);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : String(error));
    }
  }, [draft, onApply]);

  const handleKey = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Ctrl/Cmd+Enter = apply. Plain Enter inserts a newline so the
      // user can format multi-line KQL the same way they would in the
      // Cribl Search UI.
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        apply();
      }
    },
    [apply],
  );

  return (
    <div className={s.editor}>
      <label htmlFor={id} className={s.label}>
        Raw KQL (advanced)
      </label>
      {helperText && <p className={s.helper}>{helperText}</p>}
      <textarea
        id={id}
        className={s.textarea}
        value={draft}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKey}
        rows={rows}
        spellCheck={false}
        placeholder={`tostring(attributes['http.url']) matches regex "/api/v[0-9]+/.*"`}
        disabled={disabled}
        aria-label="Raw KQL predicate"
        aria-invalid={validationError ? true : undefined}
      />
      {validationError && <p className={s.helper} role="alert">{validationError}</p>}
      <div className={s.actions}>
        <span className={s.hint}>Ctrl/⌘+Enter to apply</span>
        <button
          type="button"
          className={s.applyBtn}
          onClick={apply}
          disabled={disabled}
        >
          Apply
        </button>
      </div>
    </div>
  );
}
