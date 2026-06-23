/**
 * Thin wrapper around Capra's `<Alert>` so existing callers
 * (`<StatusBanner kind="error">…</StatusBanner>`) keep working
 * with no churn. Maps our two-kind API onto Capra's appearance
 * vocabulary:
 *
 *   - `kind="error"` → `appearance="danger"`
 *   - `kind="info"`  → `appearance="info"`
 *
 * If a caller eventually needs success / warning, switch them
 * directly onto Capra's `<Alert>` rather than expanding this
 * shim — the shim only exists to keep the migration surgical.
 */
import { Alert } from '@capra/core';

interface Props {
  kind: 'error' | 'info';
  children: React.ReactNode;
}

export default function StatusBanner({ kind, children }: Props) {
  const appearance = kind === 'error' ? 'danger' : 'info';
  return (
    <Alert appearance={appearance} layout="section">
      {children}
    </Alert>
  );
}
