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
  componentFileId: z.string().nullable(),
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

export const ProjectScanArtifactReferenceSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
  encoding: z.enum(['json', 'json-gzip'])
}).strict();

export const ProjectScanAssetIndexArtifactSchema = z.object({
  formatVersion: z.literal(1),
  scanId: z.string().min(1),
  assets: z.array(AssetRecordSchema),
  scripts: z.array(ScriptAssetRecordSchema)
}).strict();

export const ProjectScanReportManifestSchema = z.object({
  formatVersion: z.literal(2),
  scanId: z.string().min(1),
  status: z.enum(['completed', 'completed-with-gaps', 'failed']),
  project: z.object({
    projectId: z.string().min(1),
    projectPath: z.string().min(1),
    creatorVersion: z.string().min(1)
  }).strict(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  scanParameters: z.object({
    pageSize: z.number().int().min(1).max(500),
    includeRaw: z.boolean(),
    concurrency: z.number().int().min(1).max(4)
  }).strict(),
  summary: z.object({
    assets: z.number().int().nonnegative(),
    scripts: z.number().int().nonnegative(),
    documents: z.number().int().nonnegative(),
    completedDocuments: z.number().int().nonnegative(),
    failedDocuments: z.number().int().nonnegative(),
    prefabGraphNodes: z.number().int().nonnegative(),
    prefabGraphEdges: z.number().int().nonnegative(),
    prefabGraphBlocked: z.boolean(),
    unresolved: z.number().int().nonnegative(),
    diagnostics: z.number().int().nonnegative()
  }).strict(),
  coverage: ProjectCoverageSchema,
  artifacts: z.object({
    checkpoint: ProjectScanArtifactReferenceSchema,
    assetIndex: ProjectScanArtifactReferenceSchema,
    documentSnapshots: z.object({
      count: z.number().int().nonnegative(),
      gzipCount: z.number().int().nonnegative(),
      jsonCount: z.number().int().nonnegative()
    }).strict().superRefine((snapshots, context) => {
      if (snapshots.gzipCount + snapshots.jsonCount !== snapshots.count) {
        context.addIssue({
          code: 'custom',
          message: '文档快照编码计数必须等于快照总数'
        });
      }
    })
  }).strict()
}).strict();

export const ProjectScanReportFileSchema = z.union([
  ProjectScanReportManifestSchema,
  ProjectScanReportSchema
]);

export type DocumentSnapshot = z.infer<typeof DocumentSnapshotSchema>;
export type DocumentComponentSchema = z.infer<typeof DocumentComponentSchemaSchema>;
export type ProjectScanReport = z.infer<typeof ProjectScanReportSchema>;
export type ProjectScanArtifactReference = z.infer<typeof ProjectScanArtifactReferenceSchema>;
export type ProjectScanAssetIndexArtifact = z.infer<typeof ProjectScanAssetIndexArtifactSchema>;
export type ProjectScanReportManifest = z.infer<typeof ProjectScanReportManifestSchema>;
export type ProjectScanReportFile = z.infer<typeof ProjectScanReportFileSchema>;
