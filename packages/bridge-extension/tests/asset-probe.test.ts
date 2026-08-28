import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeAssets } from '../src/asset-probe';

const originalEditorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Editor');

afterEach(() => {
  vi.restoreAllMocks();
  if (originalEditorDescriptor) {
    Object.defineProperty(globalThis, 'Editor', originalEditorDescriptor);
    return;
  }
  Reflect.deleteProperty(globalThis, 'Editor');
});

describe('probeAssets', () => {
  it('无 UUID 时继续返回资产列表兼容结果', async () => {
    const request = vi.fn(async (_channel: string, method: string) => {
      if (method === 'query-assets') {
        return [{ uuid: 'prefab-uuid', url: 'db://assets/ui/Test.prefab', type: 'cc.Prefab' }];
      }
      throw new Error(`UNEXPECTED_METHOD:${method}`);
    });
    Object.defineProperty(globalThis, 'Editor', {
      configurable: true,
      value: { Message: { request } }
    });

    await expect(probeAssets({})).resolves.toMatchObject({
      assets: [{ uuid: 'prefab-uuid' }],
      details: null
    });
  });

  it('精确 UUID 检查直接读取 asset info，不请求全量 query-assets', async () => {
    const request = vi.fn(async (_channel: string, method: string) => {
      if (method === 'query-asset-info') {
        return { uuid: 'prefab-uuid', url: 'db://assets/ui/Test.prefab', type: 'cc.Prefab' };
      }
      if (method === 'query-asset-meta') return { importer: 'prefab' };
      if (method === 'query-asset-dependencies' || method === 'query-asset-users') return [];
      throw new Error(`UNEXPECTED_METHOD:${method}`);
    });
    Object.defineProperty(globalThis, 'Editor', {
      configurable: true,
      value: { Message: { request } }
    });

    await expect(probeAssets({ uuid: 'prefab-uuid' })).resolves.toMatchObject({
      assets: [],
      details: { uuid: 'prefab-uuid', type: 'cc.Prefab' }
    });
    expect(request.mock.calls.map((call) => call[1])).not.toContain('query-assets');
  });

  it('同时提供 pattern 和 UUID 时保留列表与详情兼容返回', async () => {
    const request = vi.fn(async (_channel: string, method: string) => {
      if (method === 'query-assets') {
        return [{ uuid: 'prefab-uuid', url: 'db://assets/ui/Test.prefab', type: 'cc.Prefab' }];
      }
      if (method === 'query-asset-info') {
        return { uuid: 'prefab-uuid', url: 'db://assets/ui/Test.prefab', type: 'cc.Prefab' };
      }
      if (method === 'query-asset-meta') return { importer: 'prefab' };
      if (method === 'query-asset-dependencies' || method === 'query-asset-users') return [];
      throw new Error(`UNEXPECTED_METHOD:${method}`);
    });
    Object.defineProperty(globalThis, 'Editor', {
      configurable: true,
      value: { Message: { request } }
    });

    await expect(probeAssets({ pattern: 'Test', uuid: 'prefab-uuid' })).resolves.toMatchObject({
      assets: [{ uuid: 'prefab-uuid' }],
      details: { uuid: 'prefab-uuid' }
    });
    expect(request.mock.calls.map((call) => call[1])).toContain('query-assets');
  });

  it('detailsOnly 只读取轻量 asset info', async () => {
    const request = vi.fn(async (_channel: string, method: string) => {
      if (method === 'query-asset-info') {
        return { uuid: 'prefab-uuid', url: 'db://assets/ui/Test.prefab', type: 'cc.Prefab' };
      }
      throw new Error(`UNEXPECTED_METHOD:${method}`);
    });
    Object.defineProperty(globalThis, 'Editor', {
      configurable: true,
      value: { Message: { request } }
    });

    await expect(probeAssets({ uuid: 'prefab-uuid', detailsOnly: true })).resolves.toMatchObject({
      details: { uuid: 'prefab-uuid' },
      meta: null,
      dependencies: null,
      users: null
    });
    expect(request.mock.calls.map((call) => call[1])).toEqual(['query-asset-info']);
  });
});
