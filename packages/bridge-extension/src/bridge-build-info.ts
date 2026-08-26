import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 读取构建阶段生成并随 dist 发布的 Bridge 内容指纹。 */
export function readBridgeBuildId(distDirectory: string): string {
  try {
    const value = JSON.parse(readFileSync(join(distDirectory, 'build-info.json'), 'utf8')) as { buildId?: unknown };
    return typeof value.buildId === 'string' && value.buildId ? value.buildId : 'missing';
  } catch {
    return 'missing';
  }
}
