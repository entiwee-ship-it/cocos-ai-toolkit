import { z } from 'zod';
import { AssetRecordSchema, DocumentTypeSchema, ScriptAssetRecordSchema } from './asset.js';
import { CoverageSchema, ProjectCoverageSchema } from './coverage.js';
import { DiagnosticSchema, UnresolvedItemSchema } from './envelope.js';
import { ProbeNodeSchema } from './node.js';
import { PrefabGraphSchema, PrefabProbeSchema } from './prefab.js';
import { ComponentTypeSchemaSchema } from './schema.js';

export const DocumentSnapshotDocumentSchema = z.object({
  assetUuid: z.string().min(1).nullable(),
  path: z.string().nullable(),
  filePath: z.string().nullable(),
  documentType: DocumentTypeSchema.nullable(),
  available: z.boolean(),
  raw: z.unknown()
});

export const DocumentSnapshotPageSchema = z.object({
  offset: z.number().int().nonnegative(),
  pageSize: z.number().int().positive(),
  totalNodes: z.number().int().nonnegative(),
  nextCursor: z.string().nullable()
});

export const DocumentComponentSchemaSchema = ComponentTypeSchemaSchema.extend({
  componentUuid: z.string().min(1),
  nodeUuid: z.string().min(1),
  nodePath: z.string().nullable(),
  componentIndex: z.number().int().nonnegative()
});

export const DocumentSnapshotSchema = z.object({
  document: DocumentSnapshotDocumentSchema,
  revision: z.string().min(1),
  mode: z.enum(['summary', 'full']),
  page: DocumentSnapshotPageSchema,
  nodes: z.array(ProbeNodeSchema),
  componentSchemas: z.array(DocumentComponentSchemaSchema),
  prefabInstances: z.array(PrefabProbeSchema),
  coverage: CoverageSchema,
  unresolved: z.array(UnresolvedItemSchema),
  diagnostics: z.array(DiagnosticSchema),
  raw: z.unknown().optional()
}).passthrough();

export const ProjectScanReportSchema = z.object({
  scanId: z.string().min(1),
  status: z.enum(['running', 'completed', 'completed-with-gaps', 'failed']),
  project: z.object({
    projectId: z.string().min(1),
    projectPath: z.string().min(1),
    creatorVersion: z.string().min(1)
  }),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  assets: z.array(AssetRecordSchema),
  scripts: z.array(ScriptAssetRecordSchema),
  documents: z.array(DocumentSnapshotSchema),
  prefabGraph: PrefabGraphSchema,
  coverage: ProjectCoverageSchema,
  unresolved: z.array(UnresolvedItemSchema),
  diagnostics: z.array(DiagnosticSchema)
}).passthrough();

export type DocumentSnapshot = z.infer<typeof DocumentSnapshotSchema>;
export type DocumentComponentSchema = z.infer<typeof DocumentComponentSchemaSchema>;
export type ProjectScanReport = z.infer<typeof ProjectScanReportSchema>;
