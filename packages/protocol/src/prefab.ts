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

export type PrefabContext = z.infer<typeof PrefabContextSchema>;
