import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseVersion = '0.6.2';
const workspacePackagePaths = [
  'packages/bridge-extension',
  'packages/cli',
  'packages/client',
  'packages/core',
  'packages/mcp-server',
  'packages/probe-server',
  'packages/protocol'
];

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(repositoryRoot, path), 'utf8')) as Record<string, unknown>;
}

function readGit(...args: string[]): string {
  return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim();
}

describe('发布版本一致性', () => {
  it('根包、所有 workspace、锁文件和内部依赖统一为本次版本', async () => {
    const rootPackage = await readJson('package.json');
    expect(rootPackage.version).toBe(releaseVersion);

    const packageLock = await readJson('package-lock.json') as {
      version?: string;
      packages?: Record<string, { version?: string; dependencies?: Record<string, string> }>;
    };
    expect(packageLock.version).toBe(releaseVersion);
    expect(packageLock.packages?.['']?.version).toBe(releaseVersion);

    for (const workspacePath of workspacePackagePaths) {
      const manifest = await readJson(`${workspacePath}/package.json`) as {
        version?: string;
        dependencies?: Record<string, string>;
      };
      expect(manifest.version, workspacePath).toBe(releaseVersion);
      expect(packageLock.packages?.[workspacePath]?.version, `${workspacePath} lock`).toBe(releaseVersion);
      for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
        if (dependency.startsWith('@cocos-ai/')) {
          expect(version, `${workspacePath} -> ${dependency}`).toBe(releaseVersion);
        }
      }
    }

    const bridgeManifest = await readJson('packages/bridge-extension/package.json') as {
      devDependencies?: Record<string, string>;
    };
    expect(bridgeManifest.devDependencies?.['@cocos/creator-types']).toBe('3.8.8');
    expect(packageLock.packages?.['node_modules/@cocos/creator-types']?.version).toBe('3.8.8');
  });

  it('Bridge、MCP 与健康检查握手都声明同一版本', async () => {
    const bridgeSource = await readFile(
      resolve(repositoryRoot, 'packages/bridge-extension/src/main.ts'),
      'utf8'
    );
    const serverSource = await readFile(
      resolve(repositoryRoot, 'packages/mcp-server/src/server.ts'),
      'utf8'
    );
    const healthCheck = await readFile(
      resolve(repositoryRoot, 'scripts/check-codex-mcp.mjs'),
      'utf8'
    );

    expect(bridgeSource).toContain(`const BRIDGE_VERSION = '${releaseVersion}'`);
    expect(serverSource).toContain(`version: '${releaseVersion}'`);
    expect(healthCheck).toContain(`const TOOLKIT_VERSION = '${releaseVersion}'`);
    expect(healthCheck).toContain('serverVersion: client.getServerVersion()');
    expect(healthCheck).toContain('sourceCommit');
    expect(healthCheck).toContain('toolkitVersion: TOOLKIT_VERSION');
  });

  it('待提交或待推送状态相对 origin/master 必须已经升版', async () => {
    const head = readGit('rev-parse', 'HEAD');
    const originHead = readGit('rev-parse', 'origin/master');
    const packageDirty = readGit('status', '--short', '--', 'package.json') !== '';
    if (head === originHead && !packageDirty) return;

    const originPackage = JSON.parse(
      readGit('show', 'origin/master:package.json')
    ) as { version?: string };
    const rootPackage = await readJson('package.json');
    expect(rootPackage.version).not.toBe(originPackage.version);
  });
});
