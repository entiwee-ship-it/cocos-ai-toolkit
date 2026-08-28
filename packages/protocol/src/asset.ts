import { z } from 'zod';

export const DocumentTypeSchema = z.enum(['scene', 'prefab']);

export const AssetRecordSchema = z.object({
  assetUuid: z.string().min(1),
  url: z.string().nullable(),
  filePath: z.string().nullable(),
  type: z.string().nullable(),
  importer: z.string().nullable(),
  name: z.string().nullable(),
  displayName: z.string().nullable(),
  source: z.string().nullable(),
  path: z.string().nullable(),
  isSubAsset: z.boolean().nullable(),
  isBundle: z.boolean().nullable(),
  imported: z.boolean().nullable(),
  invalid: z.boolean().nullable(),
  isDirectory: z.boolean().nullable(),
  visible: z.boolean().nullable(),
  readonly: z.boolean().nullable(),
  available: z.boolean(),
  raw: z.unknown().optional()
});

export const ScriptAssetRecordSchema = z.object({
  assetUuid: z.string().min(1),
  scriptPath: z.string().nullable(),
  filePath: z.string().nullable(),
  classNames: z.array(z.string()),
  available: z.boolean(),
  raw: z.unknown().optional()
});

export const DocumentAssetRecordSchema = z.object({
  assetUuid: z.string().min(1),
  path: z.string().nullable(),
  filePath: z.string().nullable(),
  documentType: DocumentTypeSchema,
  available: z.boolean(),
  raw: z.unknown().optional()
});

export type AssetRecord = z.infer<typeof AssetRecordSchema>;
export type ScriptAssetRecord = z.infer<typeof ScriptAssetRecordSchema>;
export type DocumentAssetRecord = z.infer<typeof DocumentAssetRecordSchema>;
export type DocumentType = z.infer<typeof DocumentTypeSchema>;
