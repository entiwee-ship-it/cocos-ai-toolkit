import { z } from 'zod';
import { ProbeComponentSchema } from './component.js';
import { ObjectIdentitySchema } from './identity.js';
import { PrefabContextSchema } from './prefab.js';

export const PrefabInstanceSummarySchema = z.object({
  isInstanceRoot: z.boolean(),
  prefabAssetUuid: z.string().nullable(),
  instanceFileId: z.string().nullable(),
  state: z.number().nullable(),
  sourceUrl: z.string().nullable()
});

export const NodeWriteCapabilitiesSchema = z.object({
  assessment: z.enum(['confirmed', 'unknown']),
  documentMode: z.string().nullable(),
  ownerDocumentUuid: z.string().nullable(),
  ownerPrefabUuid: z.string().nullable(),
  ownerSourceUrl: z.string().nullable(),
  sourceFileId: z.string().nullable(),
  isNestedPrefabContent: z.boolean(),
  isInstanceRoot: z.boolean(),
  canRename: z.boolean(),
  canSetTransform: z.boolean(),
  canDelete: z.boolean(),
  canReparent: z.boolean(),
  canDuplicate: z.boolean(),
  canSetActive: z.boolean(),
  canSetLayer: z.boolean(),
  canCreateChild: z.boolean(),
  canAddComponent: z.boolean(),
  canRemoveComponent: z.boolean(),
  canSetComponentProperty: z.boolean(),
  reasonCode: z.string().nullable(),
  nextAction: z.object({
    tool: z.literal('cocos_prefab_open'),
    arguments: z.object({ uuid: z.string().min(1) })
  }).nullable()
});

export const ProbeNodeSchema = z.object({
  kind: z.literal('node'),
  identity: ObjectIdentitySchema,
  name: z.string().nullable().optional(),
  path: z.string().nullable().optional(),
  parentObjectUuid: z.string().nullable().optional(),
  childObjectUuids: z.array(z.string()).optional(),
  siblingIndex: z.number().int().nonnegative().nullable().optional(),
  active: z.boolean().nullable().optional(),
  activeInHierarchy: z.boolean().nullable().optional(),
  layer: z.number().nullable().optional(),
  localTransform: z.unknown().optional(),
  worldTransform: z.unknown().optional(),
  components: z.array(ProbeComponentSchema).optional(),
  prefabContext: PrefabContextSchema.optional(),
  prefabInstance: PrefabInstanceSummarySchema.optional(),
  writeCapabilities: NodeWriteCapabilitiesSchema.optional(),
  raw: z.unknown().optional()
}).passthrough();

export type ProbeNode = z.infer<typeof ProbeNodeSchema>;
