import { describe, expect, it } from 'vitest';
import { buildNodeWriteCapabilities } from '../src/write-applicability.js';

describe('buildNodeWriteCapabilities', () => {
  it('普通 Scene 节点和当前 Prefab 自有节点允许直接写入', () => {
    for (const input of [
      {
        documentAssetUuid: 'scene-asset',
        documentMode: 'general',
        nodeFileId: null,
        prefabAssetUuid: null,
        sourceUrl: null,
        isInstanceRoot: false
      },
      {
        documentAssetUuid: 'owner-prefab',
        documentMode: 'prefab',
        nodeFileId: 'owner-node',
        prefabAssetUuid: 'owner-prefab',
        sourceUrl: 'db://assets/Owner.prefab',
        isInstanceRoot: false
      }
    ]) {
      expect(buildNodeWriteCapabilities(input)).toMatchObject({
        assessment: 'confirmed',
        isNestedPrefabContent: false,
        canRename: true,
        canSetTransform: true,
        canCreateChild: true,
        canSetComponentProperty: true,
        reasonCode: null
      });
    }
  });

  it('嵌套实例根只保留命名、放置和整实例操作', () => {
    expect(buildNodeWriteCapabilities({
      documentAssetUuid: 'owner-prefab',
      documentMode: 'prefab',
      nodeFileId: 'nested-root-file',
      prefabAssetUuid: 'nested-prefab',
      sourceUrl: 'db://assets/Nested.prefab',
      isInstanceRoot: true
    })).toMatchObject({
      assessment: 'confirmed',
      isNestedPrefabContent: true,
      isInstanceRoot: true,
      canRename: true,
      canSetTransform: true,
      canDelete: true,
      canReparent: true,
      canDuplicate: true,
      canSetActive: false,
      canSetLayer: false,
      canCreateChild: false,
      canAddComponent: false,
      canRemoveComponent: false,
      canSetComponentProperty: false,
      reasonCode: 'NESTED_PREFAB_INSTANCE_ROOT_LIMITED',
      nextAction: {
        tool: 'cocos_prefab_open',
        arguments: { uuid: 'nested-prefab' }
      }
    });
  });

  it('嵌套实例内容节点拒绝所有公开节点和组件写入', () => {
    expect(buildNodeWriteCapabilities({
      documentAssetUuid: 'owner-prefab',
      documentMode: 'prefab',
      nodeFileId: 'nested-child-file',
      prefabAssetUuid: 'nested-prefab',
      sourceUrl: 'db://assets/Nested.prefab',
      isInstanceRoot: false
    })).toMatchObject({
      isNestedPrefabContent: true,
      canRename: false,
      canSetTransform: false,
      canDelete: false,
      canReparent: false,
      canDuplicate: false,
      canCreateChild: false,
      canSetComponentProperty: false,
      reasonCode: 'NESTED_PREFAB_CONTENT_CLOSED'
    });
  });

  it('文档身份缺失时不猜测拒绝，交给写后验证兜底', () => {
    expect(buildNodeWriteCapabilities({
      documentAssetUuid: null,
      documentMode: null,
      nodeFileId: null,
      prefabAssetUuid: 'nested-prefab',
      sourceUrl: null,
      isInstanceRoot: false
    })).toMatchObject({
      assessment: 'unknown',
      canSetTransform: true,
      canSetComponentProperty: true,
      reasonCode: 'DOCUMENT_IDENTITY_UNAVAILABLE'
    });
  });
});
