import type {
  AuthInput,
  AuthOutput,
  Credential,
  CredentialHealth,
  FilePayload,
  Paged,
  PlatformAdapter,
  RemoteActivity,
  RemoteActivityDetail,
} from '@fitbridge/core';
import { MyWhooshClient } from './client.js';
import { mywhooshManifest } from './manifest.js';
import * as auth from './auth.js';
import * as activities from './activities.js';
import * as files from './files.js';

export { mywhooshManifest };
export { MYWHOOSH_API_BASE, MYWHOOSH_LOGIN_URL } from './client.js';

export class MyWhooshAdapter implements PlatformAdapter {
  readonly manifest = mywhooshManifest;
  private readonly client = new MyWhooshClient();

  async auth(input: AuthInput): Promise<AuthOutput> {
    return auth.login(this.client, input);
  }

  async validate(cred: Credential): Promise<CredentialHealth> {
    const ok = await auth.validate(this.client, cred.secret, cred.meta);
    return {
      ok,
      reason: ok ? undefined : 'MyWhoosh token 无效或已过期',
      checkedAt: new Date().toISOString(),
    };
  }

  async listActivities(
    cred: Credential,
    opts?: { cursor?: string; limit?: number },
  ): Promise<Paged<RemoteActivity>> {
    return activities.listActivities(this.client, cred, opts);
  }

  async getActivityDetail(
    _cred: Credential,
    remoteId: string,
  ): Promise<RemoteActivityDetail> {
    // 列表项里已包含 activityFileId，无需额外请求；这里仅作占位
    return { remoteId };
  }

  async downloadFile(
    cred: Credential,
    activity: RemoteActivityDetail,
  ): Promise<FilePayload> {
    return files.downloadFile(this.client, cred, activity);
  }
}

export function createMyWhooshAdapter(): PlatformAdapter {
  return new MyWhooshAdapter();
}
