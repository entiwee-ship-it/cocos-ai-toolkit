import { z } from 'zod';
import { DocumentTypeSchema } from './asset.js';

export const PrefabInstanceLinkSchema = z.object({
  depth: z.number().int().nonnegative(),
  assetUuid: z.string(),
  instanceNodeUuid: z.string().nullable()
});

export const PrefabContextSchema = z.object({
  ownerDocumentAssetUuid: z.string().nullable(),
  sourcePrefabAssetUuid: z.string().nullable(),
  instanceRootObjectUuid: z.string().nullable(),
  sourceObjectFileId: z.string().nullable(),
  instanceChain: z.array(PrefabInstanceLinkSchema)
});

export const PrefabPropertyOverrideSchema = z.object({
  index: z.number().int().nonnegative(),
  targetLocalIds: z.array(z.string()),
  propertyPath: z.array(z.string()),
  declaredType: z.string().nullable(),
  sourceValue: z.unknown().nullable(),
  overrideValue: z.unknown(),
  effectiveValue: z.unknown().nullable(),
  raw: z.unknown()
});

export const PrefabProbeSchema = z.object({
  ownerDocumentAssetUuid: z.string().nullable(),
  sourcePrefabAssetUuid: z.string().nullable(),
  instanceRootObjectUuid: z.string().nullable(),
  sourceObjectFileId: z.string().nullable(),
  instanceFileId: z.string().nullable(),
  prefabRootNodeUuid: z.string().nullable(),
  sync: z.boolean().nullable(),
  state: z.unknown().nullable(),
  propertyOverrides: z.array(PrefabPropertyOverrideSchema),
  targetOverrides: z.array(z.unknown()),
  mountedChildren: z.array(z.unknown()),
  mountedComponents: z.array(z.unknown()),
  removedComponents: z.array(z.unknown()),
  unresolved: z.array(z.object({ path: z.string(), reason: z.string() })),
  rawPrefabInfo: z.unknown()
});

export const PrefabGraphNodeSchema = z.object({
  assetUuid: z.string().min(1),
  path: z.string().nullable(),
  documentType: DocumentTypeSchema
});

export const PrefabGraphEdgeSchema = z.object({
  fromAssetUuid: z.string().min(1),
  toAssetUuid: z.string().min(1),
  kind: z.literal('prefab-instance'),
  hostNodePath: z.string().nullable(),
  instanceFileId: z.string().nullable(),
  sourceObjectFileId: z.string().nullable(),
  depth: z.number().int().nonnegative(),
  overrideCount: z.number().int().nonnegative()
});

export const PrefabGraphSchema = z.object({
  nodes: z.array(PrefabGraphNodeSchema),
  edges: z.array(PrefabGraphEdgeSchema)
});

export type PrefabContext = z.infer<typeof PrefabContextSchema>;
export type PrefabProbe = z.infer<typeof PrefabProbeSchema>;
export type PrefabGraphNode = z.infer<typeof PrefabGraphNodeSchema>;
export type PrefabGraphEdge = z.infer<typeof PrefabGraphEdgeSchema>;
export type PrefabGraph = z.infer<typeof PrefabGraphSchema>;
