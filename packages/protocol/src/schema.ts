import { z } from 'zod';
import { PropertyValueKindSchema } from './component.js';
import { ReferenceSchema } from './reference.js';

export const UnresolvedItemSchema = z.object({
  path: z.string(),
  reason: z.string(),
  code: z.string().optional(),
  scope: z.string().optional(),
  severity: z.enum(['info', 'warning', 'error']).optional(),
  source: z.string().optional(),
  details: z.unknown().optional()
});

export type UnresolvedItem = z.infer<typeof UnresolvedItemSchema>;

const RequiredCurrentValueSchema = z.custom<unknown>(
  (value) => value !== undefined,
  { message: 'currentValue 必须显式存在' }
);

export const InspectorMetadataSchema = z.object({
  tooltip: z.string().nullable().optional(),
  range: z.unknown().optional(),
  step: z.number().nullable().optional(),
  slide: z.boolean().nullable().optional(),
  formerlySerializedAs: z.union([z.string(), z.array(z.string())]).nullable().optional()
}).passthrough();

export const ComponentPropertyDescriptorSchema = z.object({
  propertyPath: z.string().min(1),
  serializedName: z.string().min(1),
  displayName: z.string().nullable(),
  declaredType: z.string().nullable(),
  actualType: z.string().nullable(),
  valueKind: PropertyValueKindSchema,
  nullable: z.boolean(),
  serializable: z.boolean(),
  visible: z.boolean().nullable(),
  readonly: z.boolean().nullable(),
  defaultValue: z.unknown(),
  currentValue: RequiredCurrentValueSchema,
  references: z.array(ReferenceSchema),
  inspectorMetadata: InspectorMetadataSchema,
  rawClassAttributes: z.record(z.string(), z.unknown()),
  rawConsumedKeys: z.array(z.string())
}).passthrough();

export const ComponentTypeSchemaSchema = z.object({
  componentUuid: z.string().min(1).optional(),
  nodeUuid: z.string().min(1).optional(),
  nodePath: z.string().nullable().optional(),
  componentIndex: z.number().int().nonnegative().optional(),
  className: z.string().nullable(),
  qualifiedName: z.string().nullable(),
  typeId: z.string().nullable(),
  scriptUuid: z.string().nullable(),
  scriptPath: z.string().nullable(),
  inheritance: z.array(z.string()),
  executionOrder: z.number().nullable(),
  properties: z.array(ComponentPropertyDescriptorSchema),
  rawClassAttributes: z.record(z.string(), z.unknown()),
  unresolved: z.array(UnresolvedItemSchema)
}).passthrough();

export type InspectorMetadata = z.infer<typeof InspectorMetadataSchema>;
export type ComponentPropertyDescriptor = z.infer<typeof ComponentPropertyDescriptorSchema>;
export type ComponentTypeSchema = z.infer<typeof ComponentTypeSchemaSchema>;
