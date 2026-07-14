import type { ProjectScanReport } from '@cocos-ai/protocol';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ScanCheckpoint } from './scan-checkpoint.js';

export interface ScanReportWriter {
  writeCheckpoint(checkpoint: ScanCheckpoint): Promise<string | null>;
  writeReport(report: ProjectScanReport): Promise<string | null>;
}

/**
 * 不写磁盘的报告写入器，供调用方只需要内存结果时使用。
 */
export class NoopScanReportWriter implements ScanReportWriter {
  async writeCheckpoint(_checkpoint: ScanCheckpoint): Promise<string | null> {
    return null;
  }

  async writeReport(_report: ProjectScanReport): Promise<string | null> {
    return null;
  }
}

/**
 * 使用临时文件替换方式写入 JSON 报告和 checkpoint。
 *
 * @param reportPath 最终项目报告路径。
 * @param checkpointPath 最终 checkpoint 路径。
 * @param reportRoot 调用方授权的报告根目录；提供后每次写入前重新验证边界。
 */
export class JsonScanReportWriter implements ScanReportWriter {
  constructor(
    private readonly reportPath: string,
    private readonly checkpointPath: string,
    private readonly reportRoot?: string
  ) {}

  /**
   * 写入最新 checkpoint。
   *
   * @param checkpoint 待保存的扫描进度。
   * @returns 实际写入路径。
   */
  async writeCheckpoint(checkpoint: ScanCheckpoint): Promise<string> {
    await writeJsonAtomically(this.checkpointPath, checkpoint, this.reportRoot);
    return this.checkpointPath;
  }

  /**
   * 写入最终项目报告。
   *
   * @param report 待保存的项目扫描报告。
   * @returns 实际写入路径。
   */
  async writeReport(report: ProjectScanReport): Promise<string> {
    await writeJsonAtomically(this.reportPath, report, this.reportRoot);
    return this.reportPath;
  }
}

/**
 * 使用随机且排他创建的同目录临时文件原子替换 JSON，并在启用授权根时复核真实父目录。
 *
 * @param path 最终报告或 checkpoint 路径。
 * @param value 待序列化的 JSON 数据。
 * @param reportRoot 调用方授权的报告根目录。
 */
async function writeJsonAtomically(
  path: string,
  value: unknown,
  reportRoot?: string
): Promise<void> {
  const targetPath = reportRoot
    ? await resolveAuthorizedTarget(path, reportRoot)
    : path;
  if (!reportRoot) await mkdir(dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx'
    });
    if (reportRoot) {
      const revalidatedTarget = await resolveAuthorizedTarget(path, reportRoot);
      if (!pathsEqual(targetPath, revalidatedTarget)) {
        throw new Error('REPORT_PATH_OUTSIDE_ROOT');
      }
    }
    await rename(temporaryPath, targetPath);
  } finally {
    // 写入或替换失败时清理随机临时文件；成功替换后 force 删除缺失路径也不会报错。
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

/**
 * 重新解析报告父目录并确认它仍位于调用方授权根目录内。
 *
 * @param path 待写入的报告或 checkpoint 路径。
 * @param reportRoot 调用方授权的报告根目录。
 * @returns 使用真实父目录拼接出的目标路径。
 */
async function resolveAuthorizedTarget(path: string, reportRoot: string): Promise<string> {
  const canonicalRoot = await realpath(reportRoot);
  const canonicalParent = await realpath(dirname(path));
  assertWithinRoot(canonicalRoot, canonicalParent);
  return join(canonicalParent, basename(path));
}

/**
 * 校验真实目标目录仍位于授权根内。
 *
 * @param root 已解析真实路径的授权根目录。
 * @param target 已解析真实路径的目标父目录。
 */
function assertWithinRoot(root: string, target: string): void {
  const comparableRoot = normalizeComparablePath(root);
  const comparableTarget = normalizeComparablePath(target);
  const pathFromRoot = relative(comparableRoot, comparableTarget);
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error('REPORT_PATH_OUTSIDE_ROOT');
  }
}

/**
 * 规范化用于路径比较的绝对路径，并兼容 Windows 大小写不敏感语义。
 *
 * @param path 待比较路径。
 * @returns 可稳定比较的绝对路径。
 */
function normalizeComparablePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * 判断两个路径在当前平台上是否指向同一规范化文本路径。
 *
 * @param left 左侧路径。
 * @param right 右侧路径。
 * @returns 两个规范化路径是否相等。
 */
function pathsEqual(left: string, right: string): boolean {
  return normalizeComparablePath(left) === normalizeComparablePath(right);
}
