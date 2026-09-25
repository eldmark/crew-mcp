import { mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fileVersion, sameFileVersion } from '../../src/utils/file-version.js';

describe('file-version', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-file-version-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('treats an unchanged file as the same version', () => {
    const path = join(dir, 'state.json');
    writeFileSync(path, '{"a":1}');
    expect(sameFileVersion(fileVersion(statSync(path)), fileVersion(statSync(path)))).toBe(true);
  });

  it('detects an in-place rewrite with a different size even when mtime ties', () => {
    const cached = { mtimeMs: 1000, size: 7, ino: 42 };
    expect(sameFileVersion(cached, { mtimeMs: 1000, size: 9, ino: 42 })).toBe(false);
  });

  it('detects a tmp + rename replacement of the same size even when mtime ties', () => {
    const path = join(dir, 'state.json');
    writeFileSync(path, '{"a":1}');
    const before = fileVersion(statSync(path));
    writeFileSync(`${path}.tmp`, '{"a":2}');
    renameSync(`${path}.tmp`, path);
    const after = fileVersion(statSync(path));
    expect(after.size).toBe(before.size);
    expect(sameFileVersion(before, { ...after, mtimeMs: before.mtimeMs })).toBe(false);
  });

  it('keeps mtime-only comparison for entries that did not record size or inode', () => {
    expect(sameFileVersion({ mtimeMs: 1000 }, { mtimeMs: 1000, size: 1, ino: 1 })).toBe(true);
    expect(sameFileVersion({ mtimeMs: 1000 }, { mtimeMs: 1001, size: 1, ino: 1 })).toBe(false);
  });
});
