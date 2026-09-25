/**
 * Identity of one on-disk version of a file, for stat-keyed parse caches.
 *
 * mtime alone is not enough: on Linux, file timestamps advance in kernel
 * ticks, so two writes inside one tick share an mtime and a cache keyed on
 * mtime serves the stale parse. Atomic writers (tmp + rename) produce a new
 * inode, and in-place rewrites usually change the size, so the triple
 * catches both. Residual blind spot: an in-place rewrite of identical size
 * inside one tick (no crew writer does this). `size` and `ino` are optional
 * on the cached side so callers that only recorded an mtime keep their
 * previous behaviour.
 */
export interface FileVersion {
  readonly mtimeMs: number;
  readonly size?: number;
  readonly ino?: number;
}

export function fileVersion(stat: {
  readonly mtimeMs: number;
  readonly size: number;
  readonly ino: number;
}): Required<FileVersion> {
  return { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
}

export function sameFileVersion(cached: FileVersion, current: FileVersion): boolean {
  if (cached.mtimeMs !== current.mtimeMs) return false;
  if (cached.size !== undefined && cached.size !== current.size) return false;
  if (cached.ino !== undefined && cached.ino !== current.ino) return false;
  return true;
}
