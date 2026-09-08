const workbenchTemplate = `
<main class="workbench-panel">
  <iframe id="workbenchFrame" title="Cocos AI 运行工作台"></iframe>
  <div id="loadingState" class="loading">正在启动运行工作台…</div>
  <pre id="errorState" class="error hidden"></pre>
</main>
`;

const workbenchStyle = `
:host { display: block; height: 100%; }
* { box-sizing: border-box; }
.workbench-panel { position: relative; width: 100%; height: 100%; overflow: hidden; background: #202226; }
iframe { display: block; width: 100%; height: 100%; border: 0; background: #202226; }
.loading, .error { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; padding: 24px; color: #9da6b1; background: #202226; font: 13px/1.5 sans-serif; white-space: pre-wrap; }
.error { color: #ffc1bd; }
.hidden { display: none; }
`;

module.exports = Editor.Panel.define({
  template: workbenchTemplate,
  style: workbenchStyle,
  $: {
    frame: '#workbenchFrame',
    loading: '#loadingState',
    error: '#errorState'
  },
  async ready() {
    try {
      const result = await Editor.Message.request('cocos-ai-bridge', 'workbench-url') as { url?: unknown };
      if (typeof result?.url !== 'string' || !result.url) throw new Error('WORKBENCH_URL_UNAVAILABLE');
      const frame = this.$.frame as HTMLIFrameElement | null;
      if (!frame) throw new Error('WORKBENCH_FRAME_UNAVAILABLE');
      frame.addEventListener('load', () => this.$.loading?.classList.add('hidden'), { once: true });
      frame.src = result.url;
    } catch (error) {
      this.$.loading?.classList.add('hidden');
      const target = this.$.error;
      if (target) {
        target.textContent = error instanceof Error ? error.message : String(error);
        target.classList.remove('hidden');
      }
    }
  },
  async close() {
    await Editor.Message.request('cocos-ai-bridge', 'workbench-close').catch(() => undefined);
  }
});
