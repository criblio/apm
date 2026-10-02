/**
 * Shift a cron expression's minute field later by `minutes`, keeping
 * the same period. Used to stagger dependent scheduled searches after
 * the panel searches they read (evaluator +1, notify +2, incident
 * grouper +3, incident fold +4 — REQUIREMENTS §1.5).
 *
 * Mirrors `offsetCron` in `@criblio/app-utils/cadence` (0.11.2) so APM
 * can switch to the import with no behaviour change:
 *
 *   - minute field `*` (every minute, e.g. the 1m cadence `* * * * *`)
 *     → unchanged. Every minute is already "one minute after" the
 *     previous producer run; there is no later phase to move to.
 *   - `*\/N` → `k-59/N` where k = minutes mod N; k = 0 → unchanged.
 *   - a literal minute m (e.g. hourly `0 * * * *`) → (m + minutes) mod 60.
 *   - anything else (lists, ranges, malformed) → unchanged.
 *
 * The bug this replaces: the old inline `.replace(/^\* /, '1 ')` turned
 * the 1m cadence `* * * * *` into `1 * * * *`, so every dependent
 * search ran HOURLY instead of every minute.
 */
export function offsetCron(cron: string, minutes: number): string {
  const fields = cron.trim().split(/\s+/);
  const minute = fields[0];
  if (minute === undefined || minute === '*') return cron;

  const step = /^\*\/(\d+)$/.exec(minute);
  if (step) {
    const n = Number(step[1]);
    if (!Number.isInteger(n) || n <= 0) return cron;
    const k = ((minutes % n) + n) % n;
    if (k === 0) return cron;
    return [`${k}-59/${n}`, ...fields.slice(1)].join(' ');
  }

  if (/^\d+$/.test(minute)) {
    const m = Number(minute);
    if (m > 59) return cron;
    const shifted = (((m + minutes) % 60) + 60) % 60;
    return [String(shifted), ...fields.slice(1)].join(' ');
  }

  return cron;
}
