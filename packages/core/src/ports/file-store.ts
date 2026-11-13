/**
 * 文件存储抽象。
 *
 * 为什么需要它：FIT/GPX 是二进制大对象（单条 1-10MB），
 * 不适合塞进关系库；但当前是**单用户自托管单体**（决策 D2/D3），
 * 所以本地磁盘就足够了——不需要 MinIO / S3。
 *
 * 保留这个接口是为了将来：多用户、远程 worker、或想用 S3 兼容存储时，
 * 只换实现不改引擎。
 *
 * 布局：内容寻址（sha256），天然去重 + 完整性校验。
 */
export interface StoredFile {
  /** 对象 key，例如 sha256/ab/cd/abcdef... */
  blobKey: string;
  sha256: string;
  byteSize: number;
}

export interface FileStore {
  /** 写入（内容相同则复用已有 blob） */
  put(content: Buffer): Promise<StoredFile>;
  /** 读取 */
  get(blobKey: string): Promise<Buffer>;
  exists(blobKey: string): Promise<boolean>;
  /** 删除 */
  delete(blobKey: string): Promise<void>;
  /** 存储后端名称（用于 /health 展示） */
  readonly kind: string;
}
