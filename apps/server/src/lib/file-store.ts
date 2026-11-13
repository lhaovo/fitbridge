import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FileStore, StoredFile } from '@fitbridge/core';

/**
 * 本地文件系统 blob 存储。
 *
 * 单用户自托管场景下这已经够用（决策 D3：纯自托管，不引入对象存储服务）。
 * 目录结构：<root>/sha256/<前2>/<第3-4>/<完整hash>
 */
export class LocalFileStore implements FileStore {
  readonly kind = 'local-fs';

  constructor(private readonly root: string) {}

  async put(content: Buffer): Promise<StoredFile> {
    const sha256 = createHash('sha256').update(content).digest('hex');
    const blobKey =
      'sha256/' + sha256.slice(0, 2) + '/' + sha256.slice(2, 4) + '/' + sha256;
    const path = join(this.root, blobKey);
    try {
      await stat(path);
    } catch {
      await mkdir(dirname(path), { recursive: true });
      // 先写临时文件再改名，避免留下半截文件
      const tmp = path + '.tmp-' + process.pid + '-' + Date.now();
      await writeFile(tmp, content);
      await rename(tmp, path);
    }
    return { blobKey, sha256, byteSize: content.length };
  }

  async get(blobKey: string): Promise<Buffer> {
    return readFile(join(this.root, blobKey));
  }

  async exists(blobKey: string): Promise<boolean> {
    try {
      await stat(join(this.root, blobKey));
      return true;
    } catch {
      return false;
    }
  }

  async delete(blobKey: string): Promise<void> {
    await rm(join(this.root, blobKey), { force: true });
  }
}
