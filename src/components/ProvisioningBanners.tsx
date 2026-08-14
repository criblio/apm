/**
 * Persistent banners surfaced above every page when the workspace
 * is missing provisioning state the app depends on. Two checks
 * run in parallel via @cribl/app-utils's useProvisioningBanners:
 *
 *   1. Saved searches — the `criblapm__*` scheduled-search plan
 *      delivered via the framework provisioner. Without these,
 *      every page load runs the underlying queries live (slow).
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
import { useMemo } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Banner,
  useProvisioningBanners,
  type ProvisioningBannerSource,
} from '@cribl/app-utils/provisioning-banner';
import { createBrowserHttpClient } from '@cribl/app-utils/provisioner';
import { useDataset } from '@cribl/app-utils/dataset';
import { planOnly, type PlanAction } from '../api/provisioner';
import { getStatus as getDatasetStatus } from '../api/datasetProvisioner';
import { useServerInvestigations } from '../hooks/useServerInvestigations';
import { CONFIGURATION_PATH } from '../routes/paths';
import s from './ProvisioningBanners.module.css';

export default function ProvisioningBanners() {
  const location = useLocation();
  // Keyed to the dataset: planOnly() builds the desired KQL from
  // getCurrentDataset(), so the diff must be recomputed when the
  // KV-loaded (or user-changed) dataset arrives. Without this dep
  // the check races the async settings load and compares the
  // server's plan against one built from the wrong dataset.
  const dataset = useDataset();
  // Also a dep: getProvisioningPlan() gates criblapm__alert_notify on
  // this flag, which loads async from KV after mount. Without it here
  // the banner checks once with the flag still at its default and never
  // re-checks when the real value arrives — so it flaps in/out
  // depending on reload-vs-navigation timing.
  const serverInvestigations = useServerInvestigations();
  const sources = useMemo<ProvisioningBannerSource[]>(
    () => {
      const http = createBrowserHttpClient();
      return [
        async () => {
          const { actions } = await planOnly(http);
          const missing = actions.filter(
            (a: PlanAction) => a.kind === 'create' || a.kind === 'update',
          );
          if (missing.length === 0) return null;
          return {
            id: 'saved-searches',
            tone: 'warning',
            title: 'Scheduled searches not fully provisioned',
            body: (
              <>
                The app caches its hot panel queries (Home catalog,
                sparklines, slow trace classes) as <code>criblapm__*</code>{' '}
                scheduled saved searches.{' '}
                {missing.length === 1
                  ? '1 search needs'
                  : `${missing.length} searches need`}{' '}
                creation or update. Page loads run the underlying queries
                live until you finish provisioning.
              </>
            ),
          };
        },
        async () => {
          const status = await getDatasetStatus(http);
          const needsAttention =
            !status.ruleset.ok || !status.acceleratedFields.ok;
          if (!needsAttention) return null;
          return {
            id: 'dataset-acceleration',
            tone: 'info',
            title: 'Dataset acceleration not configured',
            body: (
              <>
                The <code>otel</code> dataset is missing field-flattening
                ruleset and/or accelerated-fields configuration. Queries
                fall back to dotted-path access (still works; about
                1.5–2.3× slower on the hot path).
              </>
            ),
          };
        },
      ];
    },
    // These deps force a `sources` rebuild — and thus a re-check via
    // useProvisioningBanners — even though the closure reads neither.
    //   - dataset:   planOnly() builds its plan from getCurrentDataset(),
    //     so a dataset change must recompute the diff.
    //   - pathname:  the banner lives in the persistent AppShell, so
    //     without this it checks once and never again. After the user
    //     provisions on the Configuration page and navigates away, the
    //     path change re-runs planOnly() so a now-complete plan clears
    //     the banner instead of it lingering until a full app reload.
    //     planOnly() is a saved-search list (one cheap GET), not a
    //     search job, so re-checking per navigation is inexpensive.
    //   - serverInvestigations: gates criblapm__alert_notify in the plan;
    //     loads async, so it must trigger a re-check when it arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataset, location.pathname, serverInvestigations],
  );

  const banners = useProvisioningBanners(sources);

  // Suppress on the Configuration page itself — the panels there
  // already tell the user what's missing, and the banner pointing at
  // the page they're on adds noise.
  if (location.pathname === CONFIGURATION_PATH) return null;
  if (banners.length === 0) return null;

  return (
    <div className={s.stack}>
      {banners.map((b) => (
        <Banner key={b.id} {...b}>
          <Link to={CONFIGURATION_PATH} className={s.bannerAction}>
            Open settings
          </Link>
        </Banner>
      ))}
    </div>
  );
}
