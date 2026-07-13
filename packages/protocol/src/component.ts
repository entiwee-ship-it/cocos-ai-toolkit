import { z } from 'zod';
import { ObjectIdentitySchema } from './identity.js';

export const PropertyValueKindSchema = z.enum([
  'null',
  'boolean',
  'number',
  'string',
  'enum',
  'vector',
  'color',
  'size',
  'rect',
  'object',
  'array',
  'node-reference',
  'component-reference',
  'asset-reference',
  'managed-reference',
  'unknown-serialized'
]);

export const PropertySchema = z.object({
  propertyPath: z.string(),
  serializedName: z.string().optional(),
  displayName: z.string().nullable().optional(),
  declaredType: z.string().nullable(),
  actualType: z.string().nullable().optional(),
  valueKind: PropertyValueKindSchema,
  nullable: z.boolean().optional(),
  serializable: z.boolean().optional(),
  visible: z.boolean().nullable().optional(),
  readonly: z.boolean().nullable().optional(),
  defaultValue: z.unknown().optional(),
  effectiveValue: z.unknown(),
  sourceValue: z.unknown(),
  overrideValue: z.unknown(),
  valueSource: z.string(),
  inspectorMetadata: z.record(z.string(), z.unknown()).optional(),
  raw: z.unknown().optional()
}).passthrough();

export const ProbeComponentSchema = z.object({
  kind: z.literal('component'),
  identity: ObjectIdentitySchema,
  className: z.string().nullable(),
  qualifiedName: z.string().nullable().optional(),
  scriptPath: z.string().nullable().optional(),
  inheritance: z.array(z.string()).optional(),
  properties: z.array(PropertySchema),
  rawSerializedState: z.unknown()
}).passthrough();

export type ProbeComponent = z.infer<typeof ProbeComponentSchema>;
export type ProbeProperty = z.infer<typeof PropertySchema>;
