import { z } from 'zod';

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

export type PrefabContext = z.infer<typeof PrefabContextSchema>;
export type PrefabProbe = z.infer<typeof PrefabProbeSchema>;
