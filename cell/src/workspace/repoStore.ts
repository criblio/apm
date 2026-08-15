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
/** Stop storing after this many files / this much total. */
const MAX_FILES = 6000;
const MAX_TOTAL_BYTES = 48 * 1024 * 1024;

export interface CheckoutStats {
  stored: number;
  skippedLarge: number;
  skippedBinary: number;
  truncated: boolean;
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

  /** Store a tarball's entries under `repo`, stripping GitHub's top dir
   *  and skipping binary/oversized files. Idempotent-ish: clears any
   *  prior copy of the same repo first. */
  store(repo: string, entries: TarEntry[]): CheckoutStats {
    this.sql.exec(`DELETE FROM repo_files WHERE repo = ?`, repo);
    const stats: CheckoutStats = {
      stored: 0,
      skippedLarge: 0,
      skippedBinary: 0,
      truncated: false,
    };
    let total = 0;
    const decoder = new TextDecoder(); // utf-8, non-fatal
    for (const entry of entries) {
      if (stats.stored >= MAX_FILES || total >= MAX_TOTAL_BYTES) {
        stats.truncated = true;
        break;
      }
      if (entry.content.length > MAX_FILE_BYTES) {
        stats.skippedLarge++;
        continue;
      }
      if (isBinary(entry.content)) {
        stats.skippedBinary++;
        continue;
      }
      const path = stripTopDir(entry.path);
      if (!path) continue;
      this.sql.exec(
        `INSERT OR REPLACE INTO repo_files (repo, path, content) VALUES (?, ?, ?)`,
        repo,
        path,
        decoder.decode(entry.content),
      );
      stats.stored++;
      total += entry.content.length;
    }
    this.sql.exec(
      `INSERT OR REPLACE INTO repo_meta (repo, checked_out_at, file_count) VALUES (?, ?, ?)`,
      repo,
      Date.now(),
      stats.stored,
    );
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
