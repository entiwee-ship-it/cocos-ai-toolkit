import { access, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFile(new URL(path, root), 'utf8');

describe('直写架构不可回填事务系统', () => {
  it('协议模块使用 write-operations 命名且不存在 transaction 文件', async () => {
    const index = await read('packages/protocol/src/index.ts');
    expect(index).toContain("./write-operations.js");
    expect(index).not.toContain('./transaction.js');
    await expect(access(new URL('packages/protocol/src/transaction.ts', root))).rejects.toBeDefined();
    await expect(access(new URL('packages/protocol/tests/transaction.test.ts', root))).rejects.toBeDefined();
  });

  it('当前直写请求、结果和写证据不再携带 Undo 或 inverse', async () => {
    const sources = await Promise.all([
      read('packages/protocol/src/write.ts'),
      read('packages/mcp-server/src/direct-tools.ts'),
      read('packages/bridge-extension/src/write-types.ts'),
      read('packages/bridge-extension/src/node-writer.ts'),
      read('packages/bridge-extension/src/component-writer.ts'),
      read('packages/bridge-extension/src/prefab-writer.ts'),
      read('packages/bridge-extension/src/write-scene-channel.ts')
    ]);
    for (const source of sources) {
      expect(source).not.toMatch(/\bundoGroup(?:Id)?\b/);
      expect(source).not.toMatch(/\binverse\b/);
      expect(source).not.toContain('saveAndVerifyWriteTransaction');
    }
  });

  it('正式 Bridge 不注册阶段调试探针', async () => {
    const [main, scene] = await Promise.all([
      read('packages/bridge-extension/src/main.ts'),
      read('packages/bridge-extension/src/scene.ts')
    ]);
    for (const name of ['debugEditorMessage', 'debugPrefabLifecycle', 'debugPrefabFacade']) {
      expect(main).not.toContain(name);
      expect(scene).not.toContain(name);
    }
  });

  it('当前使用手册不再包含已移除工具和 Revision/apply 流程', async () => {
    const playbook = await read('docs/usage-playbook.md');
    for (const removed of ['cocos_design_apply', 'cocos_transaction_status', 'cocos_write_prepare']) {
      expect(playbook).not.toContain(removed);
    }
    expect(playbook).not.toMatch(/\bRevision\b/);
  });
});
