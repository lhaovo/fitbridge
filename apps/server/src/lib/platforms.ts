import type { PlatformAdapter, PlatformManifest } from '@fitbridge/core';
import { OtmAdapter } from '@fitbridge/adapter-otm';
import { MyWhooshAdapter } from '@fitbridge/adapter-mywhoosh';

/**
 * 平台注册表。
 *
 * 新增平台只需在这里注册一个适配器实例，
 * 引擎、API、UI 的能力矩阵都会自动跟着变。
 */
const registry = new Map<string, PlatformAdapter>();

export function registerPlatforms(adapters: PlatformAdapter[]): void {
  for (const a of adapters) {
    registry.set(a.manifest.id, a);
  }
}

export function getAdapter(platformId: string): PlatformAdapter | undefined {
  return registry.get(platformId);
}

export function listManifests(): PlatformManifest[] {
  return [...registry.values()]
    .map((a) => a.manifest)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function registerBuiltinPlatforms(): void {
  registerPlatforms([new OtmAdapter(), new MyWhooshAdapter()]);
}
