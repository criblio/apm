/**
 * Pre-reconcile tripwires for the provisioning plan (ROADMAP P0.1).
 *
 * The 2026-06-09/10 outage chain shipped through a provisioner that
 * reported success at every step: `dataset=""` baked into 17 saved
 * searches, `mode=overwrite` exports wiping lookups, and a `(?i)`
 * regex upstream of `export to lookup` writing an unjoinable CSV.
 * Each check below corresponds to a failure mode that was observed
 * silently corrupting production.
 *
 * Pure string validation — no I/O, no framework imports — so it can
 * be unit-tested and later upstreamed to @cribl/app-utils.
 */

export interface GuardTarget {
  /** Identifier used in error messages (search id or `seed:<lookup>`). */
  id: string;
  query: string;
}

const EXPORT_TO_LOOKUP_RE = /\bexport\b[^|]*\bto\s+lookup\b/;

/** Drop `//` comment lines so prose mentioning `(?i)` or `mv-expand`
 * (e.g. the traceOriginators comment block) doesn't trip the checks
 * that target actual pipeline stages. */
function stripCommentLines(query: string): string {
  return query
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

/**
 * Validate one query. Returns a list of human-readable violations
 * (empty = pass).
 */
export function validateQuery(id: string, rawQuery: string): string[] {
  const errors: string[] = [];
  const query = stripCommentLines(rawQuery);

  // 1. Dataset clause must exist and be non-empty. An empty dataset
  //    (`dataset=""`) reads zero rows forever while every layer above
  //    reports success — a total outage of the panel/lookup it feeds.
  //    Pure `print`-based seed queries never read a dataset — they
  //    emit a hardcoded sentinel row — so the "must have dataset"
  //    rule doesn't apply. The empty-dataset trap doesn't exist for
  //    them because there's no dataset lookup to be empty.
  if (/dataset\s*=\s*""/.test(query)) {
    errors.push(`${id}: empty dataset clause (dataset="")`);
  }
  const isPrintOnly = /^\s*print\s/.test(query);
  if (!isPrintOnly && !/dataset\s*=\s*"[^"]+"/.test(query)) {
    errors.push(`${id}: no dataset="…" clause found`);
  }

  const exportMatch = EXPORT_TO_LOOKUP_RE.exec(query);
  if (exportMatch) {
    // 2. `(?i)` upstream of `export to lookup` silently corrupts the
    //    write: stats report success but the CSV is unjoinable.
    const ciIdx = query.indexOf('(?i)');
    if (ciIdx !== -1 && ciIdx < exportMatch.index) {
      errors.push(
        `${id}: (?i) inline regex flag upstream of export-to-lookup (writes an unjoinable CSV; use character-class alternation)`,
      );
    }

    // Same family: mv-expand upstream of export-to-lookup fails the
    // func:store write stage (Cribl planner bug — see
    // attrCatalogComputeQuery in provisionedSearches.ts).
    const mvIdx = query.search(/\bmv-expand\b/);
    if (mvIdx !== -1 && mvIdx < exportMatch.index) {
      errors.push(
        `${id}: mv-expand upstream of export-to-lookup (Cribl planner bug fails the lookup write; split into compute + export searches)`,
      );
    }
  }

  // 3. Every `to lookup` must name a non-empty lookup. An interpolated
  //    empty constant leaves `to lookup` dangling at end-of-query.
  if (/\bto\s+lookup\s*(\||$)/.test(query.trim())) {
    errors.push(`${id}: export-to-lookup with empty lookup name`);
  }

  return errors;
}

/** Validate the full plan. Returns all violations across targets. */
export function validateProvisionPlan(targets: GuardTarget[]): string[] {
  return targets.flatMap((t) => validateQuery(t.id, t.query));
}
