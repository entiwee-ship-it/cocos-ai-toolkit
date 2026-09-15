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
  embeddedWindowHandle: string | null;
  error: string | null;
}

export type NativeSimulatorInput =
  | { type: 'pointerdown' | 'pointermove' | 'pointerup'; x: number; y: number; button: number; buttons: number }
  | { type: 'wheel'; x: number; y: number; delta: number; buttons: number }
  | { type: 'keydown' | 'keyup'; key: string; code: string; keyCode: number };

export interface NativeSimulatorHighlight {
  viewport: { width: number; height: number };
  points: Array<{ x: number; y: number }>;
  anchor: { x: number; y: number };
}

/** 用原生子窗口承载 Simulator 实时帧，并在退出时恢复源窗口。 */
export class NativeSimulatorHost {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<NativeSimulatorHostStatus> | null = null;
  private state: NativeSimulatorHostStatus['state'] = 'idle';
  private childProcessId: number;
  private parentWindowHandle: string | null = null;
  private simulatorWindowHandle: string | null = null;
  private embeddedWindowHandle: string | null = null;
  private error: string | null = null;
  private stopping = false;

  constructor(private readonly options: {
    parentProcessId: number;
    childProcessId: number;
    parentTitles: string[];
    onInput?: (input: NativeSimulatorInput) => void;
  }) {
    this.childProcessId = options.childProcessId;
  }

  getStatus(): NativeSimulatorHostStatus {
    return { state: this.state, parentProcessId: this.options.parentProcessId, childProcessId: this.childProcessId,
      parentWindowHandle: this.parentWindowHandle, simulatorWindowHandle: this.simulatorWindowHandle,
      embeddedWindowHandle: this.embeddedWindowHandle, error: this.error };
  }

  async start(layout: NativeWindowLayout): Promise<NativeSimulatorHostStatus> {
    assertLayout(layout);
    if (this.state === 'ready' && this.child) { this.update(layout); return this.getStatus(); }
    if (this.starting) return this.starting;
    const executable = resolve(__dirname, 'native', 'simulator-embed-host.exe');
    if (!existsSync(executable)) throw new Error(`NATIVE_SIMULATOR_HOST_MISSING:${executable}`);
    const titles = [...new Set(this.options.parentTitles.map((title) => title.trim()).filter(Boolean))];
    if (!titles.length) throw new Error('WORKBENCH_WINDOW_TITLE_REQUIRED');
    const child = spawn(executable, [
      String(this.options.parentProcessId),
      String(this.options.childProcessId),
      titles.join('\n'),
      ...layoutValues(layout).map(String)
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
            const processId = Number(parts[3]);
            if (parts.length !== 5 || !Number.isInteger(processId) || processId <= 0) {
              fail(new Error(`INVALID_NATIVE_SIMULATOR_READY:${JSON.stringify(line)}`));
              return;
            }
            settled = true;
            clearTimeout(timeout);
            this.parentWindowHandle = parts[1];
            this.simulatorWindowHandle = parts[2];
            this.childProcessId = processId;
            this.embeddedWindowHandle = parts[4];
            this.state = 'ready';
            resolveStart(this.getStatus());
          } else if (line.startsWith('INPUT|')) {
            const input = parseNativeSimulatorInput(line);
            if (input) this.options.onInput?.(input);
          }
          newline = stdout.indexOf('\n');
        }
      });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.once('error', fail);
      child.once('exit', (code) => {
        if (!settled) { fail(new Error(`NATIVE_SIMULATOR_HOST_EXITED:${code ?? 'unknown'}`)); return; }
        if (!this.stopping && this.state === 'ready') {
          this.state = 'error';
          this.error = stderr.trim() || `NATIVE_SIMULATOR_HOST_EXITED:${code ?? 'unknown'}`;
        }
        if (this.child === child) this.child = null;
      });
    }).finally(() => { this.starting = null; });
    return this.starting;
  }

  update(layout: NativeWindowLayout): void {
    assertLayout(layout);
    if (this.state !== 'ready' || !this.child?.stdin.writable) throw new Error('NATIVE_SIMULATOR_HOST_NOT_READY');
    this.child.stdin.write(`BOUNDS|${layoutValues(layout).join('|')}\n`);
  }

  setHighlight(value: NativeSimulatorHighlight | null): void {
    if (this.state !== 'ready') throw new Error('NATIVE_SIMULATOR_HOST_NOT_READY');
    if (value) assertHighlight(value);
    if (!this.child?.stdin.writable) throw new Error('NATIVE_SIMULATOR_HOST_NOT_READY');
    this.child.stdin.write(value ? `HIGHLIGHT|${highlightValues(value).join('|')}\n` : 'HIGHLIGHT|CLEAR\n');
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.starting = null;
    if (child && child.exitCode === null) {
      this.stopping = true;
      await new Promise<void>((resolveStop) => {
        let done = false;
        const finish = (): void => { if (done) return; done = true; clearTimeout(timeout); resolveStop(); };
        const timeout = setTimeout(() => { child.kill(); finish(); }, 2_000);
        child.once('exit', finish);
        if (child.stdin.writable) child.stdin.end('DETACH\n');
        else child.kill();
      });
    }
    this.state = 'idle'; this.parentWindowHandle = null; this.simulatorWindowHandle = null;
    this.embeddedWindowHandle = null; this.childProcessId = this.options.childProcessId; this.error = null;
    this.stopping = false;
  }
}

export function parseNativeSimulatorInput(line: string): NativeSimulatorInput | null {
  if (!line.startsWith('INPUT|')) return null;
  const parts = line.split('|');
  if (parts.length !== 8) throw new Error('INVALID_NATIVE_SIMULATOR_INPUT');
  const type = parts[1];
  const values = parts.slice(2).map(Number);
  if (values.some((value) => !Number.isInteger(value))) throw new Error('INVALID_NATIVE_SIMULATOR_INPUT');
  const [x, y, button, buttons, delta, keyCode] = values;
  if (type === 'keydown' || type === 'keyup') {
    const key = describeVirtualKey(keyCode);
    if (!key) throw new Error('INVALID_NATIVE_SIMULATOR_KEY');
    return { type, ...key, keyCode };
  }
  if (x < 0 || y < 0 || buttons < 0 || buttons > 7) throw new Error('INVALID_NATIVE_SIMULATOR_POINTER');
  if (type === 'wheel') return { type, x, y, buttons, delta };
  if ((type === 'pointerdown' || type === 'pointermove' || type === 'pointerup') && button >= 0 && button <= 2) {
    return { type, x, y, button, buttons };
  }
  throw new Error('INVALID_NATIVE_SIMULATOR_INPUT');
}

function describeVirtualKey(keyCode: number): { key: string; code: string } | null {
  if (keyCode >= 65 && keyCode <= 90) {
    const letter = String.fromCharCode(keyCode);
    return { key: letter.toLowerCase(), code: `Key${letter}` };
  }
  if (keyCode >= 48 && keyCode <= 57) {
    const digit = String.fromCharCode(keyCode);
    return { key: digit, code: `Digit${digit}` };
  }
  if (keyCode >= 112 && keyCode <= 123) {
    const key = `F${keyCode - 111}`;
    return { key, code: key };
  }
  const names: Record<number, { key: string; code: string }> = {
    8: { key: 'Backspace', code: 'Backspace' },
    9: { key: 'Tab', code: 'Tab' },
    13: { key: 'Enter', code: 'Enter' },
    16: { key: 'Shift', code: 'ShiftLeft' },
    17: { key: 'Control', code: 'ControlLeft' },
    18: { key: 'Alt', code: 'AltLeft' },
    27: { key: 'Escape', code: 'Escape' },
    32: { key: ' ', code: 'Space' },
    33: { key: 'PageUp', code: 'PageUp' },
    34: { key: 'PageDown', code: 'PageDown' },
    35: { key: 'End', code: 'End' },
    36: { key: 'Home', code: 'Home' },
    37: { key: 'ArrowLeft', code: 'ArrowLeft' },
    38: { key: 'ArrowUp', code: 'ArrowUp' },
    39: { key: 'ArrowRight', code: 'ArrowRight' },
    40: { key: 'ArrowDown', code: 'ArrowDown' },
    45: { key: 'Insert', code: 'Insert' },
    46: { key: 'Delete', code: 'Delete' }
  };
  return names[keyCode] ?? null;
}

function highlightValues(value: NativeSimulatorHighlight): number[] {
  return [value.viewport.width, value.viewport.height,
    ...value.points.flatMap((point) => [point.x, point.y]), value.anchor.x, value.anchor.y];
}

function layoutValues(layout: NativeWindowLayout): [number, number, number, number, number, number] {
  return [layout.x, layout.y, layout.width, layout.height, layout.viewportWidth, layout.viewportHeight];
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

function assertHighlight(value: NativeSimulatorHighlight): void {
  if (
    !Number.isFinite(value.viewport.width)
    || !Number.isFinite(value.viewport.height)
    || value.viewport.width <= 0
    || value.viewport.height <= 0
    || value.points.length !== 4
    || value.points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))
    || !Number.isFinite(value.anchor.x)
    || !Number.isFinite(value.anchor.y)
  ) throw new Error('INVALID_NATIVE_SIMULATOR_HIGHLIGHT');
}

function readReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
