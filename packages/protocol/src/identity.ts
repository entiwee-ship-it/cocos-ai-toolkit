import { z } from 'zod';

export const ObjectIdentitySchema = z.object({
  sessionId: z.string().nullable(),
  objectUuid: z.string().nullable(),
  assetUuid: z.string().nullable(),
  fileId: z.string().nullable(),
  typeId: z.string().nullable(),
  scriptUuid: z.string().nullable()
});

export type ObjectIdentity = z.infer<typeof ObjectIdentitySchema>;
