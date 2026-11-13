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
  UploadHint,
  UploadResult,
} from '@fitbridge/core';
import { OtmClient } from './client.js';
import { otmManifest } from './manifest.js';
import * as auth from './auth.js';
import * as activities from './activities.js';
import * as files from './files.js';
import * as upload from './upload.js';

export { otmManifest };
export { md5 } from './auth.js';
export { OTM_BASE } from './client.js';

export class OtmAdapter implements PlatformAdapter {
  readonly manifest = otmManifest;
  private readonly client = new OtmClient();

  async auth(input: AuthInput): Promise<AuthOutput> {
    return auth.login(this.client, input);
  }

  async validate(cred: Credential): Promise<CredentialHealth> {
    const ok = await auth.validate(this.client, cred.secret);
    return {
      ok,
      reason: ok ? undefined : '迈金 token 无效或已过期',
      checkedAt: new Date().toISOString(),
    };
  }

  async refresh(cred: Credential): Promise<Credential> {
    return {
      ...cred,
      secret: await auth.refresh(this.client, cred.secret),
    };
  }

  async listActivities(
    cred: Credential,
    opts?: { cursor?: string; limit?: number },
  ): Promise<Paged<RemoteActivity>> {
    return activities.listActivities(this.client, cred, opts);
  }

  async getActivityDetail(
    cred: Credential,
    remoteId: string,
  ): Promise<RemoteActivityDetail> {
    return activities.getActivityDetail(this.client, cred, remoteId);
  }

  async downloadFile(
    cred: Credential,
    activity: RemoteActivityDetail,
  ): Promise<FilePayload> {
    return files.downloadFile(this.client, cred, activity);
  }

  async uploadFile(
    cred: Credential,
    file: { content: Buffer; kind: 'fit' | 'gpx' | 'tcx'; filename: string },
    hint: UploadHint,
  ): Promise<UploadResult> {
    return upload.uploadFile(this.client, cred, file, hint);
  }
}

export function createOtmAdapter(): PlatformAdapter {
  return new OtmAdapter();
}
