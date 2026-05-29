/**
 * Setup status card — shown at the top of the Settings page so
 * first-time installers immediately see whether the two required
 * provisioning steps have run.
 *
 * Reuses the same checks the global ProvisioningBanners component
 * uses (`planOnly()` and `getDatasetStatus()`), but renders them as
 * a compact stand-alone summary card with anchor links to the
 * relevant Settings sections.
 */
import { useEffect, useState } from 'react';
import { createBrowserHttpClient } from '@cribl/app-utils/provisioner';
import { planOnly, type PlanAction } from '../api/provisioner';
import {
  getStatus as getDatasetStatus,
  type DatasetProvisioningStatus,
} from '../api/datasetProvisioner';
import s from './SettingsSetupStatus.module.css';

interface CheckState {
  loading: boolean;
  ok: boolean;
  detail: string;
}

export default function SettingsSetupStatus() {
  const [searches, setSearches] = useState<CheckState>({
    loading: true,
    ok: false,
    detail: 'Checking…',
  });
  const [dataset, setDataset] = useState<CheckState>({
    loading: true,
    ok: false,
    detail: 'Checking…',
  });

  useEffect(() => {
    let cancelled = false;
    const http = createBrowserHttpClient();

    void planOnly(http)
      .then(({ actions }) => {
        if (cancelled) return;
        const missing = actions.filter(
          (a: PlanAction) => a.kind === 'create' || a.kind === 'update',
        );
        setSearches({
          loading: false,
          ok: missing.length === 0,
          detail:
            missing.length === 0
              ? 'All scheduled searches provisioned'
              : `${missing.length} action${missing.length === 1 ? '' : 's'} pending`,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setSearches({
          loading: false,
          ok: false,
          detail: `Could not check: ${err instanceof Error ? err.message : String(err)}`,
        });
      });

    void getDatasetStatus(http)
      .then((status: DatasetProvisioningStatus) => {
        if (cancelled) return;
        const ok = status.ruleset.ok && status.acceleratedFields.ok;
        const issues: string[] = [];
        if (!status.ruleset.ok) issues.push('dataset ruleset');
        if (!status.acceleratedFields.ok) issues.push('accelerated fields');
        setDataset({
          loading: false,
          ok,
          detail: ok
            ? 'Ruleset + accelerated fields applied'
            : `Missing: ${issues.join(', ')}`,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setDataset({
          loading: false,
          ok: false,
          detail: `Could not check: ${err instanceof Error ? err.message : String(err)}`,
        });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const allOk = searches.ok && dataset.ok && !searches.loading && !dataset.loading;

  return (
    <section className={`${s.card} ${allOk ? s.cardOk : ''}`} aria-labelledby="setup-status-heading">
      <header className={s.header}>
        <h2 id="setup-status-heading" className={s.title}>
          Setup status
        </h2>
        <p className={s.subtitle}>
          The two install steps Cribl APM needs the first time it's
          loaded against a fresh workspace. Both must succeed before
          the rest of the app reads cached data instead of running
          everything live.
        </p>
      </header>

      <ul className={s.checks}>
        <CheckRow
          state={searches}
          label="Scheduled searches"
          anchor="provisioning"
          anchorLabel="Provisioning"
        />
        <CheckRow
          state={dataset}
          label="Dataset acceleration"
          anchor="dataset-acceleration"
          anchorLabel="Dataset acceleration"
        />
      </ul>
    </section>
  );
}

function CheckRow({
  state,
  label,
  anchor,
  anchorLabel,
}: {
  state: CheckState;
  label: string;
  anchor: string;
  anchorLabel: string;
}) {
  const tone = state.loading ? 'loading' : state.ok ? 'ok' : 'warn';
  return (
    <li className={`${s.check} ${s[`check_${tone}`]}`}>
      <span className={s.checkIcon} aria-hidden>
        {state.loading ? '…' : state.ok ? '✓' : '!'}
      </span>
      <div className={s.checkBody}>
        <div className={s.checkLabel}>{label}</div>
        <div className={s.checkDetail}>{state.detail}</div>
      </div>
      {!state.ok && !state.loading && (
        <a className={s.checkAction} href={`#${anchor}`}>
          Jump to {anchorLabel} →
        </a>
      )}
    </li>
  );
}
