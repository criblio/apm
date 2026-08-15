/**
 * Streaming gzip + tar extraction for repo checkout.
 *
 * GitHub's codeload serves a `.tar.gz`. We pipe the response body straight
 * through the runtime's `DecompressionStream('gzip')` (available in
 * workerd/celld) and parse the tar incrementally — no npm dependency, and
 * crucially **never buffering the whole archive**. The old version read the
 * entire decompressed tree into one Uint8Array (~9 MB for the OTel demo,
 * more with parse overhead), which spiked memory enough to OOM a celld
 * isolate and take the daemon down. This version holds only a rolling
 * buffer (a single file plus a partial record) at any moment.
 *
 * Scope: regular files (typeflag '0'/'\0') with ustar `prefix` support for
 * long paths. Directories, symlinks, pax/GNU-longname extended headers, and
 * any single file larger than MAX_ENTRY_BYTES are skipped without being
 * buffered. The leading `<repo>-<ref>/` dir GitHub adds is stripped by the
 * caller.
 */
export interface TarEntry {
  /** Path within the archive (still includes GitHub's top-level dir). */
  path: string;
  content: Uint8Array;
}

const BLOCK = 512;
/** Never buffer a single file bigger than this — far above any source
 *  file, so this only guards against a vendored blob / accidental binary
 *  ballooning the rolling buffer. Such files are skipped, not stored. */
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
/** Zip-bomb backstop: stop if the decompressed stream exceeds this. Well
 *  above any real source repo. */
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

function readString(block: Uint8Array, offset: number, length: number): string {
  let end = offset;
  const limit = offset + length;
  while (end < limit && block[end] !== 0) end++;
  return new TextDecoder().decode(block.subarray(offset, end));
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Stream a GitHub tarball, invoking `onEntry` for each regular file as it
 * emerges. `onEntry` may be async (the store awaits a yield/insert per
 * file); returning `false` stops extraction early (e.g. once a cap is hit)
 * so we don't decompress the rest of the archive.
 *
 * `gzStream` is the raw gzip stream (e.g. a fetch `Response.body`) — it is
 * piped through DecompressionStream here, so the caller never buffers it.
 */
export async function gunzipUntarEach(
  gzStream: ReadableStream<Uint8Array>,
  onEntry: (entry: TarEntry) => Promise<boolean | void> | boolean | void,
): Promise<void> {
  const reader = gzStream.pipeThrough(new DecompressionStream('gzip')).getReader();
  // Typed as ArrayBufferLike because DecompressionStream chunks are, and we
  // both alias a chunk and concat into this buffer.
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  // Content bytes still to discard (an oversized/non-regular file whose
  // body spans reads) — dropped as they arrive so we never buffer them.
  let skip = 0;
  let totalRead = 0;
  let stop = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value && value.length) {
        totalRead += value.length;
        if (totalRead > MAX_ARCHIVE_BYTES) {
          throw new Error('archive exceeds the decompressed-size limit');
        }
        let chunk = value;
        if (skip > 0) {
          const drop = Math.min(skip, chunk.length);
          skip -= drop;
          chunk = chunk.subarray(drop);
        }
        if (chunk.length) pending = pending.length ? concat(pending, chunk) : chunk.slice();
      }

      let pos = 0;
      while (skip === 0 && pos + BLOCK <= pending.length) {
        const header = pending.subarray(pos, pos + BLOCK);
        const name = readString(header, 0, 100);
        if (name === '') {
          stop = true; // a zero block marks end-of-archive
          break;
        }
        const sizeStr = readString(header, 124, 12).trim();
        const size = sizeStr ? parseInt(sizeStr, 8) || 0 : 0;
        const type = String.fromCharCode(header[156]);
        const prefix = readString(header, 345, 155);
        const fullPath = prefix ? `${prefix}/${name}` : name;
        const padded = Math.ceil(size / BLOCK) * BLOCK;
        const contentStart = pos + BLOCK;
        const isRegular = type === '0' || type === '\0' || type === '';

        if (isRegular && size <= MAX_ENTRY_BYTES) {
          if (contentStart + size > pending.length) break; // need the whole file first
          const content = pending.subarray(contentStart, contentStart + size);
          const cont = await onEntry({ path: fullPath, content });
          if (cont === false) {
            stop = true;
            break;
          }
          const next = contentStart + padded;
          if (next <= pending.length) pos = next;
          else {
            // trailing padding hasn't arrived yet — skip it as it comes
            skip = next - pending.length;
            pos = pending.length;
          }
        } else {
          // discard content (non-regular, or too big to be source)
          const avail = pending.length - contentStart;
          if (avail >= padded) pos = contentStart + padded;
          else {
            skip = padded - avail;
            pos = pending.length;
          }
        }
      }

      // Drop consumed bytes: slice() copies only the small unconsumed tail
      // and lets the rest be collected — this is what bounds peak memory.
      if (pos > 0) pending = pending.slice(pos);
      if (stop || done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Strip GitHub's leading `<repo>-<ref>/` directory from an entry path. */
export function stripTopDir(path: string): string {
  const slash = path.indexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}
