import type { ProjectScanReport } from '@cocos-ai/protocol';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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
 */
export class JsonScanReportWriter implements ScanReportWriter {
  constructor(
    private readonly reportPath: string,
    private readonly checkpointPath: string
  ) {}

  /**
   * 写入最新 checkpoint。
   *
   * @param checkpoint 待保存的扫描进度。
   * @returns 实际写入路径。
   */
  async writeCheckpoint(checkpoint: ScanCheckpoint): Promise<string> {
    await writeJsonAtomically(this.checkpointPath, checkpoint);
    return this.checkpointPath;
  }

  /**
   * 写入最终项目报告。
   *
   * @param report 待保存的项目扫描报告。
   * @returns 实际写入路径。
   */
  async writeReport(report: ProjectScanReport): Promise<string> {
    await writeJsonAtomically(this.reportPath, report);
    return this.reportPath;
  }
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, path);
}
