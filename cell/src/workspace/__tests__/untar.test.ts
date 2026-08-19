/**
 * Streaming untar: round-trip a real gzipped tar through the parser it
 * uses at checkout time (DecompressionStream + incremental tar parse).
 * Covers multi-file archives, non-512-aligned content, the top-dir prefix
 * GitHub adds, and early-stop (onEntry → false).
 */
import { describe, it, expect } from 'vitest';
import { gunzipUntarEach, stripTopDir, type TarEntry } from '../untar';

const enc = new TextEncoder();
const dec = new TextDecoder();
const BLOCK = 512;

/** Build one ustar file record (header + padded content). */
function tarFile(path: string, content: string): Uint8Array {
  const body = enc.encode(content);
  const header = new Uint8Array(BLOCK);
  header.set(enc.encode(path), 0); // name
  header.set(enc.encode(body.length.toString(8).padStart(11, '0') + '\0'), 124); // size (octal)
  header[156] = '0'.charCodeAt(0); // typeflag: regular file
  const padded = Math.ceil(body.length / BLOCK) * BLOCK;
  const rec = new Uint8Array(BLOCK + padded);
  rec.set(header, 0);
  rec.set(body, BLOCK);
  return rec;
}

function concatAll(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** A gzip stream of a tar built from the given files, ending in zero blocks. */
function gzTar(files: Array<[string, string]>): ReadableStream<Uint8Array> {
  const archive = concatAll([
    ...files.map(([p, c]) => tarFile(p, c)),
    new Uint8Array(BLOCK * 2), // end-of-archive
  ]);
  return new Blob([archive]).stream().pipeThrough(new CompressionStream('gzip'));
}

async function collect(files: Array<[string, string]>): Promise<TarEntry[]> {
  const out: TarEntry[] = [];
  await gunzipUntarEach(gzTar(files), (e) => {
    out.push({ path: e.path, content: e.content.slice() });
  });
  return out;
}

describe('gunzipUntarEach', () => {
  it('extracts multiple files, including non-512-aligned content', async () => {
    const entries = await collect([
      ['repo-main/src/a.js', 'const a = 1;'], // 12 bytes → 1 block
      ['repo-main/src/big.txt', 'x'.repeat(1000)], // spans 2 blocks
      ['repo-main/README.md', '# hi'],
    ]);
    expect(entries.map((e) => e.path)).toEqual([
      'repo-main/src/a.js',
      'repo-main/src/big.txt',
      'repo-main/README.md',
    ]);
    expect(dec.decode(entries[0].content)).toBe('const a = 1;');
    expect(dec.decode(entries[1].content)).toBe('x'.repeat(1000));
    expect(stripTopDir(entries[0].path)).toBe('src/a.js');
  });

  it('stops early when onEntry returns false', async () => {
    const seen: string[] = [];
    await gunzipUntarEach(gzTar([['r/a', '1'], ['r/b', '2'], ['r/c', '3']]), (e) => {
      seen.push(e.path);
      return seen.length < 2; // false after the 2nd → stop
    });
    expect(seen).toEqual(['r/a', 'r/b']);
  });
});
