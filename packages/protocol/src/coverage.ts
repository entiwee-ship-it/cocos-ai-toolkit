import { z } from 'zod';

function createCoverageCountSchema(resultKey: 'decoded' | 'resolved') {
  return z.object({
    total: z.number().int().nonnegative(),
    [resultKey]: z.number().int().nonnegative()
  }).superRefine((value, context) => {
    if (value[resultKey] > value.total) {
      context.addIssue({
        code: 'custom',
        message: `${resultKey} 不能大于 total`,
        path: [resultKey]
      });
    }
  });
}

export const CoverageSchema = z.object({
  nodes: createCoverageCountSchema('decoded'),
  components: createCoverageCountSchema('decoded'),
  properties: createCoverageCountSchema('decoded'),
  references: createCoverageCountSchema('resolved'),
  prefabInstances: createCoverageCountSchema('resolved'),
  overrides: createCoverageCountSchema('decoded')
});

export type Coverage = z.infer<typeof CoverageSchema>;
