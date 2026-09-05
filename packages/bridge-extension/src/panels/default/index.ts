type RecordValue = Record<string, unknown>;

interface ToolEntry {
  name: string;
  group: string;
  writeRequired: boolean;
  destructive: boolean;
  summary: string;
}

const template = `
<main class="manager">
  <header class="hero">
    <div>
      <div class="eyebrow">COCOS AI TOOLKIT</div>
      <h1>Cocos AI 工具管理</h1>
      <p>Creator 本机直连、项目状态与当前版本工具清单</p>
    </div>
    <span id="connectionBadge" class="badge neutral">读取中</span>
  </header>

  <section class="actions">
    <button id="refreshButton" type="button">刷新状态</button>
    <button id="extensionButton" type="button" class="secondary">打开扩展管理器</button>
    <span id="updatedAt" class="updated">尚未更新</span>
  </section>

  <nav class="tabs" aria-label="工具管理页面">
    <button id="statusTab" type="button" class="tab active" aria-selected="true">运行状态</button>
    <button id="toolsTab" type="button" class="tab" aria-selected="false">
      工具列表 <span id="toolCount" class="tab-count">—</span>
    </button>
  </nav>

  <section id="statusPage" class="page">
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
  </section>

  <section id="toolsPage" class="page hidden">
    <header class="page-heading">
      <div>
        <h2>当前版本工具</h2>
        <p id="toolSummary">正在读取工具清单</p>
      </div>
      <div class="legend">
        <span class="tool-mode always">无需写入开关</span>
        <span class="tool-mode gated">需开启写入</span>
      </div>
    </header>
    <div id="toolList" class="tool-list"></div>
  </section>

  <section id="errorBox" class="error hidden" role="alert"></section>
</main>
`;

const style = `
:host { display: block; height: 100%; color: var(--color-normal-contrast, #d7dbe0); }
* { box-sizing: border-box; }
.manager { min-height: 100%; height: 100%; overflow: auto; padding: 18px; background: #202226; font: 13px/1.5 sans-serif; }
.hero { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 14px; }
.eyebrow { color: #66a9f3; font-size: 11px; font-weight: 700; letter-spacing: .14em; }
h1 { margin: 3px 0 0; font-size: 22px; font-weight: 650; }
h2 { margin: 0 0 10px; font-size: 14px; font-weight: 650; }
p { margin: 3px 0 0; color: #8f98a5; }
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
.tabs { display: flex; gap: 4px; margin-bottom: 12px; border-bottom: 1px solid #3a3e45; }
.tab { min-height: 34px; padding: 0 14px; color: #9ea6b1; background: transparent; border: 0; border-bottom: 2px solid transparent; border-radius: 0; }
.tab:hover { color: #e4e8ed; background: #292c31; }
.tab.active { color: #fff; border-bottom-color: #4d9af1; }
.tab-count { display: inline-block; min-width: 22px; margin-left: 4px; padding: 0 6px; color: #bdc8d5; background: #343940; border-radius: 999px; font-size: 11px; line-height: 19px; }
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
.page-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.page-heading h2 { margin-bottom: 2px; font-size: 16px; }
.legend { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.tool-list { display: grid; gap: 12px; }
.tool-group { overflow: hidden; background: #292c31; border: 1px solid #393d44; border-radius: 7px; }
.tool-group-title { display: flex; justify-content: space-between; margin: 0; padding: 10px 13px; color: #dfe5ec; background: #30343a; font-size: 13px; }
.tool-group-count { color: #89919c; font-weight: 400; }
.tool-item { display: grid; grid-template-columns: minmax(220px, .9fr) minmax(220px, 1.1fr) auto; align-items: center; gap: 12px; padding: 9px 13px; border-top: 1px solid #373b42; }
.tool-name { color: #9ec9fb; font: 12px/1.45 Consolas, monospace; user-select: text; overflow-wrap: anywhere; }
.tool-description { color: #b5bcc6; }
.tool-mode { flex: none; padding: 2px 7px; border: 1px solid; border-radius: 999px; font-size: 11px; white-space: nowrap; }
.tool-mode.always { color: #9be7b1; background: #153b25; border-color: #28623d; }
.tool-mode.gated { color: #ffd08c; background: #453219; border-color: #705126; }
.tool-mode.danger { color: #ffb0ad; background: #481d1d; border-color: #773333; }
.error { margin-top: 12px; padding: 10px 12px; color: #ffc1bd; background: #401d1d; border: 1px solid #6f3333; border-radius: 5px; white-space: pre-wrap; }
.hidden { display: none; }
@media (max-width: 680px) {
  .grid { grid-template-columns: 1fr; }
  .card.wide { grid-column: auto; }
  .tool-item { grid-template-columns: 1fr auto; }
  .tool-description { grid-column: 1 / -1; grid-row: 2; }
}
`;

module.exports = Editor.Panel.define({
  template,
  style,
  $: {
    refreshButton: '#refreshButton',
    extensionButton: '#extensionButton',
    statusTab: '#statusTab',
    toolsTab: '#toolsTab',
    statusPage: '#statusPage',
    toolsPage: '#toolsPage',
    toolCount: '#toolCount',
    toolSummary: '#toolSummary',
    toolList: '#toolList',
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
    selectPage(page: 'status' | 'tools'): void {
      const showTools = page === 'tools';
      this.$.statusPage?.classList.toggle('hidden', showTools);
      this.$.toolsPage?.classList.toggle('hidden', !showTools);
      this.$.statusTab?.classList.toggle('active', !showTools);
      this.$.toolsTab?.classList.toggle('active', showTools);
      this.$.statusTab?.setAttribute('aria-selected', String(!showTools));
      this.$.toolsTab?.setAttribute('aria-selected', String(showTools));
    },
    renderTools(value: unknown, version?: unknown): void {
      const list = this.$.toolList;
      if (!list) return;

      const tools = Array.isArray(value)
        ? value.map(readToolEntry).filter((item): item is ToolEntry => item !== null)
        : [];
      list.textContent = '';
      this.setText('toolCount', tools.length);
      this.setText(
        'toolSummary',
        `${tools.length} 个公开 MCP 工具（版本 ${display(version)}）；“需开启写入”工具只有在 MCP 使用 --enable-writes 启动时可调用。`
      );

      const groups = new Map<string, ToolEntry[]>();
      for (const tool of tools) {
        const items = groups.get(tool.group) ?? [];
        items.push(tool);
        groups.set(tool.group, items);
      }

      for (const [groupName, items] of groups) {
        const group = document.createElement('section');
        group.className = 'tool-group';

        const title = document.createElement('h3');
        title.className = 'tool-group-title';
        const label = document.createElement('span');
        label.textContent = groupName;
        const count = document.createElement('span');
        count.className = 'tool-group-count';
        count.textContent = `${items.length} 个`;
        title.append(label, count);
        group.append(title);

        for (const tool of items) {
          const row = document.createElement('div');
          row.className = 'tool-item';
          const name = document.createElement('code');
          name.className = 'tool-name';
          name.textContent = tool.name;
          const description = document.createElement('span');
          description.className = 'tool-description';
          description.textContent = tool.summary;
          const mode = document.createElement('span');
          mode.className = `tool-mode ${tool.destructive ? 'danger' : tool.writeRequired ? 'gated' : 'always'}`;
          mode.textContent = tool.destructive ? '可能删除' : tool.writeRequired ? '需开启写入' : '无需写入开关';
          row.append(name, description, mode);
          group.append(row);
        }
        list.append(group);
      }
    },
    async refresh(): Promise<void> {
      const button = this.$.refreshButton as HTMLButtonElement | null;
      if (button) button.disabled = true;
      this.$.errorBox?.classList.add('hidden');
      try {
        const state = await Editor.Message.request('cocos-ai-bridge', 'manager-state') as RecordValue;
        const extension = record(state.extension);
        const tools = record(state.tools);
        const ipc = record(state.ipc);
        const editor = record(state.editor);
        const ready = record(editor.ready);
        const documentState = record(editor.document);
        const preview = record(editor.preview);
        this.setText('version', extension.version);
        this.setText('releaseDate', extension.releaseDate);
        this.setText('author', extension.author);
        this.setText('buildId', extension.buildId);
        this.renderTools(tools.items, tools.version);
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
        this.setText('documentId', documentState.assetUuid);
        this.setText(
          'documentDirty',
          documentState.dirty === true ? '是' : documentState.dirty === false ? '否' : '未知'
        );
        this.setText(
          'previewState',
          preview.serverRunning === true ? `运行中（${display(preview.connectNum)} 个页面）` : '未运行'
        );
        this.setText('updatedAt', `更新于 ${formatTime(state.updatedAt)}`);
        const badge = this.$.connectionBadge;
        if (badge) {
          const isReady = ipc.state === 'ready';
          badge.textContent = isReady ? 'Creator 直连已就绪' : `直连状态：${display(ipc.state)}`;
          badge.className = `badge ${isReady ? 'ready' : 'neutral'}`;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const box = this.$.errorBox;
        if (box) {
          box.textContent = message;
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
    this.$.statusTab?.addEventListener('click', () => this.selectPage('status'));
    this.$.toolsTab?.addEventListener('click', () => this.selectPage('tools'));
    void this.refresh();
  }
});

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

function readToolEntry(value: unknown): ToolEntry | null {
  const item = record(value);
  if (
    typeof item.name !== 'string'
    || typeof item.group !== 'string'
    || typeof item.writeRequired !== 'boolean'
    || typeof item.summary !== 'string'
  ) {
    return null;
  }
  return {
    name: item.name,
    group: item.group,
    writeRequired: item.writeRequired,
    destructive: item.destructive === true,
    summary: item.summary
  };
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
