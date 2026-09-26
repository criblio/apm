/**
 * Every GoatTown path the app calls must be allowlisted by the fetch proxy.
 *
 * The app cannot reach GoatTown directly: the platform proxy rewrites the
 * call, injects the credential from KV, and rejects any path not declared in
 * config/proxies.yml with "Path is not allowed". That rejection happens in the
 * platform, before the request leaves the page, so it surfaces as a generic
 * error with no mention of GoatTown — and #171 removed `/configurations` and
 * `/config` from the allowlist at the same time as the code that used them,
 * so nothing failed until the code came back.
 *
 * Unit tests stub fetch and never see the proxy, and the live smoke tests
 * exercise sessions rather than provisioning, so nothing else covers this.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MANIFEST = join('config', 'proxies.yml');
const EXPECTED = join('config', 'proxies.expected.yml');

/** Paths the app calls, and what breaks when each is missing. */
const REQUIRED_PATHS: Array<{ path: string; usedBy: string }> = [
  { path: '/investigations', usedBy: 'session create/messages/status/events' },
  { path: '/agents', usedBy: 'the agent catalog' },
  { path: '/protocol', usedBy: 'capability checks, including canFireAlerts' },
  { path: '/configurations', usedBy: 'staging the goattown.config.yaml revision' },
  { path: '/config/repos', usedBy: 'source repos for alert-fired investigations' },
];

/** Read the `paths.allowlist` entries. Deliberately a small parser rather
 *  than a YAML dependency: the manifest is a pinned, flat, hand-maintained
 *  file, and the release tooling is the thing that validates its schema. */
function allowlistedPaths(file: string): string[] {
  const lines = readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex((line) => line.trim() === 'allowlist:');
  expect(start, `${file} declares no paths.allowlist`).toBeGreaterThan(-1);
  const paths: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const entry = /^\s+- (\/\S*)\s*$/.exec(line);
    if (entry) {
      paths.push(entry[1]);
      continue;
    }
    // Comments and blank lines interleave the list; anything else ends it.
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    break;
  }
  return paths;
}

describe('GoatTown fetch-proxy allowlist', () => {
  it.each(REQUIRED_PATHS)('allows $path, used by $usedBy', ({ path, usedBy }) => {
    expect(
      allowlistedPaths(MANIFEST),
      `${path} is not allowlisted, so ${usedBy} fails with "Path is not allowed"`,
    ).toContain(path);
  });

  it('matches the pinned manifest the release tooling compares against', () => {
    expect(readFileSync(MANIFEST, 'utf8')).toBe(readFileSync(EXPECTED, 'utf8'));
  });
});
