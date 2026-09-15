import { describe, expect, it } from 'vitest';
import { parseNativeSimulatorInput } from '../src/native-simulator-host.js';

describe('NativeSimulatorHost 输入协议', () => {
  it('解析指针、滚轮和常用键盘输入', () => {
    expect(parseNativeSimulatorInput('INPUT|pointerdown|426|196|0|1|0|0')).toEqual({
      type: 'pointerdown', x: 426, y: 196, button: 0, buttons: 1
    });
    expect(parseNativeSimulatorInput('INPUT|wheel|426|196|0|0|120|0')).toEqual({
      type: 'wheel', x: 426, y: 196, buttons: 0, delta: 120
    });
    expect(parseNativeSimulatorInput('INPUT|keydown|0|0|0|0|0|65')).toEqual({
      type: 'keydown', key: 'a', code: 'KeyA', keyCode: 65
    });
    expect(parseNativeSimulatorInput('INPUT|keyup|0|0|0|0|0|13')).toEqual({
      type: 'keyup', key: 'Enter', code: 'Enter', keyCode: 13
    });
  });

  it('拒绝损坏或未知的原生输入', () => {
    expect(parseNativeSimulatorInput('READY|1|2|3|4')).toBeNull();
    expect(() => parseNativeSimulatorInput('INPUT|pointerdown|-1|2|0|1|0|0')).toThrow('INVALID_NATIVE_SIMULATOR_POINTER');
    expect(() => parseNativeSimulatorInput('INPUT|keydown|0|0|0|0|0|255')).toThrow('INVALID_NATIVE_SIMULATOR_KEY');
  });
});
