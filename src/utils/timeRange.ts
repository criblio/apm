/**
 * Relative-time helpers.
 *
 * Cribl Search accepts relative time strings like "-1h", "-30m", "-7d"
 * for both `earliest` and `latest`. That lets us query a *previous*
 * window of equal length just by shifting the bounds: "-1h → now"
 * becomes "-2h → -1h".
 */

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse a relative-time string like "-1h" or "-30m" into its duration
 * in milliseconds. Anything that doesn't match is treated as 1h (the
 * default range everywhere else in the app).
 */
export function relativeTimeMs(rel: string): number {
  const m = rel.match(/^-(\d+)([smhd])$/);
  if (!m) return 3_600_000;
  const n = Number(m[1]);
  const unit = m[2];
  return n * (UNIT_MS[unit] ?? 3_600_000);
}

/**
 * Given a current window (relative `earliest`, fixed `latest=now`),
 * return the previous window of the same length. For "-1h" current,
 * previous is { earliest: "-2h", latest: "-1h" }.
 *
 * The unit is preserved so the string stays human-readable (we don't
 * normalize "-1d" to "-24h"). When the unit would need to change
 * (e.g. "-7d" prev is "-14d"), we just double the numeric part.
 */
export function previousWindow(currentEarliest: string): {
  earliest: string;
  latest: string;
} {
  const m = currentEarliest.match(/^-(\d+)([smhd])$/);
  if (!m) return { earliest: '-2h', latest: '-1h' };
  const n = Number(m[1]);
  const unit = m[2];
  return { earliest: `-${n * 2}${unit}`, latest: `-${n}${unit}` };
}
