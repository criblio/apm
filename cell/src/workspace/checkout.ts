/**
 * Fetch a GitHub repo into the RepoStore: the source tarball (via the
 * DO's outbound fetch) plus a RECENT_COMMITS.md written into the tree so
 * the agent can see what changed lately without git history.
 */
import { gunzipUntar } from './untar';
import type { RepoStore, CheckoutStats } from './repoStore';
import type { SourceRepo } from '../protocol';

/** One configured source repo (from Settings / cell env). `url` is a
 *  GitHub URL or `owner/repo`; `service` maps it to a telemetry service
 *  (`*`/omitted = monorepo catch-all); `ref` is an optional branch/sha. */
export type RepoConfig = SourceRepo;

export interface ResolvedRepo {
  owner: string;
  repo: string;
  ref?: string;
  name: string;
}

const RECENT_COMMITS_PATH = 'RECENT_COMMITS.md';
const GITHUB_API = 'https://api.github.com';
const COMMIT_COUNT = 20;

/** Parse `owner/repo` from a GitHub URL or shorthand. */
export function parseRepo(url: string): { owner: string; repo: string } | null {
  const m =
    /github\.com[/:]([^/]+)\/([^/#?]+)/.exec(url) ??
    /^([^/\s]+)\/([^/\s#?]+)$/.exec(url.trim());
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
}

/**
 * Pick the repo for a target service: exact `service` match wins, else
 * the first catch-all (`*` or no service). Returns null if nothing fits.
 */
export function resolveRepoForService(
  repos: RepoConfig[],
  service: string | undefined,
  byName?: string,
): (RepoConfig & ResolvedRepo) | null {
  const candidates = byName
    ? repos.filter((r) => (r.name ?? parseRepo(r.url)?.repo) === byName)
    : repos;
  const exact = service
    ? candidates.find((r) => r.service && r.service !== '*' && r.service === service)
    : undefined;
  const chosen =
    exact ?? candidates.find((r) => !r.service || r.service === '*') ?? candidates[0];
  if (!chosen) return null;
  const parsed = parseRepo(chosen.url);
  if (!parsed) return null;
  return {
    ...chosen,
    owner: parsed.owner,
    repo: parsed.repo,
    ref: chosen.ref,
    name: chosen.name ?? parsed.repo,
  };
}

function authHeaders(token?: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    'user-agent': 'cribl-apm-investigator',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

/** Check out a resolved repo into the store; returns store stats. */
export async function checkoutRepo(
  store: RepoStore,
  resolved: ResolvedRepo,
  token?: string,
): Promise<CheckoutStats> {
  const { owner, repo, ref, name } = resolved;
  const tarUrl = `${GITHUB_API}/repos/${owner}/${repo}/tarball${ref ? `/${ref}` : ''}`;
  const resp = await fetch(tarUrl, { headers: authHeaders(token) });
  if (!resp.ok) {
    throw new Error(`tarball fetch failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
  }
  const entries = await gunzipUntar(await resp.arrayBuffer());
  const stats = store.store(name, entries);
  store.writeFile(name, RECENT_COMMITS_PATH, await fetchRecentCommits(owner, repo, ref, token));
  return stats;
}

/** Fetch recent commits and format them as markdown for the tree. */
async function fetchRecentCommits(
  owner: string,
  repo: string,
  ref: string | undefined,
  token?: string,
): Promise<string> {
  const url = new URL(`${GITHUB_API}/repos/${owner}/${repo}/commits`);
  url.searchParams.set('per_page', String(COMMIT_COUNT));
  if (ref) url.searchParams.set('sha', ref);
  try {
    const resp = await fetch(url.toString(), { headers: authHeaders(token) });
    if (!resp.ok) return `# Recent commits\n\n(could not fetch: HTTP ${resp.status})\n`;
    const commits = (await resp.json()) as Array<{
      sha: string;
      commit: { message: string; author?: { name?: string; date?: string } };
    }>;
    const lines = commits.map((c) => {
      const subject = (c.commit.message ?? '').split('\n')[0];
      const who = c.commit.author?.name ?? '?';
      const when = c.commit.author?.date ?? '';
      return `- \`${c.sha.slice(0, 7)}\` ${subject} — ${who}${when ? `, ${when}` : ''}`;
    });
    return `# Recent commits (${owner}/${repo})\n\n${lines.join('\n')}\n`;
  } catch (err) {
    return `# Recent commits\n\n(error: ${err instanceof Error ? err.message : String(err)})\n`;
  }
}
