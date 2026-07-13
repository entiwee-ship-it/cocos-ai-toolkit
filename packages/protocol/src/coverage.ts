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

export const ProjectCoverageSchema = CoverageSchema.extend({
  assets: createCoverageCountSchema('decoded'),
  scripts: createCoverageCountSchema('decoded'),
  documents: createCoverageCountSchema('decoded')
});

export type Coverage = z.infer<typeof CoverageSchema>;
export type ProjectCoverage = z.infer<typeof ProjectCoverageSchema>;

/**
 * 创建项目扫描使用的零值覆盖率，并允许测试或聚合器覆盖指定分类。
 *
 * @param overrides 需要替换的覆盖率分类。
 * @returns 包含全部项目扫描分类的覆盖率对象。
 */
export function createEmptyProjectCoverage(
  overrides: Partial<ProjectCoverage> = {}
): ProjectCoverage {
  return {
    nodes: { total: 0, decoded: 0 },
    components: { total: 0, decoded: 0 },
    properties: { total: 0, decoded: 0 },
    references: { total: 0, resolved: 0 },
    prefabInstances: { total: 0, resolved: 0 },
    overrides: { total: 0, decoded: 0 },
    assets: { total: 0, decoded: 0 },
    scripts: { total: 0, decoded: 0 },
    documents: { total: 0, decoded: 0 },
    ...overrides
  };
}
