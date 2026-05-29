/**
 * Persistent banners surfaced above every page when the workspace
 * is missing provisioning state the app depends on. Two checks
 * run in parallel on mount:
 *
 *   1. Saved searches — the `criblapm__*` scheduled-search plan
 *      delivered via @cribl/app-utils. Without these, every page
 *      load runs the underlying queries live (slow). The framework
 *      provisioner's `planOnly()` returns the diff; any non-noop
 *      action means provisioning is incomplete.
 *
 *   2. Dataset acceleration — the otel dataset-ruleset extend
 *      expression + acceleratedFields list. Without these, queries
 *      fall back to dotted-path access (still functional, but
 *      slower). See src/api/datasetProvisioner.ts.
 *
 * Each banner persists until the corresponding provisioner runs
 * (the user clicks the Settings → Provision button). Banners
 * never dismiss — when the user fixes the underlying state they
 * also disappear because the next mount re-checks and sees them
 * as ok.
 *
 * Re-checks happen on route navigation (component remount keyed
 * to dataset in AppShell) and don't poll. Fast: each check is a
 * single API call.
 */
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { createBrowserHttpClient } from '@cribl/app-utils/provisioner';
import { planOnly, type PlanAction } from '../api/provisioner';
import {
  getStatus as getDatasetStatus,
  type DatasetProvisioningStatus,
} from '../api/datasetProvisioner';
import s from './ProvisioningBanners.module.css';

interface SavedSearchState {
  loading: boolean;
  needsAttention: boolean;
  missingCount: number;
}

interface DatasetState {
  loading: boolean;
  needsAttention: boolean;
  status: DatasetProvisioningStatus | null;
}

export default function ProvisioningBanners() {
  const location = useLocation();
  const [savedSearches, setSavedSearches] = useState<SavedSearchState>({
    loading: true,
    needsAttention: false,
    missingCount: 0,
  });
  const [dataset, setDataset] = useState<DatasetState>({
    loading: true,
    needsAttention: false,
    status: null,
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
        setSavedSearches({
          loading: false,
          needsAttention: missing.length > 0,
          missingCount: missing.length,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setSavedSearches({ loading: false, needsAttention: false, missingCount: 0 });
        }
      });

    void getDatasetStatus(http)
      .then((status) => {
        if (cancelled) return;
        const needsAttention =
          !status.ruleset.ok || !status.acceleratedFields.ok;
        setDataset({ loading: false, needsAttention, status });
      })
      .catch(() => {
        if (!cancelled) {
          setDataset({ loading: false, needsAttention: false, status: null });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Suppress on Settings page itself — the panels there already
  // tell the user what's missing, and the banner pointing at the
  // page they're on adds noise.
  if (location.pathname === '/settings') return null;

  const show =
    (!savedSearches.loading && savedSearches.needsAttention) ||
    (!dataset.loading && dataset.needsAttention);
  if (!show) return null;

  return (
    <div className={s.stack}>
      {savedSearches.needsAttention && (
        <Banner
          tone="warning"
          title="Scheduled searches not fully provisioned"
          body={
            <>
              The app caches its hot panel queries (Home catalog,
              sparklines, slow trace classes) as <code>criblapm__*</code>{' '}
              scheduled saved searches.{' '}
              {savedSearches.missingCount === 1
                ? '1 search needs'
                : `${savedSearches.missingCount} searches need`}{' '}
              creation or update. Page loads run the underlying queries
              live until you finish provisioning.
            </>
          }
        />
      )}
      {dataset.needsAttention && (
        <Banner
          tone="info"
          title="Dataset acceleration not configured"
          body={
            <>
              The <code>otel</code> dataset is missing field-flattening
              ruleset and/or accelerated-fields configuration. Queries
              fall back to dotted-path access (still works; about
              1.5–2.3× slower on the hot path).
            </>
          }
        />
      )}
    </div>
  );
}

interface BannerProps {
  tone: 'warning' | 'info';
  title: string;
  body: React.ReactNode;
}
function Banner({ tone, title, body }: BannerProps) {
  return (
    <div className={`${s.banner} ${tone === 'warning' ? s.warning : s.info}`}>
      <div className={s.bannerIcon} aria-hidden>
        {tone === 'warning' ? '⚠' : 'ℹ'}
      </div>
      <div className={s.bannerMain}>
        <div className={s.bannerTitle}>{title}</div>
        <div className={s.bannerBody}>{body}</div>
      </div>
      <Link to="/settings" className={s.bannerAction}>
        Open settings
      </Link>
    </div>
  );
}

