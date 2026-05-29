/**
 * Typed filter-builder model + KQL serialization.
 *
 * The Search page's old "tags" text input ("error=true http.status_code=500")
 * parsed key=value pairs informally. The faceted-nav UI replaces it with
 * a structured filter list: each row is (attribute, operator, value),
 * and we serialize the list to a KQL predicate clause that gets composed
 * with the rest of the query.
 *
 * Separated from the React component so the serialization logic can be
 * unit-tested in isolation, and so the parsing/serializing functions can
 * be reused by the URL hydration in SearchPage (PR F).
 */

/** Operators the filter UI supports. */
export type FilterOp =
  | '='
  | '!='
  | '~'   // contains substring
  | '!~'  // does not contain
  | '>'
  | '<'
  | '>='
  | '<=';

export const FILTER_OPS: readonly FilterOp[] = [
  '=',
  '!=',
  '~',
  '!~',
  '>',
  '<',
  '>=',
  '<=',
] as const;

/** Labels shown in the operator dropdown — short, glanceable. */
export const FILTER_OP_LABELS: Record<FilterOp, string> = {
  '=': '=',
  '!=': '≠',
  '~': 'contains',
  '!~': 'not contains',
  '>': '>',
  '<': '<',
  '>=': '≥',
  '<=': '≤',
};

export interface FilterRow {
  /** Stable id so React lists can key on it without losing focus. */
  id: string;
  /** Attribute name (e.g. "http.status_code", "k8s.pod.name"). */
  attr: string;
  op: FilterOp;
  /** Always a string in the UI; we coerce to numeric in KQL when the op
   *  is numeric (>, <, >=, <=). */
  value: string;
}

/** Pick the KQL access path for an attribute name. Mirrors queries.ts. */
function attrExpr(attr: string): string {
  const escaped = attr.replace(/'/g, "\\'");
  if (attr.startsWith('k8s.') || attr.startsWith('service.')) {
    return `tostring(resource.attributes['${escaped}'])`;
  }
  return `tostring(attributes['${escaped}'])`;
}

/** Quote a string value for inlining in KQL. */
function kqlString(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function rowIsValid(r: FilterRow): boolean {
  return r.attr.trim().length > 0 && r.value.trim().length > 0;
}

/**
 * Serialize one filter row to a KQL boolean expression. Numeric ops
 * coerce both sides via `toreal()`; string ops compare as strings.
 * `~` / `!~` use `contains_cs` so the search is case-sensitive (matches
 * how the existing Search "tags" parser behaved).
 */
export function rowToKql(r: FilterRow): string {
  const lhs = attrExpr(r.attr);
  const v = r.value.trim();
  switch (r.op) {
    case '=':
      return `${lhs} == ${kqlString(v)}`;
    case '!=':
      return `${lhs} != ${kqlString(v)}`;
    case '~':
      return `${lhs} contains_cs ${kqlString(v)}`;
    case '!~':
      return `not (${lhs} contains_cs ${kqlString(v)})`;
    case '>':
    case '<':
    case '>=':
    case '<=':
      return `toreal(${lhs}) ${r.op} ${v}`;
  }
}

/**
 * Serialize a full list of rows to a single KQL predicate. Empty /
 * incomplete rows are skipped (so the UI can have an empty row while
 * the user is typing without breaking the query). Returns an empty
 * string when no rows are valid — callers should treat that as "no
 * extra predicate" rather than "false".
 */
export function rowsToKql(rows: readonly FilterRow[]): string {
  const parts = rows.filter(rowIsValid).map(rowToKql);
  if (parts.length === 0) return '';
  return parts.join(' and ');
}

let _idCounter = 0;
export function newFilterRow(partial: Partial<FilterRow> = {}): FilterRow {
  _idCounter += 1;
  return {
    id: `f${_idCounter}-${Date.now().toString(36)}`,
    attr: '',
    op: '=',
    value: '',
    ...partial,
  };
}
