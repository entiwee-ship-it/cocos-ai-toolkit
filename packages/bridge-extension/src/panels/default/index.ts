type RecordValue = Record<string, unknown>;

const template = `
  <main class="manager">
    <header class="hero">
      <div>
        <div class="eyebrow">COCOS AI TOOLKIT</div>
        <h1>Cocos AI 工具管理</h1>
        <p>Creator 本机直连、编辑器状态与 Preview 状态</p>
      </div>
      <span id="connectionBadge" class="badge neutral">读取中</span>
    </header>

    <section class="actions">
      <button id="refreshButton" type="button">刷新状态</button>
      <button id="extensionButton" type="button" class="secondary">打开扩展管理器</button>
      <span id="updatedAt" class="updated">尚未更新</span>
    </section>

    <section class="grid">
      <article class="card">
        <h2>扩展</h2>
        <dl>
          <div><dt>版本</dt><dd id="version">—</dd></div>
          <div><dt>发布日期</dt><dd id="releaseDate">—</dd></div>
          <div><dt>作者</dt><dd id="author">—</dd></div>
          <div><dt>构建指纹</dt><dd id="buildId" class="mono">—</dd></div>
        </dl>
      </article>

      <article class="card">
        <h2>Creator 直连</h2>
        <dl>
          <div><dt>传输方式</dt><dd>Windows Named Pipe</dd></div>
          <div><dt>状态</dt><dd id="ipcState">—</dd></div>
          <div><dt>认证</dt><dd id="authentication">—</dd></div>
          <div><dt>活动请求</dt><dd id="activeRequests">—</dd></div>
          <div><dt>累计请求</dt><dd id="totalRequests">—</dd></div>
          <div><dt>管道</dt><dd id="pipeName" class="mono selectable">—</dd></div>
        </dl>
      </article>

      <article class="card wide">
        <h2>当前项目</h2>
        <dl>
          <div><dt>项目 ID</dt><dd id="projectId" class="mono selectable">—</dd></div>
          <div><dt>项目路径</dt><dd id="projectPath" class="mono selectable">—</dd></div>
          <div><dt>Creator</dt><dd id="creatorVersion">—</dd></div>
          <div><dt>Scene</dt><dd id="sceneReady">—</dd></div>
          <div><dt>AssetDB</dt><dd id="assetReady">—</dd></div>
          <div><dt>当前文档</dt><dd id="documentId" class="mono selectable">—</dd></div>
          <div><dt>未保存</dt><dd id="documentDirty">—</dd></div>
          <div><dt>Preview</dt><dd id="previewState">—</dd></div>
        </dl>
      </article>
    </section>

    <section id="errorBox" class="error hidden" role="alert"></section>
  </main>
`;

const style = `
  :host { display: block; height: 100%; overflow: auto; color: var(--color-normal-contrast-weakest, #d8d8d8); }
  * { box-sizing: border-box; }
  .manager { min-height: 100%; padding: 22px; background: #202226; font: 13px/1.5 Arial, sans-serif; }
  .hero { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
  .eyebrow { color: #69a7ff; font-size: 11px; font-weight: 700; letter-spacing: .14em; }
  h1 { margin: 4px 0 2px; color: #f4f6f8; font-size: 22px; font-weight: 650; }
  h2 { margin: 0 0 12px; color: #f0f2f5; font-size: 14px; font-weight: 650; }
  p { margin: 0; color: #8f98a5; }
  .badge { flex: none; padding: 5px 9px; border: 1px solid transparent; border-radius: 999px; font-size: 12px; }
  .badge.ready { color: #9be7b1; background: #153b25; border-color: #28623d; }
  .badge.error { color: #ffb0ad; background: #481d1d; border-color: #773333; }
  .badge.neutral { color: #c5cbd3; background: #30343a; border-color: #454b53; }
  .actions { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
  button { min-height: 30px; padding: 0 12px; color: #fff; background: #3478c9; border: 1px solid #4b8bd5; border-radius: 4px; cursor: pointer; }
  button:hover { background: #3f86da; }
  button:disabled { cursor: wait; opacity: .55; }
  button.secondary { color: #d9dde3; background: #34383f; border-color: #4a5059; }
  .updated { margin-left: auto; color: #777f8a; font-size: 12px; }
  .grid { display: grid; grid-template-columns: minmax(240px, 1fr) minmax(280px, 1.25fr); gap: 12px; }
  .card { padding: 15px; background: #292c31; border: 1px solid #393d44; border-radius: 7px; }
  .card.wide { grid-column: 1 / -1; }
  dl { margin: 0; }
  dl > div { display: grid; grid-template-columns: 86px minmax(0, 1fr); gap: 10px; padding: 6px 0; border-top: 1px solid #34383e; }
  dl > div:first-child { border-top: 0; }
  dt { color: #89919c; }
  dd { min-width: 0; margin: 0; color: #e1e5ea; overflow-wrap: anywhere; }
  .mono { font: 12px/1.55 Consolas, monospace; color: #b8c9df; }
  .selectable { user-select: text; }
  .error { margin-top: 12px; padding: 10px 12px; color: #ffc1bd; background: #401d1d; border: 1px solid #6f3333; border-radius: 5px; white-space: pre-wrap; }
  .hidden { display: none; }
  @media (max-width: 620px) { .grid { grid-template-columns: 1fr; } .card.wide { grid-column: auto; } }
`;

module.exports = Editor.Panel.define({
  template,
  style,
  $: {
    refreshButton: '#refreshButton',
    extensionButton: '#extensionButton',
    connectionBadge: '#connectionBadge',
    updatedAt: '#updatedAt',
    version: '#version',
    releaseDate: '#releaseDate',
    author: '#author',
    buildId: '#buildId',
    ipcState: '#ipcState',
    authentication: '#authentication',
    activeRequests: '#activeRequests',
    totalRequests: '#totalRequests',
    pipeName: '#pipeName',
    projectId: '#projectId',
    projectPath: '#projectPath',
    creatorVersion: '#creatorVersion',
    sceneReady: '#sceneReady',
    assetReady: '#assetReady',
    documentId: '#documentId',
    documentDirty: '#documentDirty',
    previewState: '#previewState',
    errorBox: '#errorBox'
  },
  methods: {
    setText(id: string, value: unknown): void {
      const element = (this.$ as Record<string, HTMLElement | null>)[id];
      if (element) element.textContent = display(value);
    },
    async refresh(): Promise<void> {
      const button = this.$.refreshButton as HTMLButtonElement | null;
      if (button) button.disabled = true;
      this.$.errorBox?.classList.add('hidden');
      try {
        const state = await Editor.Message.request('cocos-ai-bridge', 'manager-state') as RecordValue;
        const extension = record(state.extension);
        const ipc = record(state.ipc);
        const editor = record(state.editor);
        const ready = record(editor.ready);
        const document = record(editor.document);
        const preview = record(editor.preview);
        this.setText('version', extension.version);
        this.setText('releaseDate', extension.releaseDate);
        this.setText('author', extension.author);
        this.setText('buildId', extension.buildId);
        this.setText('ipcState', ipc.state);
        this.setText('authentication', ipc.authentication === 'enabled' ? '会话令牌' : '本机用户');
        this.setText('activeRequests', ipc.activeRequests);
        this.setText('totalRequests', ipc.totalRequests);
        this.setText('pipeName', ipc.pipeName);
        this.setText('projectId', editor.projectId);
        this.setText('projectPath', editor.projectPath);
        this.setText('creatorVersion', editor.creatorVersion);
        this.setText('sceneReady', ready.scene === true ? '已就绪' : '未就绪');
        this.setText('assetReady', ready.assetDatabase === true ? '已就绪' : '未就绪');
        this.setText('documentId', document.assetUuid);
        this.setText('documentDirty', document.dirty === true ? '是' : document.dirty === false ? '否' : '未知');
        this.setText(
          'previewState',
          preview.serverRunning === true ? `运行中（${display(preview.connectNum)} 个页面）` : '未运行'
        );
        this.setText('updatedAt', `更新于 ${formatTime(state.updatedAt)}`);
        const badge = this.$.connectionBadge;
        if (badge) {
          const isReady = ipc.state === 'ready';
          badge.textContent = isReady ? 'Creator 直连已就绪' : `直连状态：${display(ipc.state)}`;
          badge.className = `badge ${isReady ? 'ready' : 'error'}`;
        }
      } catch (error) {
        const box = this.$.errorBox;
        if (box) {
          box.textContent = error instanceof Error ? error.message : String(error);
          box.classList.remove('hidden');
        }
        const badge = this.$.connectionBadge;
        if (badge) {
          badge.textContent = '状态读取失败';
          badge.className = 'badge error';
        }
      } finally {
        if (button) button.disabled = false;
      }
    }
  },
  ready() {
    this.$.refreshButton?.addEventListener('click', () => void this.refresh());
    this.$.extensionButton?.addEventListener('click', () => {
      void Editor.Message.request('cocos-ai-bridge', 'open-extension-manager');
    });
    void this.refresh();
  }
});

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return typeof value === 'string' ? value : String(value);
}

function formatTime(value: unknown): string {
  if (typeof value !== 'string') return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleTimeString();
}
