/**
 * Per-investigation store for checked-out repo source, in the DO's
 * SQLite. Reads are always one file at a time (or paths-only) to stay
 * under celld's in-memory result cap — never `SELECT content` across
 * the whole tree at once.
 *
 * Text source only: binary files (NUL bytes) and oversized files are
 * skipped at store time, so `read_file`/`grep_code` always return text.
 */
import type { TarEntry } from './untar';
import { stripTopDir } from './untar';

/** Skip any single file larger than this (source files are far smaller;
 *  this keeps a lockfile/vendored blob from bloating the DO). */
const MAX_FILE_BYTES = 256 * 1024;
/** Stop storing after this many files / this much total. Deliberately
 *  modest: the store runs synchronously inside the DO's single thread,
 *  and a giant polyglot repo (the OTel demo tarball is ~66 MB) will
 *  wedge the DO — status/events start returning 502 — long before it
 *  finishes. Source is what the agent reads; assets/generated/vendored
 *  trees are filtered out below, so a few thousand files is plenty. */
const MAX_FILES = 2500;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
/** Yield to the DO's request queue every N inserts so a big checkout
 *  can't monopolize the single thread — status/events stay answerable
 *  mid-checkout, and the turn's abort signal gets a chance to fire. */
const YIELD_EVERY = 200;

/** Path segments whose whole subtree is noise for source investigation
 *  (dependencies, build output, generated code, VCS metadata). Matched
 *  case-insensitively against any path segment. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'bin', 'obj', 'target',
  'vendor', '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.pytest_cache',
  'coverage', 'testdata', 'test-data', 'fixtures', '__snapshots__', '.gradle',
  '.idea', '.vscode', 'gen', 'generated', '.terraform', 'Pods', 'DerivedData',
]);

/** File extensions that are assets/binaries/generated — never source the
 *  agent needs to read. Skipped by name before the (costlier) decode +
 *  NUL-scan. */
const SKIP_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'svg', 'tif', 'tiff',
  'woff', 'woff2', 'ttf', 'eot', 'otf', 'mp4', 'webm', 'mov', 'mp3', 'wav',
  'ogg', 'pdf', 'zip', 'gz', 'tgz', 'tar', 'bz2', 'xz', '7z', 'rar', 'jar',
  'war', 'class', 'so', 'dylib', 'dll', 'exe', 'wasm', 'o', 'a', 'lib',
  'bin', 'dat', 'pyc', 'pyo', 'lock', 'map', 'min.js', 'min.css', 'ipynb',
]);

/** Skip a path before decoding it: noise subtrees + asset/binary
 *  extensions. Keeps the store to actual source. */
function shouldSkipPath(path: string): boolean {
  const lower = path.toLowerCase();
  const segments = lower.split('/');
  for (const seg of segments.slice(0, -1)) {
    if (SKIP_DIRS.has(seg)) return true;
  }
  const base = segments[segments.length - 1] ?? '';
  if (base.endsWith('.min.js') || base.endsWith('.min.css')) return true;
  const dot = base.lastIndexOf('.');
  if (dot > 0 && SKIP_EXT.has(base.slice(dot + 1))) return true;
  return false;
}

export interface CheckoutStats {
  stored: number;
  /** Total bytes stored (drives the total-size cap). */
  bytes: number;
  skippedLarge: number;
  skippedBinary: number;
  /** Files in dependency/build/generated trees or asset extensions,
   *  filtered before decode. */
  skippedNoise: number;
  truncated: boolean;
}

/** A fresh zeroed stats accumulator for a streaming checkout. */
export function emptyStats(): CheckoutStats {
  return { stored: 0, bytes: 0, skippedLarge: 0, skippedBinary: 0, skippedNoise: 0, truncated: false };
}

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

// Minimal shape of the DO's SQLite handle we use (avoids importing the
// full workers-types surface here).
interface Sql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

export class RepoStore {
  constructor(private readonly sql: Sql) {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS repo_files (
         repo TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL,
         PRIMARY KEY (repo, path)
       )`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS repo_meta (
         repo TEXT PRIMARY KEY, checked_out_at INTEGER NOT NULL,
         file_count INTEGER NOT NULL
       )`,
    );
  }

  /** True if this repo has already been checked out this investigation. */
  hasRepo(repo: string): boolean {
    return (
      this.sql
        .exec(`SELECT 1 FROM repo_meta WHERE repo = ? LIMIT 1`, repo)
        .toArray().length > 0
    );
  }

  private readonly decoder = new TextDecoder(); // utf-8, non-fatal

  /** Clear any prior copy of a repo before a fresh (streaming) checkout. */
  beginRepo(repo: string): void {
    this.sql.exec(`DELETE FROM repo_files WHERE repo = ?`, repo);
  }

  /** Record the repo's file count once a streaming checkout finishes. */
  finalizeRepo(repo: string, stats: CheckoutStats): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO repo_meta (repo, checked_out_at, file_count) VALUES (?, ?, ?)`,
      repo,
      Date.now(),
      stats.stored,
    );
  }

  /**
   * Store one tar entry (called per-file by the streaming untar), applying
   * the noise/size/binary filters and updating `stats` in place. Returns
   * `false` once a cap is hit so the caller can stop extracting the rest of
   * the archive. Yields to the DO's request queue every few hundred inserts
   * and honors `signal`, so a large repo can neither wedge nor outlive a
   * cancel.
   */
  async addFile(
    repo: string,
    entry: TarEntry,
    stats: CheckoutStats,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (stats.stored >= MAX_FILES || stats.bytes >= MAX_TOTAL_BYTES) {
      stats.truncated = true;
      return false;
    }
    const path = stripTopDir(entry.path);
    if (!path) return true;
    if (shouldSkipPath(path)) {
      stats.skippedNoise++;
      return true;
    }
    if (entry.content.length > MAX_FILE_BYTES) {
      stats.skippedLarge++;
      return true;
    }
    if (isBinary(entry.content)) {
      stats.skippedBinary++;
      return true;
    }
    this.sql.exec(
      `INSERT OR REPLACE INTO repo_files (repo, path, content) VALUES (?, ?, ?)`,
      repo,
      path,
      this.decoder.decode(entry.content),
    );
    stats.stored++;
    stats.bytes += entry.content.length;
    if (stats.stored % YIELD_EVERY === 0) {
      if (signal?.aborted) throw new Error('checkout aborted');
      // Macrotask yield: lets queued status/events requests interleave
      // between insert batches instead of 502-ing while we grind.
      await new Promise((r) => setTimeout(r, 0));
    }
    return true;
  }

  /** Store an in-memory list of entries (test/non-streaming convenience;
   *  the cell checkout streams via beginRepo + addFile + finalizeRepo). */
  async store(repo: string, entries: TarEntry[], signal?: AbortSignal): Promise<CheckoutStats> {
    this.beginRepo(repo);
    const stats = emptyStats();
    for (const entry of entries) {
      if (!(await this.addFile(repo, entry, stats, signal))) break;
    }
    this.finalizeRepo(repo, stats);
    return stats;
  }

  /** Write a synthetic file (e.g. RECENT_COMMITS.md) into the store. */
  writeFile(repo: string, path: string, content: string): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO repo_files (repo, path, content) VALUES (?, ?, ?)`,
      repo,
      path,
      content.slice(0, MAX_FILE_BYTES),
    );
  }

  /** Immediate children (files + dirs) under `dir` within `repo`. */
  listDir(repo: string, dir: string): string[] {
    const prefix = dir && dir !== '/' ? `${dir.replace(/^\/|\/$/g, '')}/` : '';
    const rows = this.sql
      .exec(
        `SELECT path FROM repo_files WHERE repo = ? AND path LIKE ? ORDER BY path`,
        repo,
        `${prefix}%`,
      )
      .toArray();
    const children = new Set<string>();
    for (const r of rows) {
      const rest = String(r.path).slice(prefix.length);
      const slash = rest.indexOf('/');
      children.add(slash === -1 ? rest : `${rest.slice(0, slash)}/`);
    }
    return [...children].sort();
  }

  /** Read one file's content (null if absent). */
  readFile(repo: string, path: string): string | null {
    const clean = path.replace(/^\//, '');
    const rows = this.sql
      .exec(`SELECT content FROM repo_files WHERE repo = ? AND path = ? LIMIT 1`, repo, clean)
      .toArray();
    return rows.length ? String(rows[0].content) : null;
  }

  /** Grep a regex across the repo, reading one file at a time. */
  grep(
    repo: string,
    pattern: string,
    opts: { pathPrefix?: string; maxMatches?: number } = {},
  ): { matches: GrepMatch[]; truncated: boolean } {
    const maxMatches = opts.maxMatches ?? 100;
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch {
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }
    const prefix = opts.pathPrefix ? opts.pathPrefix.replace(/^\//, '') : '';
    const paths = this.sql
      .exec(
        `SELECT path FROM repo_files WHERE repo = ? AND path LIKE ? ORDER BY path`,
        repo,
        `${prefix}%`,
      )
      .toArray()
      .map((r) => String(r.path));

    const matches: GrepMatch[] = [];
    for (const path of paths) {
      const content = this.readFile(repo, path);
      if (content == null) continue;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          matches.push({ path, line: i + 1, text: lines[i].slice(0, 400) });
          if (matches.length >= maxMatches) return { matches, truncated: true };
        }
      }
    }
    return { matches, truncated: false };
  }
}
