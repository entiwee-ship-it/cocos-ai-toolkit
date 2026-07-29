import { describe, expect, it } from 'vitest';
import { resolveCreatedComponentUuid } from '../src/raw-reflection.js';

describe('resolveCreatedComponentUuid', () => {
  it('把 Creator 自动挂载且前后相同的组件识别为幂等成功', () => {
    const nodeDump = {
      __comps__: [
        {
          value: {
            uuid: {
              value: '8244qKb11F+KltJE2l3nRQ'
            }
          },
          type: 'cc.UITransform',
          readonly: false,
          visible: true,
          cid: 'cc.UITransform'
        }
      ]
    };

    expect(resolveCreatedComponentUuid(
      nodeDump,
      undefined,
      nodeDump,
      'cc.UITransform'
    )).toBe('8244qKb11F+KltJE2l3nRQ');
  });
});
