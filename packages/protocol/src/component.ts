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
  declaredType: z.string().nullable(),
  valueKind: PropertyValueKindSchema,
  effectiveValue: z.unknown(),
  sourceValue: z.unknown(),
  overrideValue: z.unknown(),
  valueSource: z.string()
}).passthrough();

export const ProbeComponentSchema = z.object({
  kind: z.literal('component'),
  identity: ObjectIdentitySchema,
  className: z.string().nullable(),
  properties: z.array(PropertySchema),
  rawSerializedState: z.unknown()
}).passthrough();

export type ProbeComponent = z.infer<typeof ProbeComponentSchema>;
export type ProbeProperty = z.infer<typeof PropertySchema>;
