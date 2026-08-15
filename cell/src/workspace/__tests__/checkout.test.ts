/**
 * Pure-logic tests for repo resolution + path handling. The DO-backed
 * RepoStore and the tarball fetch/extract are exercised by the cell
 * smoke against a live cell (they need the SQLite runtime + network).
 */
import { describe, it, expect } from 'vitest';
import { parseRepo, resolveRepoForService, type RepoConfig } from '../checkout';
import { stripTopDir } from '../untar';

describe('parseRepo', () => {
  it('parses github URLs and owner/repo shorthand', () => {
    expect(parseRepo('https://github.com/open-telemetry/opentelemetry-demo')).toEqual({
      owner: 'open-telemetry',
      repo: 'opentelemetry-demo',
    });
    expect(parseRepo('open-telemetry/opentelemetry-demo')).toEqual({
      owner: 'open-telemetry',
      repo: 'opentelemetry-demo',
    });
    expect(parseRepo('git@github.com:org/repo.git')).toEqual({ owner: 'org', repo: 'repo' });
  });
  it('returns null for non-repo input', () => {
    expect(parseRepo('not a repo url')).toBeNull();
  });
});

describe('resolveRepoForService', () => {
  const repos: RepoConfig[] = [
    { url: 'github.com/org/monorepo', name: 'mono', service: '*' },
    { url: 'github.com/org/payment', name: 'payment', service: 'payment' },
  ];

  it('prefers an exact service match over the catch-all', () => {
    expect(resolveRepoForService(repos, 'payment')?.name).toBe('payment');
  });
  it('falls back to the wildcard/monorepo for an unmapped service', () => {
    expect(resolveRepoForService(repos, 'checkout')?.name).toBe('mono');
  });
  it('honors an explicit repo name over the service mapping', () => {
    expect(resolveRepoForService(repos, 'payment', 'mono')?.name).toBe('mono');
  });
  it('resolves owner/repo on the chosen entry', () => {
    const r = resolveRepoForService(repos, 'payment');
    expect(r?.owner).toBe('org');
    expect(r?.repo).toBe('payment');
  });
  it('returns null when nothing is configured', () => {
    expect(resolveRepoForService([], 'anything')).toBeNull();
  });
});

describe('stripTopDir', () => {
  it("strips GitHub's leading <repo>-<ref>/ directory", () => {
    expect(stripTopDir('opentelemetry-demo-abc123/src/frontend/index.ts')).toBe(
      'src/frontend/index.ts',
    );
  });
  it('leaves a path with no directory unchanged', () => {
    expect(stripTopDir('LICENSE')).toBe('LICENSE');
  });
});
