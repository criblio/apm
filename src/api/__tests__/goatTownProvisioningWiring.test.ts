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
 * The same migration dropped `pushCellRepos` entirely, which is why
 * alert-fired investigations silently lost their code tools: interactive runs
 * thread repos at create time, so only the autonomous path broke, and nothing
 * asserted that path existed.
 *
 * The app has no component-test stack (no jsdom, no Testing Library), and
 * adding one to assert a wiring is not proportionate. So this asserts the
 * narrow thing that actually broke: a UI surface imports each helper and
 * invokes it. If someone deliberately moves this work elsewhere, update the
 * expected surface here — the point is that removal has to be a decision
 * rather than an accident.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Each entry: the export, the module that defines it, and how many call
 *  sites the Settings page is expected to have. */
const REQUIRED_WIRINGS = [
  {
    name: 'stageApmInvestigatorConfiguration',
    definedIn: join('api', 'goatTownProvisioning.ts'),
    settingsCallSites: 2,
    why: 'the GoatTown configuration revision would never be staged',
  },
  {
    name: 'pushGoatTownRepos',
    definedIn: join('api', 'investigationTransport.ts'),
    settingsCallSites: 2,
    why: 'alert-fired investigations would run with no source repos',
  },
] as const;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe.each(REQUIRED_WIRINGS)('$name is reachable from the product', (wiring) => {
  const files = sourceFiles('src');

  it('is called by a user-facing surface', () => {
    const uiCallers = files
      .filter((path) => !path.endsWith(wiring.definedIn))
      .filter((path) => path.includes(join('src', 'routes')) || path.includes(join('src', 'components')))
      .filter((path) => readFileSync(path, 'utf8').includes(`${wiring.name}(`));
    expect(
      uiCallers,
      `no UI surface calls ${wiring.name}, so ${wiring.why}`,
    ).not.toHaveLength(0);
  });

  it('is wired into the Settings page at every expected call site', () => {
    const settings = readFileSync(join('src', 'routes', 'SettingsPage.tsx'), 'utf8');
    expect(settings).toContain(`import { ${wiring.name} }`);
    const invocations = settings.match(new RegExp(`await ${wiring.name}\\(`, 'g')) ?? [];
    expect(
      invocations.length,
      `expected ${wiring.settingsCallSites} call site(s) for ${wiring.name}`,
    ).toBeGreaterThanOrEqual(wiring.settingsCallSites);
  });
});

it('offers the standalone staging action in the UI', () => {
  expect(readFileSync(join('src', 'routes', 'SettingsPage.tsx'), 'utf8'))
    .toContain('Stage GoatTown revision');
});
