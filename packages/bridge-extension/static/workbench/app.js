(function () {
  'use strict';

  var state = {
    host: null,
    hierarchy: null,
    selectedPath: '',
    selectedNode: null,
    selectedComponent: '',
    component: null,
    expanded: new Set(),
    pending: new Map(),
    nativeTimer: 0,
    nativeBusy: false,
    polling: false,
    toastTimer: 0
  };

  var elements = Object.fromEntries([
    'connectionState', 'sceneName', 'resolution', 'startButton', 'reconnectButton', 'refreshButton',
    'treeSearch', 'treeView', 'treeMeta', 'selectionHeader', 'selectedName', 'selectedUuid', 'selectedPath',
    'componentTabs', 'propertyView', 'applyButton', 'liveState', 'processName', 'previewStage',
    'previewPlaceholder', 'embedMeta', 'reembedButton', 'runtimeId', 'sceneEpoch', 'lastUpdated',
    'workspace', 'toast'
  ].map(function (id) { return [id, document.getElementById(id)]; }));

  async function api(path, options) {
    var response = await fetch(path, Object.assign({ cache: 'no-store' }, options || {}));
    var text = await response.text();
    var value = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(value.error || ('HTTP_' + response.status));
    return value;
  }

  async function refreshState() {
    try {
      state.host = await api('/api/state');
      renderState();
      if (state.host.status === 'ready') await refreshHierarchy();
    } catch (error) {
      showToast(error.message || String(error), true);
    }
  }

  async function start(reconnect) {
    setBusy(true);
    try {
      state.host = await api(reconnect ? '/api/reconnect' : '/api/start', { method: 'POST' });
      renderState();
      await refreshHierarchy();
      scheduleNativeEmbed(true);
    } catch (error) {
      showToast(error.message || String(error), true);
    } finally {
      setBusy(false);
    }
  }

  async function refreshHierarchy() {
    if (state.polling || state.host?.status !== 'ready') return;
    state.polling = true;
    try {
      var hierarchy = await api('/api/hierarchy');
      var sceneChanged = !state.hierarchy || state.hierarchy.sceneEpoch !== hierarchy.sceneEpoch;
      var changed = !state.hierarchy
        || state.hierarchy.revision !== hierarchy.revision
        || sceneChanged;
      state.hierarchy = hierarchy;
      if (changed) {
        if (sceneChanged) {
          state.expanded.clear();
          expandTreeToDepth(hierarchy.root, 3);
        }
        reconcileSelection();
        renderTree();
      }
      renderState();
    } catch (error) {
      if (!String(error.message).includes('NOT_READY')) showToast(error.message || String(error), true);
    } finally {
      state.polling = false;
    }
  }

  function renderState() {
    var host = state.host || {};
    var runtime = host.runtime || {};
    var session = host.session || {};
    var connected = runtime.connected === true && host.status === 'ready';
    var nativeWindow = host.nativeWindow || {};
    var embedded = nativeWindow.state === 'ready';
    elements.connectionState.className = 'connection ' + (connected ? 'connected' : 'disconnected');
    elements.connectionState.innerHTML = '<span class="live-dot"></span>' + (connected ? '模拟器已连接' : host.status === 'starting' ? '正在连接' : '模拟器未连接');
    elements.liveState.className = 'live-state ' + (embedded ? 'connected' : '');
    elements.liveState.innerHTML = '<span class="live-dot"></span>' + (embedded ? '已嵌入' : connected ? '准备嵌入' : '等待连接');
    elements.runtimeId.textContent = runtime.runtimeId || session.runtimeInstanceId || '—';
    elements.sceneEpoch.textContent = host.hierarchy?.sceneEpoch ?? state.hierarchy?.sceneEpoch ?? '—';
    elements.lastUpdated.textContent = formatTime(host.lastUpdateAt);
    elements.sceneName.textContent = state.hierarchy?.root?.name || '—';
    var size = session.actualResolution;
    elements.resolution.textContent = size ? size.width + ' × ' + size.height : '—';
    elements.processName.textContent = 'SimulatorApp-Win32.exe · PID '
      + (session.appPid || nativeWindow.childProcessId || '—');
    elements.embedMeta.textContent = embedded
      ? (size ? size.width + ' × ' + size.height + ' · 可直接操作' : '原生窗口已嵌入')
      : nativeWindow.state === 'error' ? '嵌入失败' : '等待嵌入';
    elements.previewPlaceholder.classList.toggle('hidden', embedded);
    elements.treeMeta.textContent = (state.hierarchy?.nodeCount || 0) + ' 个节点 · revision ' + (state.hierarchy?.revision ?? '—');
    elements.startButton.disabled = host.status === 'starting' || connected;
    elements.reconnectButton.disabled = host.status === 'starting';
    elements.reembedButton.disabled = !connected || state.nativeBusy;
    if (host.error) showToast(host.error, true);
    if (nativeWindow.error) showToast(nativeWindow.error, true);
    if (connected && session.sessionId && nativeWindow.state === 'idle') scheduleNativeEmbed(false);
  }

  function renderTree() {
    var root = state.hierarchy?.root;
    elements.treeView.textContent = '';
    if (!root) {
      elements.treeView.innerHTML = '<div class="empty-state">启动或连接 Creator 模拟器后显示真实运行节点</div>';
      return;
    }
    var query = elements.treeSearch.value.trim().toLowerCase();
    var fragment = document.createDocumentFragment();
    appendNode(root, 0, fragment, query);
    elements.treeView.appendChild(fragment);
  }

  function appendNode(node, depth, target, query) {
    if (query && !nodeMatches(node, query) && !(node.children || []).some(function childMatches(child) { return nodeOrDescendantMatches(child, query); })) return;
    var children = node.children || [];
    var expanded = state.expanded.has(node.path) || Boolean(query);
    var branch = document.createElement('div');
    branch.className = 'tree-branch' + (depth === 0 ? ' tree-root' : '');
    var row = document.createElement('div');
    row.className = 'tree-row'
      + (children.length ? ' parent' : '')
      + (node.active === false ? ' inactive' : '')
      + (state.selectedPath === node.path ? ' selected' : '');
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(depth + 1));
    row.setAttribute('aria-selected', String(state.selectedPath === node.path));
    if (children.length) row.setAttribute('aria-expanded', String(expanded));
    row.title = [
      node.path || '',
      node.uuid ? 'UUID: ' + node.uuid : '',
      (node.components || []).length + ' 个组件',
      node.active === false ? '未激活' : '激活'
    ].filter(Boolean).join('\n');

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tree-toggle' + (children.length ? (expanded ? ' expanded' : '') : ' empty');
    toggle.innerHTML = '<svg viewBox="0 0 10 12" aria-hidden="true"><path d="M2.5 2 7 6 2.5 10"/></svg>';
    toggle.setAttribute('aria-label', children.length ? (expanded ? '收起 ' : '展开 ') + (node.name || '节点') : '');
    if (!children.length) toggle.tabIndex = -1;
    toggle.addEventListener('click', function (event) {
      event.stopPropagation();
      if (expanded) state.expanded.delete(node.path); else state.expanded.add(node.path);
      renderTree();
    });
    var icon = document.createElement('span');
    icon.className = 'tree-node-icon ' + (depth === 0 ? 'scene' : 'node');
    icon.setAttribute('aria-hidden', 'true');
    var name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = node.name || '(unnamed)';
    var count = document.createElement('span');
    count.className = 'tree-count';
    count.textContent = (node.components || []).length ? String(node.components.length) : '';
    count.title = (node.components || []).length + ' 个组件';
    var active = document.createElement('span');
    active.className = 'tree-active' + (node.active === false ? ' inactive' : '');
    active.title = node.active === false ? '未激活' : '激活';
    active.setAttribute('role', 'img');
    active.setAttribute('aria-label', active.title);
    row.append(toggle, icon, name, count, active);
    row.addEventListener('click', function () { void selectNode(node); });
    branch.appendChild(row);
    if (expanded && children.length) {
      var group = document.createElement('div');
      group.className = 'tree-children';
      group.setAttribute('role', 'group');
      children.forEach(function (child) { appendNode(child, depth + 1, group, query); });
      branch.appendChild(group);
    }
    target.appendChild(branch);
  }

  function nodeMatches(node, query) {
    return [node.name, node.uuid, node.path].some(function (value) { return String(value || '').toLowerCase().includes(query); });
  }

  function nodeOrDescendantMatches(node, query) {
    return nodeMatches(node, query) || (node.children || []).some(function (child) { return nodeOrDescendantMatches(child, query); });
  }

  function expandTreeToDepth(node, maxDepth, depth) {
    depth = depth || 0;
    if (!node || depth >= maxDepth || !(node.children || []).length) return;
    state.expanded.add(node.path);
    node.children.forEach(function (child) { expandTreeToDepth(child, maxDepth, depth + 1); });
  }

  async function selectNode(node) {
    state.selectedNode = node;
    state.selectedPath = node.path || '';
    state.pending.clear();
    elements.selectedName.textContent = node.name || '(unnamed)';
    elements.selectedUuid.textContent = node.uuid || '—';
    elements.selectedPath.textContent = node.path || '—';
    elements.selectionHeader.classList.remove('empty');
    renderTree();
    renderComponentTabs();
    var components = node.components || [];
    if (components.length) await selectComponent(components[0].type);
    else {
      state.selectedComponent = '';
      state.component = null;
      elements.propertyView.innerHTML = '<div class="empty-state">此运行时节点没有组件</div>';
      renderApplyState();
    }
  }

  function renderComponentTabs() {
    elements.componentTabs.textContent = '';
    (state.selectedNode?.components || []).forEach(function (component) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'component-tab' + (state.selectedComponent === component.type ? ' active' : '');
      button.textContent = component.type;
      button.addEventListener('click', function () { void selectComponent(component.type); });
      elements.componentTabs.appendChild(button);
    });
  }

  async function selectComponent(type) {
    state.selectedComponent = type;
    state.pending.clear();
    renderComponentTabs();
    elements.propertyView.innerHTML = '<div class="empty-state">正在读取 ' + escapeText(type) + '</div>';
    renderApplyState();
    try {
      state.component = await api('/api/component?path=' + encodeURIComponent(state.selectedPath) + '&componentType=' + encodeURIComponent(type));
      renderProperties();
    } catch (error) {
      elements.propertyView.innerHTML = '<div class="empty-state">' + escapeText(error.message || String(error)) + '</div>';
    }
  }

  function renderProperties() {
    elements.propertyView.textContent = '';
    var panel = document.createElement('section');
    panel.className = 'component-panel';
    var title = document.createElement('header');
    title.className = 'component-title';
    title.textContent = '⌄  ' + state.selectedComponent;
    panel.appendChild(title);
    var properties = state.component?.properties || {};
    Object.keys(properties).sort().forEach(function (name) {
      panel.appendChild(createPropertyRow(name, properties[name]));
    });
    if (!Object.keys(properties).length) panel.appendChild(emptyPropertyRow());
    elements.propertyView.appendChild(panel);
  }

  function createPropertyRow(name, value) {
    var row = document.createElement('div');
    row.className = 'property-row';
    row.dataset.property = name;
    var label = document.createElement('label');
    label.className = 'property-name';
    label.textContent = name;
    label.title = name;
    var control = document.createElement('div');
    control.className = 'property-control';
    var input;
    if (typeof value === 'boolean') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = value;
      input.addEventListener('change', function () { markPending(name, input.checked, row); });
    } else if (typeof value === 'number') {
      input = document.createElement('input');
      input.type = 'number';
      input.step = 'any';
      input.value = String(value);
      input.addEventListener('input', function () { markPending(name, Number(input.value), row); });
    } else if (typeof value === 'string') {
      input = document.createElement('input');
      input.type = 'text';
      input.value = value;
      input.addEventListener('input', function () { markPending(name, input.value, row); });
    } else {
      input = document.createElement('textarea');
      input.value = JSON.stringify(value, null, 2);
      input.addEventListener('input', function () {
        try {
          control.classList.remove('invalid');
          markPending(name, JSON.parse(input.value), row);
        } catch (_) {
          control.classList.add('invalid');
          state.pending.delete(name);
          renderApplyState();
        }
      });
    }
    input.setAttribute('aria-label', name);
    var kind = document.createElement('div');
    kind.className = 'property-kind';
    kind.textContent = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    control.append(input, kind);
    row.append(label, control);
    return row;
  }

  function emptyPropertyRow() {
    var row = document.createElement('div');
    row.className = 'empty-state';
    row.textContent = '没有可读取的公开属性';
    return row;
  }

  function markPending(name, value, row) {
    state.pending.set(name, value);
    row.classList.add('pending');
    renderApplyState();
  }

  function renderApplyState() {
    elements.applyButton.disabled = state.pending.size === 0 || !state.selectedComponent;
    elements.applyButton.textContent = state.pending.size > 1 ? '应用 ' + state.pending.size + ' 项并回读' : '应用并回读';
  }

  async function applyPending() {
    if (!state.pending.size) return;
    elements.applyButton.disabled = true;
    try {
      for (var entry of state.pending.entries()) {
        await api('/api/property', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            path: state.selectedPath,
            componentType: state.selectedComponent,
            property: entry[0],
            value: entry[1]
          })
        });
      }
      state.pending.clear();
      await selectComponent(state.selectedComponent);
      showToast('运行时属性已写入并回读');
    } catch (error) {
      showToast(error.message || String(error), true);
    } finally {
      renderApplyState();
    }
  }

  function reconcileSelection() {
    if (!state.selectedPath) return;
    var node = findNodeByPath(state.hierarchy?.root, state.selectedPath);
    if (node) state.selectedNode = node;
    else clearSelection();
  }

  function findNodeByPath(node, path) {
    if (!node) return null;
    if (node.path === path) return node;
    for (var child of node.children || []) {
      var found = findNodeByPath(child, path);
      if (found) return found;
    }
    return null;
  }

  function clearSelection() {
    state.selectedPath = '';
    state.selectedNode = null;
    state.selectedComponent = '';
    state.component = null;
    state.pending.clear();
    elements.selectionHeader.classList.add('empty');
    elements.selectedName.textContent = '未选择节点';
    elements.selectedUuid.textContent = '—';
    elements.selectedPath.textContent = '—';
    elements.componentTabs.textContent = '';
    elements.propertyView.innerHTML = '<div class="empty-state">从左侧选择一个运行时节点</div>';
    renderApplyState();
  }

  function scheduleNativeEmbed(showErrors) {
    clearTimeout(state.nativeTimer);
    state.nativeTimer = setTimeout(function () { void embedNativeWindow(showErrors); }, showErrors ? 0 : 80);
  }

  async function embedNativeWindow(showErrors) {
    var sessionId = state.host?.session?.sessionId || '';
    if (!sessionId || state.host?.status !== 'ready' || state.nativeBusy) return;
    state.nativeBusy = true;
    elements.reembedButton.disabled = true;
    try {
      var result = await api('/api/native-window', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({ parentTitle: document.title }, nativeWindowBounds()))
      });
      state.host.nativeWindow = result;
      renderState();
    } catch (error) {
      state.host.nativeWindow = { state: 'error', error: error.message || String(error) };
      elements.previewPlaceholder.classList.remove('hidden');
      elements.embedMeta.textContent = '嵌入失败';
      if (showErrors) showToast(error.message || String(error), true);
    } finally {
      state.nativeBusy = false;
      elements.reembedButton.disabled = false;
    }
  }

  function nativeWindowBounds() {
    var rect = elements.previewStage.getBoundingClientRect();
    var size = state.host?.session?.actualResolution;
    var x = rect.left + 1;
    var y = rect.top + 1;
    var width = Math.max(32, rect.width - 2);
    var height = Math.max(32, rect.height - 2);
    if (size?.width > 0 && size?.height > 0) {
      var aspect = size.width / size.height;
      var fittedHeight = width / aspect;
      if (fittedHeight <= height) {
        y += (height - fittedHeight) / 2;
        height = fittedHeight;
      } else {
        var fittedWidth = height * aspect;
        x += (width - fittedWidth) / 2;
        width = fittedWidth;
      }
    }
    return {
      x: x,
      y: y,
      width: width,
      height: height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    };
  }

  function setBusy(value) {
    elements.startButton.disabled = value;
    elements.reconnectButton.disabled = value;
    elements.refreshButton.disabled = value;
  }

  function showToast(message, error) {
    clearTimeout(state.toastTimer);
    elements.toast.textContent = message;
    elements.toast.className = 'toast visible' + (error ? ' error' : '');
    state.toastTimer = setTimeout(function () { elements.toast.className = 'toast'; }, 3500);
  }

  function formatTime(value) {
    if (!value) return '—';
    var date = new Date(value);
    return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleTimeString();
  }

  function escapeText(value) {
    var element = document.createElement('span');
    element.textContent = String(value);
    return element.innerHTML;
  }

  function installSplitters() {
    document.querySelectorAll('.splitter').forEach(function (splitter) {
      splitter.addEventListener('pointerdown', function (event) {
        var kind = splitter.dataset.splitter;
        var startX = event.clientX;
        var property = kind === 'tree' ? '--tree-width' : '--inspector-width';
        var minimum = kind === 'tree' ? 220 : 300;
        var startWidth = splitter.previousElementSibling.getBoundingClientRect().width;
        var otherPane = document.querySelector(kind === 'tree' ? '.inspector-pane' : '.tree-pane');
        var workspaceStyle = getComputedStyle(elements.workspace);
        var workspacePadding = parseFloat(workspaceStyle.paddingLeft) + parseFloat(workspaceStyle.paddingRight);
        var maximum = Math.max(minimum, elements.workspace.clientWidth - workspacePadding - otherPane.getBoundingClientRect().width - 430);
        splitter.classList.add('dragging');
        splitter.setPointerCapture(event.pointerId);
        function move(moveEvent) {
          var width = Math.min(maximum, Math.max(minimum, startWidth + moveEvent.clientX - startX));
          document.documentElement.style.setProperty(property, width + 'px');
        }
        function up() {
          splitter.classList.remove('dragging');
          splitter.removeEventListener('pointermove', move);
          splitter.removeEventListener('pointerup', up);
        }
        splitter.addEventListener('pointermove', move);
        splitter.addEventListener('pointerup', up);
      });
    });
  }

  elements.startButton.addEventListener('click', function () { void start(false); });
  elements.reconnectButton.addEventListener('click', function () { void start(true); });
  elements.refreshButton.addEventListener('click', function () { void refreshState(); });
  elements.reembedButton.addEventListener('click', function () { scheduleNativeEmbed(true); });
  elements.applyButton.addEventListener('click', function () { void applyPending(); });
  elements.treeSearch.addEventListener('input', renderTree);
  new ResizeObserver(function () { scheduleNativeEmbed(false); }).observe(elements.previewStage);
  window.addEventListener('pagehide', function () {
    navigator.sendBeacon('/api/native-window/detach');
  });
  installSplitters();
  void refreshState().then(function () {
    if (state.host?.runtime?.connected && state.host.status !== 'ready') void start(false);
  });
  setInterval(refreshState, 1000);
  setInterval(refreshHierarchy, 200);
})();
