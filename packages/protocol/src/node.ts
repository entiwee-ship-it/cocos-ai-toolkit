import { z } from 'zod';
import { ProbeComponentSchema } from './component.js';
import { ObjectIdentitySchema } from './identity.js';
import { PrefabContextSchema } from './prefab.js';

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
  raw: z.unknown().optional()
}).passthrough();

export type ProbeNode = z.infer<typeof ProbeNodeSchema>;
