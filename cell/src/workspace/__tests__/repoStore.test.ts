/**
 * RepoStore.store() filtering + caps + interruptibility. A large polyglot
 * checkout used to wedge the single-threaded DO (thousands of synchronous
 * inserts, no yield, no abort); these tests pin the guardrails that keep
 * it bounded and interruptible. A tiny fake Sql captures the inserts —
 * the real SQLite runtime is exercised by the cell smoke.
 */
import { describe, it, expect } from 'vitest';
import { RepoStore } from '../repoStore';
import type { TarEntry } from '../untar';

interface Row {
  repo: string;
  path: string;
  content: string;
}

/** Minimal Sql stand-in: records repo_files inserts, ignores the rest. */
function fakeSql() {
  const files: Row[] = [];
  return {
    files,
    exec(query: string, ...b: unknown[]) {
      if (/INSERT OR REPLACE INTO repo_files/.test(query)) {
        files.push({ repo: String(b[0]), path: String(b[1]), content: String(b[2]) });
      }
      return { toArray: () => [] as Record<string, unknown>[] };
    },
  };
}

const enc = new TextEncoder();
function entry(path: string, content: Uint8Array | string): TarEntry {
  return { path: `otel-main/${path}`, content: typeof content === 'string' ? enc.encode(content) : content };
}

describe('RepoStore.store filtering', () => {
  it('stores source and skips dependency/build/asset/binary noise', async () => {
    const sql = fakeSql();
    const rs = new RepoStore(sql as never);
    const big = enc.encode('x'.repeat(300 * 1024)); // > MAX_FILE_BYTES
    const withNul = new Uint8Array([104, 105, 0, 104, 105]); // "hi\0hi"
    const stats = await rs.store('otel', [
      entry('src/payment/charge.js', 'function charge() {}'),
      entry('node_modules/left-pad/index.js', 'module.exports = 1'),
      entry('gen/service.pb.go', 'package gen'),
      entry('src/frontend/logo.png', 'not really a png but .png ext'),
      entry('package-lock.json.lock', '{}'),
      entry('src/huge.js', big),
      entry('src/server.go', withNul),
    ]);

    expect(stats.stored).toBe(1);
    expect(sql.files.map((f) => f.path)).toEqual(['src/payment/charge.js']);
    // node_modules/, gen/, .png, .lock
    expect(stats.skippedNoise).toBe(4);
    expect(stats.skippedLarge).toBe(1);
    expect(stats.skippedBinary).toBe(1);
  });

  it('honors the abort signal on a large checkout', async () => {
    const sql = fakeSql();
    const rs = new RepoStore(sql as never);
    // > YIELD_EVERY source files so the abort check runs; pre-aborted.
    const entries = Array.from({ length: 250 }, (_, i) => entry(`src/f${i}.js`, `const x=${i}`));
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(rs.store('otel', entries, ctrl.signal)).rejects.toThrow(/abort/i);
  });
});
