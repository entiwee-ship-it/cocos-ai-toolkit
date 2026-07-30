import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importAsset } from '../src/import-asset.js';

const originalEditorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Editor');
const temporaryRoots: string[] = [];

afterEach(async () => {
  if (originalEditorDescriptor) {
    Object.defineProperty(globalThis, 'Editor', originalEditorDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'Editor');
  }
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function installEditor(map: Record<string, unknown>) {
  const requestEditorMessage = vi.fn(async (_channel: string, message: string, ...args: unknown[]) => {
    const key = `${_channel}/${message}`;
    if (key in map) return map[key];
    throw new Error(`UNEXPECTED_EDITOR_MESSAGE:${key}:${JSON.stringify(args)}`);
  });
  Object.defineProperty(globalThis, 'Editor', {
    configurable: true,
    writable: true,
    value: { Message: { request: requestEditorMessage } }
  });
  return requestEditorMessage;
}

describe('importAsset', () => {
  it('复制外部文件到 assets 目标路径并触发导入', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cocos-ai-import-'));
    temporaryRoots.push(root);
    const source = join(root, 'icon.png');
    await writeFile(source, 'fake-png-bytes');
    const assetsRoot = join(root, 'assets');

    const requestEditorMessage = installEditor({
      'asset-db/query-asset-info': null,
      'asset-db/query-path': assetsRoot,
      'asset-db/refresh-asset': undefined
    });
    // query-asset-info 先查不存在，导入后再查得到
    let importDone = false;
    requestEditorMessage.mockImplementation(async (_channel: string, message: string) => {
      const key = `${_channel}/${message}`;
      if (key === 'asset-db/query-asset-info') {
        return importDone ? { uuid: 'imported-uuid', type: 'cc.Texture2D' } : null;
      }
      if (key === 'asset-db/query-path') return assetsRoot;
      if (key === 'asset-db/refresh-asset') {
        importDone = true;
        return undefined;
      }
      throw new Error(`UNEXPECTED_EDITOR_MESSAGE:${key}`);
    });

    const result = await importAsset({
      sourceFilePath: source,
      assetUrl: 'db://assets/ui/icon.png'
    }) as { uuid: string; assetUrl: string };

    expect(result).toEqual({ uuid: 'imported-uuid', type: 'cc.Texture2D', assetUrl: 'db://assets/ui/icon.png' });
    const copied = await import('node:fs/promises').then((fs) => fs.readFile(join(assetsRoot, 'ui/icon.png'), 'utf8'));
    expect(copied).toBe('fake-png-bytes');
  });

  it('目标资产已存在时拒绝覆盖', async () => {
    installEditor({
      'asset-db/query-asset-info': { uuid: 'existing-uuid' }
    });

    await expect(importAsset({
      sourceFilePath: 'E:/any.png',
      assetUrl: 'db://assets/ui/icon.png'
    })).rejects.toThrow('ASSET_ALREADY_EXISTS');
  });

  it('拒绝非法资产 URL 和缺失源路径', async () => {
    installEditor({});
    await expect(importAsset({
      sourceFilePath: 'E:/any.png',
      assetUrl: 'http://example.com/a.png'
    })).rejects.toThrow('ASSET_URL_INVALID');
    await expect(importAsset({
      sourceFilePath: '',
      assetUrl: 'db://assets/a.png'
    })).rejects.toThrow('SOURCE_FILE_PATH_REQUIRED');
  });
});
