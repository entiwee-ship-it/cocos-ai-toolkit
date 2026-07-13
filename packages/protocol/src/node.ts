import { z } from 'zod';
import { ProbeComponentSchema } from './component.js';
import { ObjectIdentitySchema } from './identity.js';
import { PrefabContextSchema } from './prefab.js';

export const ProbeNodeSchema = z.object({
  kind: z.literal('node'),
  identity: ObjectIdentitySchema,
  name: z.string().nullable().optional(),
  path: z.string().nullable().optional(),
  components: z.array(ProbeComponentSchema).optional(),
  prefabContext: PrefabContextSchema.optional()
}).passthrough();

export type ProbeNode = z.infer<typeof ProbeNodeSchema>;
