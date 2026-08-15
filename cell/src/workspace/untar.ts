/**
 * Minimal gzip + tar extraction for repo checkout.
 *
 * GitHub's codeload serves a `.tar.gz`; we gunzip it with the runtime's
 * `DecompressionStream('gzip')` (available in workerd/celld) and parse
 * the tar ourselves — no npm dependency. Read-only, source files only.
 *
 * Scope: regular files (typeflag '0'/'\0') with ustar `prefix` support
 * for long paths. Directories, symlinks, and pax/GNU-longname extended
 * headers are skipped — fine for reading source trees. The leading
 * `<repo>-<ref>/` directory GitHub adds is stripped by the caller.
 */
export interface TarEntry {
  /** Path within the archive (still includes GitHub's top-level dir). */
  path: string;
  content: Uint8Array;
}

const BLOCK = 512;

function readString(block: Uint8Array, offset: number, length: number): string {
  let end = offset;
  const limit = offset + length;
  while (end < limit && block[end] !== 0) end++;
  return new TextDecoder().decode(block.subarray(offset, end));
}

/** Gunzip a GitHub tarball and return its regular-file entries. */
export async function gunzipUntar(gz: ArrayBuffer | Uint8Array): Promise<TarEntry[]> {
  const source = gz instanceof Uint8Array ? gz : new Uint8Array(gz);
  const stream = new Response(source).body!.pipeThrough(
    new DecompressionStream('gzip'),
  );
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());

  const entries: TarEntry[] = [];
  let off = 0;
  while (off + BLOCK <= buf.length) {
    const header = buf.subarray(off, off + BLOCK);
    const name = readString(header, 0, 100);
    if (name === '') break; // a zero block marks end-of-archive

    const sizeStr = readString(header, 124, 12).trim();
    const size = sizeStr ? parseInt(sizeStr, 8) || 0 : 0;
    const type = String.fromCharCode(header[156]);
    const prefix = readString(header, 345, 155);
    const fullPath = prefix ? `${prefix}/${name}` : name;

    off += BLOCK;
    if (type === '0' || type === '\0' || type === '') {
      entries.push({ path: fullPath, content: buf.subarray(off, off + size) });
    }
    off += Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}

/** Strip GitHub's leading `<repo>-<ref>/` directory from an entry path. */
export function stripTopDir(path: string): string {
  const slash = path.indexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}
