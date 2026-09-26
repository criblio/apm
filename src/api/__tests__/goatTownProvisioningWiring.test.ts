/**
 * Guard the UI wiring for GoatTown configuration staging.
 *
 * This is a source-level test rather than a behavioural one, which needs
 * justifying. `stageApmInvestigatorConfiguration` is well covered by
 * goatTownProvisioning.test.ts — but that coverage says nothing about whether
 * anything *calls* it. The SDK migration (#171) removed both of the Settings
 * page's call sites and replaced neither; five PRs then merged with a fully
 * green pipeline, because a function with no callers still passes its own unit
 * tests. The staging workflow was simply gone from the product.
 *
 * The app has no component-test stack (no jsdom, no Testing Library), and
 * adding one to assert a single wiring is not proportionate. So this asserts
 * the narrow thing that actually broke: a UI surface imports the staging
 * helper and invokes it. If someone deliberately moves staging elsewhere,
 * update the expected surface here — the point is that the removal has to be
 * a decision rather than an accident.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const STAGING_EXPORT = 'stageApmInvestigatorConfiguration';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('GoatTown configuration staging is reachable from the product', () => {
  const files = sourceFiles('src');
  const callers = files.filter((path) => {
    const text = readFileSync(path, 'utf8');
    return text.includes(`import { ${STAGING_EXPORT} }`) || text.includes(`${STAGING_EXPORT}(`);
  }).filter((path) => !path.endsWith(join('api', 'goatTownProvisioning.ts')));

  it('is imported and called by a user-facing surface', () => {
    expect(callers.length).toBeGreaterThan(0);
    const uiCallers = callers.filter((p) => p.includes(join('src', 'routes')) || p.includes(join('src', 'components')));
    expect(uiCallers, `no UI surface calls ${STAGING_EXPORT}; the staging workflow is unreachable`).not.toHaveLength(0);
  });

  it('is wired into the Settings page, both on Apply and as its own action', () => {
    const settings = readFileSync(join('src', 'routes', 'SettingsPage.tsx'), 'utf8');
    expect(settings).toContain(`import { ${STAGING_EXPORT} }`);
    // Apply (the ProvisioningPanel reconcile) and the standalone button.
    const invocations = settings.match(new RegExp(`await ${STAGING_EXPORT}\\(`, 'g')) ?? [];
    expect(invocations.length).toBeGreaterThanOrEqual(2);
    expect(settings).toContain('Stage GoatTown revision');
  });
});
