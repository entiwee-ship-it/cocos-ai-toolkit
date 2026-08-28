import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('./reports.mjs', import.meta.url));

describe('reports governance', () => {
  it('doctor 只读统计，archive/prune 默认 dry-run 且确认后限定 archive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cocos-ai-reports-'));
    try {
      const capture = join(root, 'runtime-captures', 'preview-old');
      await mkdir(capture, { recursive: true });
      await writeFile(join(root, 'phase-old.json'), '{"documentUuid":"doc-1"}');
      await writeFile(join(root, 'debug-old.json'), '{}');
      await mkdir(join(root, 'mcp'), { recursive: true });
      await writeFile(join(root, 'mcp', 'keep.json'), '{}');
      await writeFile(join(capture, 'capture.png'), 'png');
      const old = new Date('2020-01-01T00:00:00.000Z');
      for (const path of [join(root, 'phase-old.json'), join(root, 'debug-old.json'), capture]) {
        await utimes(path, old, old);
      }

      const doctor = run('doctor', '--root', root, '--older-than-days', '30', '--document-uuid', 'doc-1');
      expect(doctor).toMatchObject({
        command: 'doctor',
        currentDocumentUuid: 'doc-1',
        totals: { files: 4 }
      });
      expect(doctor.categories).toEqual(expect.arrayContaining([
        expect.objectContaining({ category: 'phase', referencedFiles: 1 }),
        expect.objectContaining({ category: 'mcp', staleFiles: 0 })
      ]));

      const dryArchive = run('archive', '--root', root, '--older-than-days', '30');
      expect(dryArchive).toMatchObject({ dryRun: true, moved: 0 });
      await expect(stat(join(root, 'phase-old.json'))).resolves.toBeDefined();

      const archived = run('archive', '--root', root, '--older-than-days', '30', '--confirm');
      expect(archived.moved).toBe(3);
      await expect(stat(join(root, 'phase-old.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(join(root, 'mcp', 'keep.json'))).resolves.toBeDefined();

      const dryPrune = run('prune', '--root', root, '--older-than-days', '0');
      expect(dryPrune.removed).toBe(0);
      const pruned = run('prune', '--root', root, '--older-than-days', '0', '--confirm');
      expect(pruned.removed).toBeGreaterThanOrEqual(1);
      await expect(readFile(join(root, 'mcp', 'keep.json'), 'utf8')).resolves.toBe('{}');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function run(...args: string[]): any {
  return JSON.parse(execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' }));
}
