import { z } from 'zod';
import { AssetRecordSchema, DocumentAssetRecordSchema, ScriptAssetRecordSchema } from './asset.js';
import { CoverageSchema, ProjectCoverageSchema } from './coverage.js';
import { DiagnosticSchema, UnresolvedItemSchema } from './envelope.js';
import { ProbeNodeSchema } from './node.js';
import { PrefabGraphSchema, PrefabProbeSchema } from './prefab.js';
import { ComponentTypeSchemaSchema } from './schema.js';

export const DocumentSnapshotSchema = z.object({
  document: DocumentAssetRecordSchema,
  revision: z.unknown().nullable(),
  nodes: z.array(ProbeNodeSchema),
  componentSchemas: z.array(ComponentTypeSchemaSchema),
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
export type ProjectScanReport = z.infer<typeof ProjectScanReportSchema>;
