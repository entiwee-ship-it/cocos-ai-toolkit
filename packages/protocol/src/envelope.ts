import { z } from 'zod';
import { CoverageSchema } from './coverage.js';
import { ObjectIdentitySchema } from './identity.js';
import { PrefabContextSchema } from './prefab.js';

export const PROTOCOL_VERSION = '0.5.0';

export const UnresolvedItemSchema = z.object({
  path: z.string(),
  reason: z.string(),
  code: z.string().optional(),
  scope: z.string().optional(),
  severity: z.enum(['info', 'warning', 'error']).optional(),
  source: z.string().optional(),
  details: z.unknown().optional()
});

export const DiagnosticSchema = z.object({
  code: z.string(),
  message: z.string(),
  severity: z.enum(['info', 'warning', 'error']).optional(),
  details: z.unknown().optional()
});

const ProbeDataSchema = z.object({
  kind: z.string(),
  identity: ObjectIdentitySchema,
  prefabContext: PrefabContextSchema.optional()
}).passthrough();

export const ProbeResponseSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  creatorVersion: z.string(),
  editorInstanceId: z.string(),
  projectId: z.string(),
  requestId: z.string(),
  ok: z.boolean(),
  data: ProbeDataSchema,
  coverage: CoverageSchema,
  unresolved: z.array(UnresolvedItemSchema),
  diagnostics: z.array(DiagnosticSchema)
});

export type ProbeResponse = z.infer<typeof ProbeResponseSchema>;
export type UnresolvedItem = z.infer<typeof UnresolvedItemSchema>;
export type Diagnostic = z.infer<typeof DiagnosticSchema>;
