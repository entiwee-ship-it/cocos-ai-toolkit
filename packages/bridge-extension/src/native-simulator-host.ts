import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface NativeWindowLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface NativeSimulatorHostStatus {
  state: 'idle' | 'starting' | 'ready' | 'error';
  parentProcessId: number;
  childProcessId: number;
  parentWindowHandle: string | null;
  simulatorWindowHandle: string | null;
  error: string | null;
}

/** 把 Creator Simulator 的 HWND 挂到 Workbench 原生窗口，并在退出时恢复。 */
export class NativeSimulatorHost {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<NativeSimulatorHostStatus> | null = null;
  private state: NativeSimulatorHostStatus['state'] = 'idle';
  private childProcessId: number;
  private parentWindowHandle: string | null = null;
  private simulatorWindowHandle: string | null = null;
  private error: string | null = null;
  private stopping = false;

  constructor(private readonly options: {
    parentProcessId: number;
    childProcessId: number;
    parentTitles: string[];
  }) {
    this.childProcessId = options.childProcessId;
  }

  getStatus(): NativeSimulatorHostStatus {
    return {
      state: this.state,
      parentProcessId: this.options.parentProcessId,
      childProcessId: this.childProcessId,
      parentWindowHandle: this.parentWindowHandle,
      simulatorWindowHandle: this.simulatorWindowHandle,
      error: this.error
    };
  }

  async start(layout: NativeWindowLayout): Promise<NativeSimulatorHostStatus> {
    assertLayout(layout);
    if (this.state === 'ready' && this.child) {
      this.update(layout);
      return this.getStatus();
    }
    if (this.starting) return this.starting;

    const executable = resolve(__dirname, 'native', 'simulator-embed-host.exe');
    if (!existsSync(executable)) throw new Error(`NATIVE_SIMULATOR_HOST_MISSING:${executable}`);
    const titles = [...new Set(this.options.parentTitles.map((title) => title.trim()).filter(Boolean))];
    if (titles.length === 0) throw new Error('WORKBENCH_WINDOW_TITLE_REQUIRED');
    const child = spawn(executable, [
      String(this.options.parentProcessId),
      String(this.options.childProcessId),
      Buffer.from(titles.join('\n'), 'utf8').toString('base64'),
      ...layoutArgs(layout)
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child = child;
    this.state = 'starting';
    this.error = null;
    this.stopping = false;
    this.starting = new Promise<NativeSimulatorHostStatus>((resolveStart, rejectStart) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timeout = setTimeout(() => fail(new Error('NATIVE_SIMULATOR_ATTACH_TIMEOUT')), 12_000);
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.state = 'error';
        this.error = [readReason(error), stderr.trim()].filter(Boolean).join(': ');
        child.kill();
        rejectStart(new Error(this.error));
      };
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        let newline = stdout.indexOf('\n');
        while (newline >= 0) {
          const line = stdout.slice(0, newline).trim();
          stdout = stdout.slice(newline + 1);
          if (line.startsWith('READY|') && !settled) {
            const parts = line.split('|');
            const reportedProcessId = Number(parts[3] ?? this.options.childProcessId);
            if (
              (parts.length !== 3 && parts.length !== 4)
              || !Number.isInteger(reportedProcessId)
              || reportedProcessId <= 0
            ) {
              fail(new Error(`INVALID_NATIVE_SIMULATOR_READY:${JSON.stringify(line)}`));
              return;
            }
            settled = true;
            clearTimeout(timeout);
            this.parentWindowHandle = parts[1];
            this.simulatorWindowHandle = parts[2];
            this.childProcessId = reportedProcessId;
            this.state = 'ready';
            resolveStart(this.getStatus());
          }
          newline = stdout.indexOf('\n');
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.once('error', fail);
      child.once('exit', (code) => {
        if (!settled) {
          fail(new Error(`NATIVE_SIMULATOR_HOST_EXITED:${code ?? 'unknown'}`));
          return;
        }
        if (!this.stopping && this.state === 'ready') {
          this.state = 'error';
          this.error = stderr.trim() || `NATIVE_SIMULATOR_HOST_EXITED:${code ?? 'unknown'}`;
        }
        if (this.child === child) this.child = null;
      });
    }).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  update(layout: NativeWindowLayout): void {
    assertLayout(layout);
    if (this.state !== 'ready' || !this.child?.stdin.writable) {
      throw new Error('NATIVE_SIMULATOR_HOST_NOT_READY');
    }
    this.child.stdin.write(`BOUNDS|${layoutArgs(layout).join('|')}\n`);
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.starting = null;
    if (!child || child.exitCode !== null) {
      this.state = 'idle';
      return;
    }
    this.stopping = true;
    await new Promise<void>((resolveStop) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        resolveStop();
      };
      const timeout = setTimeout(() => {
        child.kill();
        finish();
      }, 2_000);
      child.once('exit', finish);
      if (child.stdin.writable) child.stdin.end('DETACH\nEXIT\n');
      else child.kill();
    });
    this.state = 'idle';
    this.parentWindowHandle = null;
    this.simulatorWindowHandle = null;
    this.childProcessId = this.options.childProcessId;
    this.error = null;
    this.stopping = false;
  }
}

function layoutArgs(layout: NativeWindowLayout): string[] {
  return [
    layout.x,
    layout.y,
    layout.width,
    layout.height,
    layout.viewportWidth,
    layout.viewportHeight
  ].map((value) => String(Math.round(value * 1000) / 1000));
}

function assertLayout(layout: NativeWindowLayout): void {
  const values = Object.values(layout);
  if (values.some((value) => !Number.isFinite(value))) throw new Error('INVALID_NATIVE_WINDOW_LAYOUT');
  if (
    layout.x < 0
    || layout.y < 0
    || layout.width < 32
    || layout.height < 32
    || layout.viewportWidth <= 0
    || layout.viewportHeight <= 0
    || layout.x + layout.width > layout.viewportWidth + 2
    || layout.y + layout.height > layout.viewportHeight + 2
  ) throw new Error('INVALID_NATIVE_WINDOW_LAYOUT');
}

function readReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
