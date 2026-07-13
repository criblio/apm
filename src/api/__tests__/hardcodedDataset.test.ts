/**
 * Guards against future recurrence of the "hardcoded `dataset=\"otel\"`
 * KQL literal in app code" outage class (root cause of the "unknown
 * lookup criblapm_trace_originators" report on v0.10.0).
 *
 * Every runtime query MUST resolve the dataset name via
 * `getCurrentDataset()` (or the per-signal `datasetFor(...)`, once
 * that ships) — never bake `dataset="otel"` into the KQL string.
 * When a user configures a non-default dataset in Settings, any
 * hardcoded literal silently reads zero rows: no crash, no error,
 * just an empty table.
 *
 * The provision guard (src/api/provisionGuard.ts) catches this in
 * `provisionedSearches.ts` at deploy time. This test extends the
 * same guarantee to ad-hoc queries in `src/routes/**` and
 * `src/api/**` that bypass the provisioner.
 *
 * Comments are stripped before scanning so docstrings that reference
 * the pattern for context (e.g. describing the fix) don't false-fire.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC_ROOT = new URL('../../', import.meta.url).pathname;

/** Files/paths exempt from the check. Test scaffolding and framework
 *  glue naturally reference the pattern for testing purposes. */
const EXEMPT_PATTERNS = [
  /\/__tests__\//,
  /\/__snapshots__\//,
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /\.d\.ts$/,
];

/** Strip `// ...` and `/* ... *\/` comments so docstrings describing
 *  the forbidden pattern (for context) don't get flagged. Preserves
 *  line numbers by leaving newlines in place. */
function stripComments(src: string): string {
  // Block comments (non-greedy, multi-line via [\s\S]).
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\n]/g, ' '),
  );
  // Line comments — replace with spaces to preserve column offsets.
  out = out.replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
  return out;
}

function walk(dir: string): string[] {
  const entries = readdirSync(dir);
  const out: string[] = [];
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe('hardcoded dataset="otel" guard', () => {
  it('has no literal `dataset="otel"` in runtime source', () => {
    const files = walk(SRC_ROOT).filter(
      (f) => !EXEMPT_PATTERNS.some((p) => p.test(f)),
    );
    const hits: string[] = [];
    for (const file of files) {
      const raw = readFileSync(file, 'utf8');
      const stripped = stripComments(raw);
      const lines = stripped.split('\n');
      lines.forEach((line, i) => {
        // Match `dataset="otel"` in JS source AND `dataset=\"otel\"`
        // in a string literal (which appears after JS string escaping).
        if (/dataset\s*=\s*\\?"otel\\?"/.test(line)) {
          hits.push(`${relative(SRC_ROOT, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    if (hits.length > 0) {
      throw new Error(
        `Found ${hits.length} hardcoded \`dataset="otel"\` literal(s) in app code. ` +
          `Every runtime query must resolve the dataset via ` +
          `getCurrentDataset() so a user's Settings-configured dataset is honored. ` +
          `Silent failure mode: non-default dataset users see empty tables/panels.\n\n` +
          hits.join('\n'),
      );
    }
    expect(hits).toEqual([]);
  });
});
