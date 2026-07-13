import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export class ArtifactStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /**
   * 将探针结果保存为报告根目录下的 JSON 文件。
   *
   * @param filename 相对报告文件名，不允许绝对路径或父目录跳转。
   * @param data 可 JSON 序列化的探针结果。
   * @returns 已写入文件的绝对路径。
   */
  async save(filename: string, data: unknown): Promise<string> {
    if (isAbsolute(filename) || !filename.endsWith('.json')) {
      throw new Error('INVALID_ARTIFACT_PATH');
    }

    const target = resolve(this.root, filename);
    const relativePath = relative(this.root, target);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new Error('INVALID_ARTIFACT_PATH');
    }

    await mkdir(this.root, { recursive: true });
    await writeFile(target, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    return target;
  }
}
