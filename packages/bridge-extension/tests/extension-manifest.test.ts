import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('bridge extension manifest', () => {
  it('注册主进程、Scene 进程、工具管理与运行工作台窗口和最外层主菜单', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    ) as {
      main?: string;
      panels?: Record<string, Record<string, unknown>>;
      contributions?: {
        scene?: { script?: string };
        preview?: { simulator?: { methods?: string; hooks?: { settings?: string } } };
        server?: string;
        menu?: Array<Record<string, unknown>>;
        messages?: Record<string, { methods?: string[] }>;
      };
    };

    expect(manifest.main).toBe('./dist/main.js');
    expect(manifest.contributions?.scene?.script).toBe('./dist/scene.js');
    expect(manifest.contributions?.preview?.simulator).toEqual({
      methods: './dist/simulator-runtime-preview.js',
      hooks: { settings: 'onSettingsSimulator' }
    });
    expect(manifest.contributions?.server).toBe('./dist/simulator-runtime-server.js');
    expect(manifest.panels?.default).toMatchObject({
      title: 'i18n:cocos-ai-bridge.panel_title',
      type: 'simple',
      main: './dist/panels/default'
    });
    expect(manifest.panels?.workbench).toMatchObject({
      title: 'i18n:cocos-ai-bridge.workbench_title',
      type: 'simple',
      main: './dist/panels/workbench',
      size: { 'min-width': 1000, 'min-height': 640, width: 1500, height: 860 }
    });
    expect(manifest.contributions?.menu).toContainEqual(expect.objectContaining({
      path: 'Cocos AI',
      label: 'i18n:cocos-ai-bridge.open_panel',
      message: 'open-panel'
    }));
    expect(manifest.contributions?.messages?.['open-panel']?.methods).toEqual(['openPanel']);
    expect(manifest.contributions?.menu).toContainEqual(expect.objectContaining({
      path: 'Cocos AI',
      label: 'i18n:cocos-ai-bridge.open_workbench',
      message: 'open-workbench'
    }));
    expect(manifest.contributions?.messages?.['open-workbench']?.methods).toEqual(['openWorkbench']);
    expect(manifest.contributions?.messages?.['workbench-url']?.methods).toEqual(['queryWorkbenchUrl']);
    expect(manifest.contributions?.messages?.['workbench-close']?.methods).toEqual(['closeWorkbench']);
    expect(manifest.contributions?.messages?.['manager-state']?.methods).toEqual(['queryManagerState']);
    expect(manifest.contributions?.messages?.['open-extension-manager']?.methods).toEqual([
      'openExtensionManager'
    ]);

    const panelSource = readFileSync(
      new URL('../src/panels/default/index.ts', import.meta.url),
      'utf8'
    );
    expect(panelSource).toContain('Editor.Panel.define');
    expect(panelSource).toContain("Editor.Message.request('cocos-ai-bridge', 'manager-state')");
    expect(panelSource).toContain('发布日期');
    expect(panelSource).toContain('overflow: auto');

    const workbenchPanel = readFileSync(
      new URL('../src/panels/workbench/index.ts', import.meta.url),
      'utf8'
    );
    const workbenchHtml = readFileSync(
      new URL('../static/workbench/index.html', import.meta.url),
      'utf8'
    );
    const workbenchApp = readFileSync(new URL('../static/workbench/app.js', import.meta.url), 'utf8');
    const workbenchStyle = readFileSync(new URL('../static/workbench/style.css', import.meta.url), 'utf8');
    const nativeHost = readFileSync(new URL('../native/SimulatorEmbedHost.cpp', import.meta.url), 'utf8');
    expect(workbenchPanel).toContain('Editor.Panel.define');
    expect(workbenchPanel).not.toContain('display-capture');
    expect(workbenchPanel).toContain("Editor.Message.request('cocos-ai-bridge', 'workbench-url')");
    expect(workbenchPanel).toContain("Editor.Message.request('cocos-ai-bridge', 'workbench-close')");
    expect(workbenchHtml).toContain('实时节点树');
    expect(workbenchHtml).toContain('运行时属性');
    expect(workbenchHtml).toContain('Creator 原生模拟器交互区域');
    expect(workbenchHtml).toContain('resolutionSelect');
    expect(workbenchHtml).toContain('调试控制台');
    expect(workbenchHtml).not.toContain('reconnectButton');
    expect(workbenchHtml).not.toContain('reembedButton');
    expect(workbenchHtml).not.toContain('refreshButton');
    expect(workbenchHtml).not.toContain('previewImage');
    expect(workbenchHtml).not.toMatch(/token/i);
    expect(workbenchApp).toContain("api('/api/native-window'");
    expect(workbenchApp).toContain("api('/api/stop'");
    expect(workbenchApp).toContain("api('/api/simulator-settings'");
    expect(workbenchApp).toContain("api('/api/console?sinceSeq='");
    expect(workbenchApp).toContain('host.userStopped !== true');
    expect(workbenchApp).toContain("group.className = 'tree-children'");
    expect(workbenchApp).toContain("row.setAttribute('aria-level', String(depth + 1))");
    expect(workbenchApp).toContain('expandTreeToDepth(hierarchy.root, 3)');
    expect(workbenchApp).toContain('visiblePropertyNames(component)');
    expect(workbenchApp).toContain('component.propertyMeta && component.propertyMeta[name]');
    expect(workbenchApp).toContain('meta.visible === true');
    expect(workbenchApp).toContain('hasPendingChanges()');
    expect(workbenchApp).toContain('连接已断开，未应用修改已保留');
    expect(workbenchApp).toContain('sessionId: selectedSessionId');
    expect(workbenchApp).toContain('hasStalePendingChanges()');
    expect(workbenchApp).toContain("draftSessionId: ''");
    expect(workbenchApp).toContain('state.draftSessionId !== sessionId');
    expect(workbenchApp).toContain('state.selectedNode && !hasPendingChanges()');
    expect(workbenchApp).toContain('validateNumberInput');
    expect(workbenchApp).toContain('!pending && !state.invalid.has(key)');
    expect(workbenchApp).toContain("row.querySelector('.property-reset')");
    expect(workbenchApp).toContain("[{ type: 'cc.Node' }]");
    expect(workbenchApp).toContain('var enumOptions = meta.enumOptions');
    expect(workbenchApp).toContain('function readonlyDump(dump)');
    expect(workbenchApp).toContain('function colorEditor(value, onChange, meta)');
    expect(workbenchApp).toContain("reset.hidden = !meta.editable");
    expect(workbenchApp).toContain("state.invalid.set(key, errorMessage)");
    expect(workbenchApp).toContain("elements.revertButton.addEventListener('click', revertPending)");
    expect(workbenchApp).toContain('state.nativeSessionId === session.sessionId');
    expect(workbenchApp).toContain("api('/api/native-highlight'");
    expect(workbenchApp).not.toContain('navigator.mediaDevices.getUserMedia');
    expect(workbenchApp).not.toContain('MediaStreamTrackProcessor');
    expect(workbenchApp).not.toContain('/api/frames');
    expect(workbenchApp).toContain("api('/api/native-input'");
    expect(workbenchApp).not.toContain('createImageBitmap(new Blob([frame]');
    expect(workbenchApp).not.toContain('elements.gameFrame.naturalWidth');
    expect(workbenchApp).toContain("addEventListener('pointerdown'");
    expect(workbenchApp).toContain("addEventListener('pointermove'");
    expect(workbenchApp).toContain("['pointerup', 'pointercancel']");
    expect(workbenchApp).toContain("addEventListener('wheel'");
    expect(workbenchApp).toContain("['keydown', 'keyup']");
    expect(workbenchApp).toContain('pumpNativeInput');
    expect(workbenchApp).toMatch(/applySize\(initialSize \+ \(vertical \? -delta : delta\)\);\s*scheduleNativeEmbed\(false\);/);
    expect(workbenchApp).toContain('setInterval(refreshHierarchy, 500)');
    expect(workbenchApp).toContain('setInterval(refreshConsole, 1000)');
    expect(workbenchApp).toContain('pane.getBoundingClientRect()');
    expect(workbenchApp).not.toContain("parseFloat(styles.getPropertyValue(property)) / 100 * window.innerWidth");
    expect(workbenchStyle).toContain('.tree-children::before');
    expect(workbenchStyle).toContain('.tree-row.parent .tree-name');
    expect(workbenchHtml).toContain('data-splitter="console"');
    expect(workbenchHtml).toContain('aria-orientation="horizontal"');
    expect(workbenchStyle).not.toContain('.workspace { overflow-x: auto; }');
    expect(nativeHost).toContain('CreateWindowExW(0, className.c_str(), L"", WS_CHILD | WS_VISIBLE');
    expect(nativeHost).toContain('capture::GraphicsCaptureSession::IsSupported()');
    expect(nativeHost).toContain('CreateDirect3D11DeviceFromDXGIDevice');
    expect(nativeHost).toContain('d3dContext->CopySubresourceRegion');
    expect(nativeHost).toMatch(/SetWindowLongPtrChecked\(\s*simulatorWindow,\s*GWLP_HWNDPARENT,\s*reinterpret_cast<LONG_PTR>\(parentWindow\),\s*"SET_SIMULATOR_OWNER_FAILED"\s*\)/);
    expect(nativeHost).toContain('SetLayeredWindowAttributes(simulatorWindow, 0, 0, LWA_ALPHA)');
    expect(nativeHost).toContain('GetSystemMetrics(SM_XVIRTUALSCREEN) - width - 16');
    expect(nativeHost).toContain('GetSystemMetrics(SM_YVIRTUALSCREEN) - height - 16');
    expect(nativeHost).toContain('SWP_NOACTIVATE | SWP_NOZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW');
    expect(nativeHost).toContain('FindWindowExW(simulatorWindow, nullptr, L"RICHEDIT50W"');
    expect(nativeHost).toContain('AttachThreadInput(currentThread, editThread, TRUE)');
    expect(nativeHost).toContain('SendNotifyMessageW(editBox, message, wParam, lParam)');
    expect(nativeHost).toContain('case WM_IME_CHAR:');
    expect(nativeHost).not.toContain('CreateRemoteThread');
    expect(nativeHost).not.toContain('simulator-frame-hook.dll');
    expect(nativeHost).toContain('Windows.Graphics.Capture');
    expect(workbenchHtml).not.toContain('<canvas id="gameFrame"');
    expect(workbenchStyle).not.toContain('.game-surface canvas');
    expect(workbenchHtml).toContain('id="nodeOverlay"');
    expect(nativeHost).not.toContain('private static extern IntPtr SetParent(IntPtr child, IntPtr newParent);');
    const workbenchHost = readFileSync(new URL('../src/workbench-host.ts', import.meta.url), 'utf8');
    const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    expect(workbenchHost).toContain('intervalMs: 500');
    expect(workbenchHost).toContain('new module.CreatorClient(requestCreator ? { requestCreator } : undefined)');
    expect(mainSource).toContain('requestWorkbenchCreator');
    expect(workbenchHost).toContain("Get-CimInstance Win32_Process -Filter \\\"Name = 'SimulatorApp-Win32.exe'\\\"");
    expect(workbenchHost).toContain('terminateCreatorSimulatorProcesses(process.pid, processId)');
    expect(workbenchHost).toContain('userStopped: this.userStopped');
  });

  it('为 Creator 本地扩展管理器提供双语摘要和详情元数据', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    ) as {
      version: string;
      description: string;
      author: string;
      date: string;
      platform: string[];
      editor: string;
    };
    const zhDetail = readFileSync(new URL('../README.zh.md', import.meta.url), 'utf8');
    const enDetail = readFileSync(new URL('../README.en.md', import.meta.url), 'utf8');
    const zhI18n = readFileSync(new URL('../i18n/zh.js', import.meta.url), 'utf8');
    const enI18n = readFileSync(new URL('../i18n/en.js', import.meta.url), 'utf8');

    expect(manifest).toMatchObject({
      description: 'i18n:cocos-ai-bridge.description',
      author: 'Enti',
      date: '2026-09-09',
      platform: ['win32'],
      editor: '>=3.8.0 <3.9.0'
    });
    for (const detail of [zhDetail, enDetail]) {
      expect(detail).toContain(`V${manifest.version}`);
      expect(detail).toContain(manifest.date);
      expect(detail).toContain(manifest.author);
      expect(detail).toContain(manifest.editor);
      expect(detail).toContain('win32');
    }
    expect(zhI18n).toContain('Cocos AI 工具管理');
    expect(zhI18n).toContain('Cocos AI 运行工作台');
    expect(enI18n).toContain('Cocos AI Tool Manager');
    expect(enI18n).toContain('Cocos AI Runtime Workbench');
  });
});
