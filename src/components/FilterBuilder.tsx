import { useCallback } from 'react';
import {
  type FilterRow,
  type FilterOp,
  FILTER_OPS,
  FILTER_OP_LABELS,
  newFilterRow,
} from '../spotlight/filterModel';
import s from './FilterBuilder.module.css';

interface Props {
  rows: FilterRow[];
  onChange: (next: FilterRow[]) => void;
  /** Optional list of suggested attribute names for the attr-name input
   *  (used as <datalist> options — browser-native autocomplete). */
  attrSuggestions?: readonly string[];
  /** Optional callback that returns value suggestions for the chosen
   *  attribute. The component shows the result via a per-row datalist;
   *  if omitted, no value autocomplete is offered. */
  valueSuggestionsFor?: (attr: string) => readonly string[] | undefined;
  disabled?: boolean;
}

export default function FilterBuilder({
  rows,
  onChange,
  attrSuggestions,
  valueSuggestionsFor,
  disabled,
}: Props) {
  const update = useCallback(
    (id: string, patch: Partial<FilterRow>) => {
      onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    },
    [rows, onChange],
  );

  const remove = useCallback(
    (id: string) => {
      onChange(rows.filter((r) => r.id !== id));
    },
    [rows, onChange],
  );

  const add = useCallback(() => {
    onChange([...rows, newFilterRow()]);
  }, [rows, onChange]);

  return (
    <div className={s.builder}>
      <div className={s.rows}>
        {rows.map((row) => {
          const valueListId = `vl-${row.id}`;
          const valueOptions = valueSuggestionsFor?.(row.attr);
          return (
            <div key={row.id} className={s.row}>
              <input
                className={s.attrInput}
                type="text"
                placeholder="attribute"
                list="apm-attr-suggestions"
                value={row.attr}
                onChange={(e) => update(row.id, { attr: e.target.value })}
                disabled={disabled}
                aria-label="filter attribute"
              />
              <select
                className={s.opSelect}
                value={row.op}
                onChange={(e) =>
                  update(row.id, { op: e.target.value as FilterOp })
                }
                disabled={disabled}
                aria-label="filter operator"
              >
                {FILTER_OPS.map((op) => (
                  <option key={op} value={op}>
                    {FILTER_OP_LABELS[op]}
                  </option>
                ))}
              </select>
              <input
                className={s.valueInput}
                type="text"
                placeholder="value"
                list={valueOptions ? valueListId : undefined}
                value={row.value}
                onChange={(e) => update(row.id, { value: e.target.value })}
                disabled={disabled}
                aria-label="filter value"
              />
              {valueOptions && (
                <datalist id={valueListId}>
                  {valueOptions.map((v) => (
                    <option key={v} value={v} />
                  ))}
                </datalist>
              )}
              <button
                type="button"
                className={s.removeBtn}
                onClick={() => remove(row.id)}
                disabled={disabled}
                aria-label="remove filter"
                title="Remove this filter"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      {attrSuggestions && (
        <datalist id="apm-attr-suggestions">
          {attrSuggestions.map((a) => (
            <option key={a} value={a} />
          ))}
        </datalist>
      )}

      <button
        type="button"
        className={s.addBtn}
        onClick={add}
        disabled={disabled}
      >
        + Add filter
      </button>
    </div>
  );
}
