import { z } from 'zod';

export const ReferenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('node'),
    objectUuid: z.string().nullable(),
    fileId: z.string().nullable(),
    nodePath: z.string().nullable(),
    available: z.boolean()
  }),
  z.object({
    kind: z.literal('component'),
    objectUuid: z.string().nullable(),
    fileId: z.string().nullable(),
    typeId: z.string().nullable(),
    nodePath: z.string().nullable(),
    available: z.boolean()
  }),
  z.object({
    kind: z.literal('asset'),
    assetUuid: z.string(),
    subAssetUuid: z.string().nullable(),
    assetType: z.string().nullable(),
    path: z.string().nullable(),
    available: z.boolean()
  }),
  z.object({
    kind: z.literal('missing'),
    expectedKind: z.enum(['node', 'component', 'asset', 'unknown']),
    serializedUuid: z.string().nullable(),
    serializedFileId: z.string().nullable(),
    reason: z.string()
  })
]);

export type Reference = z.infer<typeof ReferenceSchema>;
