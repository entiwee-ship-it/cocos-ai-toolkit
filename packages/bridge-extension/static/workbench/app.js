(function () {
  'use strict';

  var state = {
    host: null,
    hierarchy: null,
    selectedPath: '',
    selectedNode: null,
    components: [],
    groupTabs: new Map(),
    expanded: new Set(),
    componentExpanded: new Set(),
    pending: new Map(),
    draftSessionId: '',
    nativeTimer: 0,
    nativeBusy: false,
    polling: false,
    toastTimer: 0,
    lastToast: '',
    invalid: new Map(),
    settings: null,
    settingsTimer: 0,
    settingsBusy: false,
    consoleSessionId: '',
    consoleSeq: 0,
    consoleBusy: false,
    consoleEntries: [],
    consoleGeneration: 0,
    consoleFollow: true,
    consoleCleared: false,
    userStopped: false,
    autoStarting: false
  };

  var elements = Object.fromEntries([
    'connectionState', 'sceneName', 'resolution', 'startButton',
    'treeSearch', 'treeView', 'treeMeta', 'selectionHeader', 'selectedName', 'selectedUuid', 'selectedPath', 'selectionMeta',
    'propertyView', 'applyButton', 'revertButton', 'applyStatus', 'liveState', 'processName', 'previewStage', 'previewPlaceholder', 'embedMeta',
    'runtimeId', 'sceneEpoch', 'lastUpdated', 'workspace', 'toast', 'resolutionSelect', 'orientationSelect',
    'consoleMeta', 'consoleView', 'clearConsoleButton', 'consoleSearch', 'consoleLevel', 'consoleFollowButton', 'toggleComponentsButton'
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
      var previousSessionId = state.host?.session?.sessionId || '';
      state.host = await api('/api/state');
      var nextSessionId = state.host?.session?.sessionId || '';
      if (state.host?.userStopped === true) state.userStopped = true;
      else if (nextSessionId) state.userStopped = false;
      if (previousSessionId !== nextSessionId) {
        resetConsole(nextSessionId);
        if (!nextSessionId) { state.hierarchy = null; renderTree(); }
        void refreshSettings();
        if (previousSessionId && hasPendingChanges()) {
          showToast('运行连接已变化，未应用修改已保留', true);
        } else if (previousSessionId && !hasPendingChanges()) {
          clearSelection({ discardChanges: true });
        }
      }
      renderState();
      if (state.host.status === 'ready') await refreshHierarchy();
    } catch (error) {
      showToast(error.message || String(error), true);
    }
  }

  async function toggleSession() {
    var running = Boolean(state.host?.session?.sessionId)
      || state.host?.status === 'ready'
      || (state.host?.runtime?.connected === true && state.host?.userStopped !== true);
    if (running) {
      state.userStopped = true;
      await stopSession();
    } else {
      state.userStopped = false;
      await startSession();
    }
  }

  async function startSession() {
    setBusy(true);
    try {
      state.host = await api('/api/start', { method: 'POST' });
      resetConsole(state.host?.session?.sessionId || '');
      clearSelection();
      renderState();
      await refreshHierarchy();
      await refreshConsole();
      scheduleNativeEmbed(true);
    } catch (error) {
      showToast(error.message || String(error), true);
    } finally {
      setBusy(false);
      renderState();
    }
  }

  /** 停止当前运行，保留可查日志和草稿，清除已失效的运行节点树。 */
  async function stopSession() {
    setBusy(true);
    try {
      await refreshConsole();
      state.host = await api('/api/stop', { method: 'POST' });
      resetConsole('');
      state.hierarchy = null;
      renderTree();
      clearSelection();
      renderState();
    } catch (error) {
      showToast(error.message || String(error), true);
    } finally {
      setBusy(false);
      renderState();
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
        var selectionStillExists = reconcileSelection();
        renderTree();
        if (selectionStillExists && state.selectedNode && !hasPendingChanges()) {
          void selectNode(state.selectedNode, { preserveChanges: true });
        }
      }
      renderState();
    } catch (error) {
      if (!String(error.message).includes('NOT_READY')) showToast(error.message || String(error), true);
    } finally {
      state.polling = false;
    }
  }

  async function refreshSettings() {
    try {
      state.settings = await api('/api/simulator-settings');
      renderSettings();
    } catch (error) {
      if (state.host?.status === 'ready') showToast(error.message || String(error), true);
    }
  }

  /** 同步连接状态、控制台和操作可用性。 */
  function renderState() {
    var host = state.host || {};
    var runtime = host.runtime || {};
    var session = host.session || {};
    var nativeWindow = host.nativeWindow || {};
    var runtimeConnected = runtime.connected === true;
    var connected = runtimeConnected && host.status === 'ready';
    var embedded = nativeWindow.state === 'ready';
    var running = Boolean(session.sessionId)
      || host.status === 'ready'
      || (runtimeConnected && host.userStopped !== true);
    var busy = host.status === 'starting' || host.status === 'stopping' || state.settingsBusy;
    elements.connectionState.className = 'connection ' + (connected ? 'connected' : 'disconnected');
    elements.connectionState.innerHTML = '<span class="live-dot"></span>' + (
      host.status === 'starting' ? '正在启动'
        : host.status === 'stopping' ? '正在停止'
          : connected ? '模拟器已连接' : '模拟器未连接'
    );
    elements.liveState.className = 'live-state ' + (embedded ? 'connected' : '');
    elements.liveState.innerHTML = '<span class="live-dot"></span>' + (
      embedded ? '已嵌入' : connected ? '准备嵌入' : '等待连接'
    );
    elements.runtimeId.textContent = runtime.runtimeId || session.runtimeInstanceId || '—';
    elements.sceneEpoch.textContent = host.hierarchy?.sceneEpoch ?? state.hierarchy?.sceneEpoch ?? '—';
    elements.lastUpdated.textContent = formatTime(host.lastUpdateAt);
    elements.sceneName.textContent = state.hierarchy?.root?.name || '—';
    var size = session.actualResolution || currentDeviceSize();
    elements.resolution.textContent = size ? size.width + ' × ' + size.height : '—';
    elements.processName.textContent = 'SimulatorApp-Win32.exe · PID '
      + (session.appPid || nativeWindow.childProcessId || '—');
    elements.embedMeta.textContent = embedded
      ? (size ? size.width + ' × ' + size.height + ' · 可直接操作' : '原生窗口已嵌入')
      : nativeWindow.state === 'error' ? '嵌入失败' : '等待嵌入';
    elements.previewPlaceholder.classList.toggle('hidden', embedded);
    elements.treeMeta.textContent = (state.hierarchy?.nodeCount || 0) + ' 个节点' + (connected ? ' · 实时同步' : '');
    elements.treeMeta.title = 'revision ' + (state.hierarchy?.revision ?? '—');
    elements.startButton.disabled = busy;
    elements.startButton.textContent = host.status === 'starting'
      ? '正在启动…'
      : host.status === 'stopping' ? '正在停止…'
        : running ? '停止模拟器' : '启动模拟器';
    elements.startButton.className = running ? 'danger' : 'primary';
    elements.resolutionSelect.disabled = !state.settings || busy;
    elements.orientationSelect.disabled = !state.settings || busy;
    renderConsoleMeta();
    updateComponentToggle();
    if (host.error && host.error !== state.lastToast) showToast(host.error, true);
    if (nativeWindow.error && nativeWindow.error !== state.lastToast) showToast(nativeWindow.error, true);
    if (connected && session.sessionId && nativeWindow.state === 'idle') scheduleNativeEmbed(false);
    renderApplyState();
  }

  function renderSettings() {
    var settings = state.settings;
    if (!settings) return;
    elements.resolutionSelect.textContent = '';
    (settings.devices || []).forEach(function (device, index) {
      var option = document.createElement('option');
      option.value = String(index);
      option.textContent = device.name + ' (' + device.width + ' × ' + device.height + ')';
      elements.resolutionSelect.appendChild(option);
    });
    elements.resolutionSelect.value = String(settings.resolutionIndex);
    elements.orientationSelect.value = settings.orientation;
  }

  function currentDeviceSize() {
    var settings = state.settings;
    return settings?.devices?.[settings.resolutionIndex] || null;
  }

  function scheduleSettingsApply() {
    clearTimeout(state.settingsTimer);
    state.settingsTimer = setTimeout(function () { void applySettings(); }, 220);
  }

  async function applySettings() {
    if (!state.settings || state.settingsBusy) return;
    state.settingsBusy = true;
    renderState();
    try {
      var result = await api('/api/simulator-settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          resolutionIndex: Number(elements.resolutionSelect.value),
          orientation: elements.orientationSelect.value
        })
      });
      state.settings = result.settings;
      state.host = result.state;
      resetConsole(state.host?.session?.sessionId || '');
      state.hierarchy = null;
      clearSelection();
      renderSettings();
      renderState();
      await refreshHierarchy();
      scheduleNativeEmbed(true);
      showToast('模拟器显示设置已应用');
    } catch (error) {
      renderSettings();
      showToast(error.message || String(error), true);
    } finally {
      state.settingsBusy = false;
      renderState();
    }
  }

  function renderTree() {
    var root = state.hierarchy?.root;
    elements.treeView.textContent = '';
    if (!root) {
      elements.treeView.innerHTML = '<div class="empty-state">启动模拟器后显示真实运行节点</div>';
      return;
    }
    var query = elements.treeSearch.value.trim().toLowerCase();
    var fragment = document.createDocumentFragment();
    appendNode(root, 0, fragment, query);
    elements.treeView.appendChild(fragment);
  }

  function appendNode(node, depth, target, query) {
    if (query && !nodeMatches(node, query) && !(node.children || []).some(function childMatches(child) {
      return nodeOrDescendantMatches(child, query);
    })) return;
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
    return [node.name, node.uuid, node.path].some(function (value) {
      return String(value || '').toLowerCase().includes(query);
    });
  }

  function nodeOrDescendantMatches(node, query) {
    return nodeMatches(node, query) || (node.children || []).some(function (child) {
      return nodeOrDescendantMatches(child, query);
    });
  }

  function expandTreeToDepth(node, maxDepth, depth) {
    depth = depth || 0;
    if (!node || depth >= maxDepth || !(node.children || []).length) return;
    state.expanded.add(node.path);
    node.children.forEach(function (child) { expandTreeToDepth(child, maxDepth, depth + 1); });
  }

  /**
   * 读取并展示目标运行时节点的组件属性。
   *
   * @param node 运行时层级树中的目标节点。
   * @param options 可选保留未应用修改和组件折叠状态。
   * @param options.preserveChanges 重新读取时是否保留待应用值。
   */
  async function selectNode(node, options) {
    options = options || {};
    const sameNode = state.selectedPath === node.path;
    var preserveChanges = options.preserveChanges === true
      || (state.selectedPath === node.path && hasPendingChanges());
    if (!preserveChanges && state.selectedPath && state.selectedPath !== node.path && hasPendingChanges()) {
      showToast('请先应用或还原当前属性修改', true);
      return;
    }
    state.selectedNode = node;
    state.selectedPath = node.path || '';
    if (!preserveChanges) {
      state.pending.clear();
      state.invalid.clear();
    }
    state.components = [];
    updateSelectionHeader();
    renderTree();
    renderApplyState();
    if (!sameNode) elements.propertyView.innerHTML = '<div class="empty-state">正在读取组件属性</div>';
    var selectedPath = node.path;
    var results = await Promise.all([{ type: 'cc.Node' }].concat(node.components || []).map(async function (component) {
      try {
        return await api('/api/component?path=' + encodeURIComponent(selectedPath)
          + '&componentType=' + encodeURIComponent(component.type));
      } catch (error) {
        return { componentType: component.type, properties: {}, error: error.message || String(error) };
      }
    }));
    if (state.selectedPath !== node.path) return;
    var previousExpanded = preserveChanges ? new Set(state.componentExpanded) : null;
    state.components = results;
    state.componentExpanded.clear();
    results.forEach(function (component, index) {
      var key = componentKey(component, index);
      if (!previousExpanded || previousExpanded.has(key)) state.componentExpanded.add(key);
    });
    renderProperties();
  }

  function updateSelectionHeader() {
    var node = state.selectedNode;
    elements.selectionHeader.classList.toggle('empty', !node);
    elements.selectedName.textContent = node?.name
      || (state.selectedPath && hasPendingChanges() ? '节点已离开运行树' : '未选择节点');
    elements.selectedUuid.textContent = node?.uuid || '—';
    elements.selectedPath.textContent = node?.path || state.selectedPath || '—';
    if (!node) elements.selectionMeta.textContent = hasPendingChanges()
      ? '未应用修改已保留，可还原但不能应用'
      : '选择节点后显示可用属性';
  }

  /** 按原生属性描述更新组件区域，保留草稿及展开状态。 */
  function renderProperties() {
    const scrollTop = elements.propertyView.scrollTop;
    const openDetails = new Set();
    elements.propertyView.querySelectorAll('.property-row').forEach(function (row) {
      row.querySelectorAll('details').forEach(function (detail, index) {
        if (detail.open) openDetails.add(row.dataset.pendingKey + ':' + index);
      });
    });
    elements.propertyView.textContent = '';
    if (!state.components.length) {
      elements.propertyView.innerHTML = '<div class="empty-state">没有可读取的公开属性</div>';
      elements.selectionMeta.textContent = '没有可读取的公开属性';
      return;
    }
    var summary = summarizeComponents();
    elements.selectionMeta.textContent = summary.components + ' 个组件 · ' + summary.editable
      + ' 项可编辑 · ' + summary.readonly + ' 项只读';
    state.components.forEach(function (component, index) {
      elements.propertyView.appendChild(createComponentPanel(component, index));
    });
    // 后台层级刷新只更新属性快照，当前查看位置和数组展开状态保持不变。
    elements.propertyView.querySelectorAll('.property-row').forEach(function (row) {
      row.querySelectorAll('details').forEach(function (detail, index) {
        detail.open = openDetails.has(row.dataset.pendingKey + ':' + index);
      });
    });
    elements.propertyView.scrollTop = scrollTop;
    renderApplyState();
    updateComponentToggle();
  }

  /** 同步批量折叠按钮，保留组件的原生字段与未应用草稿。 */
  function updateComponentToggle() {
    elements.toggleComponentsButton.disabled = !state.components.length;
    elements.toggleComponentsButton.textContent = state.componentExpanded.size ? '全部折叠' : '全部展开';
  }

  /** 在已有组件展开状态上批量切换，不改变属性值或草稿。 */
  function toggleAllComponents() {
    if (state.componentExpanded.size) state.componentExpanded.clear();
    else state.components.forEach(function (component, index) { state.componentExpanded.add(componentKey(component, index)); });
    renderProperties();
  }

  function componentKey(component, index) {
    return String(component.componentType || component.type || 'component') + ':' + index;
  }

  function normalizedComponentType(type) {
    return String(type || '').replace(/^cc\./, '');
  }

  function componentDisplayName(type) {
    return normalizedComponentType(type) || '未知组件';
  }

  function propertyMetaFor(component, name, value) {
    var meta = component.propertyMeta && component.propertyMeta[name];
    if (meta && typeof meta === 'object') return meta;
    return { kind: 'unknown', editable: false, visible: false };
  }

  function summarizeComponents() {
    var summary = { components: 0, editable: 0, readonly: 0 };
    state.components.forEach(function (component) {
      if (component.error) return;
      if (component.componentType !== 'cc.Node') summary.components += 1;
      var names = visiblePropertyNames(component);
      names.forEach(function (name) {
        var meta = propertyMetaFor(component, name, component.properties?.[name]);
        if (meta.editable) summary.editable += 1; else summary.readonly += 1;
      });
    });
    return summary;
  }

  function createComponentPanel(component, index) {
    var type = component.componentType || component.type || '未知组件';
    var key = componentKey(component, index);
    var expanded = state.componentExpanded.has(key);
    var panel = document.createElement('section');
    panel.className = 'component-panel' + (expanded ? '' : ' collapsed')
      + (hasPendingForComponent(component, index) ? ' has-pending' : '');
    var title = document.createElement('div');
    title.className = 'component-title';
    title.tabIndex = 0;
    title.setAttribute('role', 'button');
    title.setAttribute('aria-expanded', String(expanded));
    var arrow = document.createElement('span');
    arrow.className = 'component-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = expanded ? '⌄' : '›';
    var icon = document.createElement('span');
    icon.className = 'component-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = normalizedComponentType(type).slice(0, 1).toUpperCase() || 'C';
    var heading = document.createElement('span');
    heading.className = 'component-heading';
    var displayName = componentDisplayName(type);
    var name = document.createElement('strong');
    name.textContent = displayName;
    heading.appendChild(name);
    title.title = type;
    title.append(arrow, icon, heading);
    var count = document.createElement('span');
    count.className = 'component-count';
    var properties = component.properties || {};
    var visibleNames = visiblePropertyNames(component);
    var editableCount = visibleNames.filter(function (property) {
      return propertyMetaFor(component, property, properties[property]).editable;
    }).length;
    count.textContent = editableCount + ' 可编辑 · ' + visibleNames.length + ' 项';
    if (component.showEnabled && typeof properties.enabled === 'boolean') {
      var enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.className = 'component-enabled';
      enabled.checked = properties.enabled;
      enabled.disabled = propertyMetaFor(component, 'enabled', properties.enabled).editable === false;
      enabled.title = '启用组件';
      enabled.setAttribute('aria-label', '启用 ' + type);
      enabled.addEventListener('click', function (event) { event.stopPropagation(); });
      enabled.addEventListener('change', function () {
        updatePending(component, index, 'enabled', enabled.checked, properties.enabled, panel, null, propertyMetaFor(component, 'enabled', properties.enabled));
      });
      title.appendChild(enabled);
    }
    title.appendChild(count);
    function toggle() {
      var nextExpanded = !state.componentExpanded.has(key);
      if (nextExpanded) state.componentExpanded.add(key);
      else state.componentExpanded.delete(key);
      panel.classList.toggle('collapsed', !nextExpanded);
      title.setAttribute('aria-expanded', String(nextExpanded));
      arrow.textContent = nextExpanded ? '⌄' : '›';
      updateComponentToggle();
    }
    title.addEventListener('click', toggle);
    title.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
    });
    panel.appendChild(title);
    var body = document.createElement('div');
    body.className = 'component-properties';
    if (component.error) {
      var error = document.createElement('div');
      error.className = 'empty-state';
      error.textContent = component.error;
      body.appendChild(error);
    } else if (!visibleNames.length) {
      body.appendChild(emptyPropertyRow());
    } else if (type === 'cc.Widget') {
      appendWidgetProperties(body, component, index);
    } else {
      appendPropertyGroups(body, component, index, visibleNames);
    }
    panel.appendChild(body);
    return panel;
  }

  function visiblePropertyNames(component) {
    var properties = component.properties || {};
    var names = Object.keys(properties).filter(function (name) {
      var meta = propertyMetaFor(component, name, properties[name]);
      return meta.visible === true;
    });
    if (component.componentType === 'cc.Widget') {
      var widgetNames = widgetPropertyNames(component, state.components.indexOf(component));
      names = names.filter(function (name) { return widgetNames.includes(name); });
    }
    return names.sort(function (left, right) {
      var leftMeta = propertyMetaFor(component, left, properties[left]);
      var rightMeta = propertyMetaFor(component, right, properties[right]);
      return (leftMeta.displayOrder ?? 0) - (rightMeta.displayOrder ?? 0);
    });
  }

  /** 按原生 group 信息组织折叠分组或分页；未分组的属性直接显示。 */
  function appendPropertyGroups(body, component, index, names) {
    var groups = new Map();
    var units = [];
    names.forEach(function (name) {
      var meta = propertyMetaFor(component, name);
      if (component.componentType === 'cc.Label' && ['isItalic', 'isUnderline'].includes(name)) return;
      var row = component.componentType === 'cc.Label' && name === 'isBold'
        ? createFontStyleRow(component, index)
        : createPropertyRow(component, index, name, component.properties[name], meta);
      if (!meta.group) { units.push({ order: meta.displayOrder, node: row }); return; }
      var info = meta.groupInfo || {};
      var id = (info.id || 'default') + ':' + (info.style === 'tab' ? 'tabs' : meta.group);
      var group = groups.get(id);
      if (!group) {
        var node = document.createElement(info.style === 'tab' ? 'div' : 'details');
        node.className = 'component-group';
        group = { node: node, tabs: new Map(), key: componentKey(component, index) + ':' + id };
        groups.set(id, group);
        units.push({ order: info.displayOrder ?? meta.displayOrder, node: node });
        if (info.style === 'tab') {
          group.header = document.createElement('div');
          group.header.className = 'property-tabs';
          group.header.setAttribute('role', 'tablist');
          node.appendChild(group.header);
        } else {
          node.open = true;
          var title = document.createElement('summary');
          title.className = 'component-group-title';
          title.textContent = meta.group;
          node.appendChild(title);
        }
      }
      if (info.style !== 'tab') { group.node.appendChild(row); return; }
      if (!group.tabs.has(meta.group)) {
        var content = document.createElement('div');
        content.setAttribute('role', 'tabpanel');
        var tab = document.createElement('button');
        tab.type = 'button';
        tab.setAttribute('role', 'tab');
        tab.textContent = meta.group;
        group.tabs.set(meta.group, { tab: tab, content: content });
        group.header.appendChild(tab);
        group.node.appendChild(content);
        tab.addEventListener('click', function () { state.groupTabs.set(group.key, meta.group); activateGroup(group); });
      }
      group.tabs.get(meta.group).content.appendChild(row);
    });
    units.sort(function (a, b) { return (a.order ?? 0) - (b.order ?? 0); }).forEach(function (unit) { body.appendChild(unit.node); });
    groups.forEach(function (group) { if (group.header) activateGroup(group); });
  }

  function activateGroup(group) {
    var active = state.groupTabs.get(group.key);
    if (!group.tabs.has(active)) active = group.tabs.keys().next().value;
    group.tabs.forEach(function (item, name) {
      item.content.hidden = name !== active;
      item.tab.setAttribute('aria-selected', String(name === active));
    });
  }

  function effectiveValue(component, index, name) {
    var draft = state.pending.get(pendingKey(component, index, name));
    return draft ? draft.value : component.properties[name];
  }

  /** 对应 Creator widget.js 的六个对齐绑定和 editor* 边距，原始比例值不重复显示。 */
  function widgetPropertyNames(component, index) {
    var names = ['target', 'alignMode'];
    ['Left', 'HorizontalCenter', 'Right', 'Top', 'VerticalCenter', 'Bottom'].forEach(function (side) {
      names.push('isAlign' + side);
      if (effectiveValue(component, index, 'isAlign' + side)) names.push('editor' + side, 'isAbsolute' + side);
    });
    return names;
  }

  /** 原生 Widget 面板将对齐旗标组合成互斥方向，并以 px/% 编辑 editor* 值。 */
  function appendWidgetProperties(body, component, index) {
    var properties = component.properties;
    function append(name, meta) {
      if (!component.propertyMeta[name]) return null;
      var row = createPropertyRow(component, index, name, properties[name], meta || component.propertyMeta[name]);
      body.appendChild(row);
      return row;
    }
    append('target');
    var diagram = document.createElement('div');
    diagram.className = 'widget-diagram';
    diagram.setAttribute('aria-label', 'Widget 对齐示意');
    var target = document.createElement('span');
    target.className = 'widget-target';
    ['Left', 'Right', 'Top', 'Bottom'].forEach(function (side) { target.dataset[side.toLowerCase()] = String(Boolean(effectiveValue(component, index, 'isAlign' + side))); });
    diagram.appendChild(target);
    body.appendChild(diagram);
    [
      { label: '水平对齐', sides: ['Left', 'HorizontalCenter', 'Right'], labels: ['不对齐', '左对齐', '居中', '右对齐', '拉伸'] },
      { label: '垂直对齐', sides: ['Top', 'VerticalCenter', 'Bottom'], labels: ['不对齐', '顶部', '居中', '底部', '拉伸'] }
    ].forEach(function (axis) {
      var row = document.createElement('div');
      row.className = 'property-row';
      var label = document.createElement('label');
      label.className = 'property-name';
      label.textContent = axis.label;
      var control = document.createElement('div');
      control.className = 'property-control';
      var first = effectiveValue(component, index, 'isAlign' + axis.sides[0]);
      var center = effectiveValue(component, index, 'isAlign' + axis.sides[1]);
      var last = effectiveValue(component, index, 'isAlign' + axis.sides[2]);
      var mode = first && last ? 4 : first ? 1 : last ? 3 : center ? 2 : 0;
      var select = enumEditor(mode, axis.labels.map(function (name, value) { return { name: name, value: value }; }), function (value) {
        var flags = [value === 1 || value === 4, value === 2, value === 3 || value === 4];
        axis.sides.forEach(function (side, position) {
          var name = 'isAlign' + side;
          updatePending(component, index, name, flags[position], properties[name], row, null, component.propertyMeta[name]);
        });
        renderProperties();
      });
      select.setAttribute('aria-label', axis.label);
      select.disabled = axis.sides.some(function (side) { return !component.propertyMeta['isAlign' + side]?.editable; });
      control.appendChild(select);
      row.append(label, control);
      body.appendChild(row);
    });
    ['Left', 'HorizontalCenter', 'Right', 'Top', 'VerticalCenter', 'Bottom'].forEach(function (side) {
      if (!effectiveValue(component, index, 'isAlign' + side)) return;
      var name = 'editor' + side;
      var unitName = 'isAbsolute' + side;
      var meta = Object.assign({}, component.propertyMeta[name], { displayName: side.replace(/Center$/, ' Center') });
      var row = append(name, meta);
      if (!row) return;
      var unit = document.createElement('button');
      unit.type = 'button';
      unit.className = 'widget-unit';
      unit.textContent = effectiveValue(component, index, unitName) ? 'px' : '%';
      unit.setAttribute('aria-label', side + ' 单位');
      unit.disabled = !component.propertyMeta[unitName]?.editable;
      unit.addEventListener('click', function () {
        var wasAbsolute = effectiveValue(component, index, unitName);
        var nextValue = effectiveValue(component, index, name) * (wasAbsolute ? 100 : 0.01);
        // 单位先于数值写入，保持原生 editor* getter/setter 的百分比换算。
        state.pending.delete(pendingKey(component, index, name));
        updatePending(component, index, unitName, !wasAbsolute, properties[unitName], row, null, component.propertyMeta[unitName]);
        updatePending(component, index, name, nextValue, properties[name], row, null, meta);
        renderProperties();
      });
      var control = row.querySelector('.property-control');
      control.classList.add('widget-margin');
      control.appendChild(unit);
    });
    append('alignMode');
  }

  /** 原生 Label 将粗体、斜体和下划线合并为同一行，草稿仍按实际属性独立保存。 */
  function createFontStyleRow(component, index) {
    var names = ['isBold', 'isItalic', 'isUnderline'];
    var row = document.createElement('div');
    var pending = names.some(function (name) { return state.pending.has(pendingKey(component, index, name)); });
    row.className = 'property-row' + (pending ? ' pending' : '');
    var label = document.createElement('span');
    label.className = 'property-name';
    label.textContent = '字体样式';
    var controls = document.createElement('div');
    controls.className = 'font-style-control';
    names.forEach(function (name, position) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = ['B', 'I', 'U'][position];
      button.setAttribute('aria-label', component.propertyMeta[name]?.displayName || name);
      button.setAttribute('aria-pressed', String(Boolean(effectiveValue(component, index, name))));
      button.disabled = !component.propertyMeta[name]?.editable;
      button.addEventListener('click', function () {
        updatePending(component, index, name, !effectiveValue(component, index, name), component.properties[name], row, null, component.propertyMeta[name]);
        renderProperties();
      });
      controls.appendChild(button);
    });
    var reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'property-reset';
    reset.textContent = '↶';
    reset.setAttribute('aria-label', '还原字体样式');
    reset.disabled = !pending;
    reset.addEventListener('click', function () {
      names.forEach(function (name) { state.pending.delete(pendingKey(component, index, name)); });
      if (!hasPendingChanges()) state.draftSessionId = '';
      renderProperties();
    });
    row.append(label, controls, reset);
    return row;
  }

  function hasPendingForComponent(component, index) {
    var prefix = componentKey(component, index) + '::';
    return Array.from(state.pending.keys()).some(function (key) { return key.startsWith(prefix); });
  }

  function createPropertyRow(component, index, name, value, meta) {
    var key = pendingKey(component, index, name);
    var pending = state.pending.get(key);
    var currentValue = pending ? pending.value : value;
    var row = document.createElement('div');
    row.className = 'property-row' + (pending ? ' pending' : '') + (state.invalid.has(key) ? ' invalid' : '');
    if (meta.kind === 'array' || meta.kind === 'object') row.classList.add('property-row-expanded');
    row.dataset.property = name;
    row.dataset.kind = meta.kind || 'unknown';
    row.dataset.component = component.componentType || component.type || '';
    row.dataset.pendingKey = key;
    var label = document.createElement('div');
    label.className = 'property-name';
    var labelText = document.createElement('span');
    labelText.textContent = meta.displayName || propertyLabel(name);
    label.appendChild(labelText);
    label.title = [name, meta.tooltip || '', meta.declaredType || ''].filter(Boolean).join('\n');
    var control = document.createElement('div');
    control.className = 'property-control';
    var editor = createEditor(component.componentType || component.type || '', name, currentValue, function (nextValue, errorMessage) {
      updatePending(component, index, name, nextValue, value, row, errorMessage, meta);
    }, meta);
    control.appendChild(editor.node);
    var error = document.createElement('div');
    error.className = 'property-error';
    error.textContent = pending?.error || state.invalid.get(key) || '';
    control.appendChild(error);
    var reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'property-reset';
    reset.textContent = '↶';
    reset.title = '还原此属性';
    reset.setAttribute('aria-label', '还原 ' + propertyLabel(meta.displayName || name));
    reset.disabled = !pending && !state.invalid.has(key);
    reset.hidden = !meta.editable;
    reset.addEventListener('click', function (event) {
      event.stopPropagation();
      state.pending.delete(key);
      state.invalid.delete(key);
      if (!hasPendingChanges()) state.draftSessionId = '';
      renderProperties();
      renderApplyState();
    });
    row.append(label, control, reset);
    return row;
  }

  function propertyLabel(name) {
    return String(name || '').replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/(^|\s)\S/g, function (value) { return value.toUpperCase(); }).trim();
  }

  function createEditor(componentType, name, value, onChange, meta) {
    if (!meta.editable && ['boolean', 'number', 'string', 'enum', 'bitmask', 'color', 'vector', 'size', 'rect'].includes(meta.kind)) {
      var readonly = createEditor(componentType, name, value, function () {}, Object.assign({}, meta, { editable: true }));
      [readonly.node].concat(Array.from(readonly.node.querySelectorAll('input, select, textarea, button'))).forEach(function (control) {
        if (control.matches('input, select, textarea, button')) control.disabled = true;
      });
      return readonly;
    }
    if (!meta.editable) return { node: readonlyEditor(value, meta, name) };
    if (value === null) return { node: readonlyValue('未设置') };
    if (typeof value === 'boolean') {
      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = value;
      checkbox.setAttribute('aria-label', '布尔值');
      checkbox.addEventListener('change', function () { onChange(checkbox.checked, null); });
      return { node: checkbox };
    }
    if (typeof value === 'number') {
      if (meta.kind === 'bitmask' && meta.enumOptions) return { node: bitmaskEditor(value, meta.enumOptions, onChange) };
      var enumOptions = meta.enumOptions;
      if (enumOptions) return { node: enumEditor(value, enumOptions, onChange) };
      var number = document.createElement('input');
      number.type = 'number';
      number.step = typeof meta.step === 'number' ? String(meta.step) : 'any';
      if (typeof meta.min === 'number') number.min = String(meta.min);
      if (typeof meta.max === 'number') number.max = String(meta.max);
      number.value = String(value);
      number.setAttribute('aria-label', '数字');
      function emitNumber() {
        var validation = validateNumberInput(number.value, meta, '数字');
        if (validation) {
          number.classList.add('invalid');
          onChange(null, validation);
          return;
        }
        var next = Number(number.value.trim());
        number.classList.remove('invalid');
        onChange(next, null);
      }
      number.addEventListener('input', emitNumber);
      number.addEventListener('change', emitNumber);
      return { node: number };
    }
    if (typeof value === 'string') {
      var text = document.createElement(value.includes('\n') || value.length > 120 ? 'textarea' : 'input');
      if (text.tagName === 'INPUT') text.type = 'text';
      text.value = value;
      text.setAttribute('aria-label', '字符串');
      text.addEventListener('input', function () { onChange(text.value, null); });
      return { node: text };
    }
    if (isReference(value)) return { node: referenceValue(value, name) };
    if (isRuntimeMarker(value)) return { node: readonlyValue(markerText(value)) };
    if (isColor(value)) return { node: colorEditor(value, onChange, meta) };
    if (isRect(value)) return { node: compoundEditor(value, ['x', 'y', 'width', 'height'], onChange, meta) };
    if (isSize(value)) return { node: compoundEditor(value, ['width', 'height'], onChange, meta) };
    if (isVector(value)) return { node: compoundEditor(value, vectorKeys(value), onChange, meta) };
    return { node: readonlyEditor(value, meta, name) };
  }

  function enumEditor(value, options, onChange) {
    var select = document.createElement('select');
    options.forEach(function (item) {
      var option = document.createElement('option');
      var optionValue = Array.isArray(item) ? item[0] : item.value;
      var optionName = Array.isArray(item) ? item[1] : item.name;
      option.value = String(optionValue);
      option.textContent = optionName;
      select.appendChild(option);
    });
    select.value = String(value);
    select.addEventListener('change', function () { onChange(Number(select.value), null); });
    return select;
  }

  /** 对应原生 BitMask 多选；使用无符号 32 位结果保留最高位与 ALL。 */
  function bitmaskEditor(value, options, onChange) {
    var node = document.createElement('details');
    node.className = 'property-details bitmask-control';
    var summary = document.createElement('summary');
    var current = value >>> 0;
    var checks = [];
    node.appendChild(summary);
    function refresh() {
      summary.textContent = options.filter(function (item) { var mask = item.value >>> 0; return mask && mask !== 4294967295 && ((current & mask) >>> 0) === mask; }).map(function (item) { return item.name; }).join(' | ') || String(current);
      checks.forEach(function (item) { item.input.checked = item.mask === 0 ? current === 0 : ((current & item.mask) >>> 0) === item.mask; });
    }
    options.forEach(function (item) {
      var label = document.createElement('label');
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('aria-label', item.name);
      var mask = item.value >>> 0;
      checks.push({ input: input, mask: mask });
      input.addEventListener('change', function () {
        current = mask === 0 ? 0 : input.checked ? ((current | mask) >>> 0) : ((current & ~mask) >>> 0);
        refresh();
        onChange(current, null);
      });
      label.append(input, document.createTextNode(item.name));
      node.appendChild(label);
    });
    refresh();
    return node;
  }

  function colorEditor(value, onChange, meta) {
    var wrapper = document.createElement('div');
    wrapper.className = 'color-control';
    var current = Object.assign({}, value);
    var swatch = document.createElement('input');
    swatch.type = 'color';
    swatch.value = rgbHex(current);
    swatch.title = '选择颜色';
    var fields = compoundEditor(current, ['r', 'g', 'b', 'a'], function (next, error) {
      if (error) {
        onChange(null, error);
        return;
      }
      current = next;
      swatch.value = rgbHex(current);
      onChange(Object.assign({}, current), null);
    }, meta, { min: 0, max: 255, step: 1 });
    swatch.addEventListener('input', function () {
      current.r = parseInt(swatch.value.slice(1, 3), 16);
      current.g = parseInt(swatch.value.slice(3, 5), 16);
      current.b = parseInt(swatch.value.slice(5, 7), 16);
      fields.querySelectorAll('input').forEach(function (input, index) {
        input.value = String(current[['r', 'g', 'b', 'a'][index]]);
      });
      if (typeof fields.setValue === 'function') fields.setValue(current);
      onChange(Object.assign({}, current), null);
    });
    wrapper.append(swatch, fields);
    return wrapper;
  }

  function rgbHex(value) {
    return '#' + ['r', 'g', 'b'].map(function (key) {
      return Math.max(0, Math.min(255, Math.round(value[key] || 0))).toString(16).padStart(2, '0');
    }).join('');
  }

  function readonlyEditor(value, meta, name) {
    if (meta.details) return readonlyDump(meta.details);
    if (meta.kind === 'reference') return referenceValue(value, meta.declaredType || name);
    if (Array.isArray(value)) {
      var arrayNode = readonlyValue('数组 · ' + value.length + ' 项');
      arrayNode.title = '运行时数组只读';
      return arrayNode;
    }
    if (value === null || value === undefined) return readonlyValue('未设置');
    if (isRuntimeMarker(value)) return readonlyValue(markerText(value));
    if (typeof value === 'object') return readonlyValue('对象（运行时只读）');
    return readonlyValue(String(value));
  }

  /** 原生 Dump 的数组、事件和对象可展开检查；每个成员仍保持只读。 */
  function readonlyDump(dump) {
    if (dump.kind === 'reference') return referenceValue(dump.value, dump.type);
    var value = dump.value;
    if (!value || typeof value !== 'object') return readonlyValue(value === null || value === undefined ? '未设置' : String(value));
    var wrapper = document.createElement('details');
    wrapper.className = 'property-details';
    var summary = document.createElement('summary');
    summary.textContent = dump.isArray ? '数组 · ' + (dump.total ?? value.length) + ' 项（只读）' : (dump.type || '对象') + '（只读）';
    wrapper.appendChild(summary);
    Object.entries(value).forEach(function (entry) {
      var child = entry[1];
      var row = document.createElement('div');
      row.className = 'property-detail-row';
      var label = document.createElement('span');
      label.textContent = dump.isArray ? '[' + entry[0] + ']' : child?.displayName || propertyLabel(entry[0]);
      row.appendChild(label);
      row.appendChild(child && typeof child === 'object' && 'type' in child ? readonlyDump(child) : readonlyValue(String(child ?? '未设置')));
      wrapper.appendChild(row);
    });
    if (dump.total > value.length) wrapper.appendChild(readonlyValue('仅展开前 ' + value.length + ' 项'));
    return wrapper;
  }

  function compoundEditor(value, keys, onChange, meta, defaults) {
    var wrapper = document.createElement('div');
    wrapper.className = 'compound-control';
    wrapper.style.gridTemplateColumns = 'repeat(' + Math.min(keys.length, 4) + ', minmax(0, 1fr))';
    var current = Object.assign({}, value);
    var invalidKeys = new Set();
    var inputs = Object.create(null);
    wrapper.setValue = function (nextValue) {
      current = Object.assign({}, nextValue);
      invalidKeys.clear();
      keys.forEach(function (key) {
        if (inputs[key]) {
          inputs[key].value = String(current[key] ?? 0);
          inputs[key].classList.remove('invalid');
        }
      });
    };
    keys.forEach(function (key) {
      var field = document.createElement('label');
      field.className = 'compound-field';
      var caption = document.createElement('span');
      caption.textContent = key;
      var input = document.createElement('input');
      input.type = 'number';
      applyNumberConstraints(input, meta, defaults);
      input.value = String(value[key] ?? 0);
      input.setAttribute('aria-label', key);
      inputs[key] = input;
      input.addEventListener('input', function () {
        var validation = validateNumberInput(input.value, meta, key, defaults);
        if (validation) {
          invalidKeys.add(key);
          input.classList.add('invalid');
          onChange(null, validation);
          return;
        }
        var next = Number(input.value.trim());
        invalidKeys.delete(key);
        input.classList.remove('invalid');
        current[key] = next;
        if (invalidKeys.size) {
          onChange(null, '请输入有效数字');
          return;
        }
        onChange(Object.assign({}, current), null);
      });
      field.append(caption, input);
      wrapper.appendChild(field);
    });
    return wrapper;
  }

  function vectorKeys(value) {
    if (Object.prototype.hasOwnProperty.call(value, 'w')) return ['x', 'y', 'z', 'w'];
    return Object.prototype.hasOwnProperty.call(value, 'z') ? ['x', 'y', 'z'] : ['x', 'y'];
  }

  function applyNumberConstraints(input, meta, defaults) {
    var constraints = Object.assign({}, defaults || {}, meta || {});
    input.step = typeof constraints.step === 'number' ? String(constraints.step) : 'any';
    if (typeof constraints.min === 'number') input.min = String(constraints.min);
    if (typeof constraints.max === 'number') input.max = String(constraints.max);
  }

  function validateNumberInput(rawValue, meta, label, defaults) {
    var raw = String(rawValue || '').trim();
    if (!raw) return '请输入 ' + label;
    var next = Number(raw);
    if (!Number.isFinite(next)) return '请输入有效数字';
    var constraints = Object.assign({}, defaults || {}, meta || {});
    if (typeof constraints.min === 'number' && next < constraints.min) return '不能小于 ' + constraints.min;
    if (typeof constraints.max === 'number' && next > constraints.max) return '不能大于 ' + constraints.max;
    if (typeof constraints.step === 'number' && constraints.step > 0) {
      var base = typeof constraints.min === 'number' ? constraints.min : 0;
      var distance = (next - base) / constraints.step;
      if (Math.abs(distance - Math.round(distance)) > 1e-7) return '必须按 ' + constraints.step + ' 递增';
    }
    return '';
  }

  function isColor(value) {
    return isObject(value) && ['r', 'g', 'b', 'a'].every(function (key) { return typeof value[key] === 'number' && Number.isFinite(value[key]); });
  }

  function isRect(value) {
    return isObject(value) && ['x', 'y', 'width', 'height'].every(function (key) { return typeof value[key] === 'number' && Number.isFinite(value[key]); });
  }

  function isSize(value) {
    return isObject(value) && ['width', 'height'].every(function (key) { return typeof value[key] === 'number' && Number.isFinite(value[key]); })
      && !Object.prototype.hasOwnProperty.call(value, 'x');
  }

  function isVector(value) {
    return isObject(value) && ['x', 'y'].every(function (key) { return typeof value[key] === 'number' && Number.isFinite(value[key]); })
      && Object.keys(value).every(function (key) { return ['x', 'y', 'z', 'w'].includes(key); });
  }

  function isReference(value) {
    return isObject(value) && ['node-reference', 'component-reference', 'asset-reference'].includes(value.__type);
  }

  function isRuntimeMarker(value) {
    return isObject(value) && ['circular-reference', 'max-depth-exceeded', 'complex-object', 'truncated', 'function', 'promise', 'undefined'].includes(value.__type);
  }

  function markerText(value) {
    if (value.__type === 'complex-object') return '复杂对象（' + (value.keys || 0) + ' 个字段）';
    if (value.__type === 'truncated') return '已截断（共 ' + (value.total || 0) + ' 项）';
    return value.__type || '运行时对象';
  }

  function referenceValue(value, propertyName) {
    var node = document.createElement('div');
    node.className = 'property-reference';
    var title = document.createElement('strong');
    if (!value || typeof value !== 'object') {
      title.textContent = '未设置';
      var empty = document.createElement('span');
      empty.textContent = propertyName || '运行时引用';
      node.append(title, empty);
      return node;
    }
    var label = {
      'node-reference': '节点',
      'component-reference': '组件',
      'asset-reference': '资源'
    }[value.__type] || propertyName || '引用';
    title.textContent = value.name || label;
    var uuid = document.createElement('span');
    uuid.textContent = value.uuid || value.objectUuid || (value.loaded === true ? '已加载' : '未设置');
    node.append(title, uuid);
    return node;
  }

  function readonlyValue(value) {
    var node = document.createElement('div');
    node.className = 'property-readonly';
    node.textContent = value;
    return node;
  }

  function emptyPropertyRow() {
    var row = document.createElement('div');
    row.className = 'empty-state';
    row.textContent = '没有可读取的公开属性';
    return row;
  }

  function pendingKey(component, index, name) {
    return componentKey(component, index) + '::' + name;
  }

  function valuesEqual(left, right) {
    try {
      return JSON.stringify(left) === JSON.stringify(right);
    } catch {
      return left === right;
    }
  }

  function conciseError(error) {
    var message = error && error.message ? error.message : String(error);
    if (message.includes('RUNTIME_PROPERTY_WRITE_FAILED')) return '运行时拒绝写入';
    if (message.includes('PROPERTY_WRITE_INPUT_INVALID')) return '写入参数无效';
    if (message.includes('WORKBENCH_SESSION_CHANGED')) return '运行会话已变化';
    return message.length > 120 ? message.slice(0, 117) + '…' : message;
  }

  function updatePending(component, index, name, value, original, row, errorMessage, meta) {
    var key = pendingKey(component, index, name);
    var error = row.querySelector('.property-error');
    if (errorMessage) {
      if (!state.draftSessionId) state.draftSessionId = currentSessionId();
      state.invalid.set(key, errorMessage);
      row.classList.add('invalid');
      if (error) error.textContent = errorMessage;
      var invalidReset = row.querySelector('.property-reset');
      if (invalidReset) invalidReset.disabled = false;
      renderApplyState();
      return;
    }
    var draftSessionId = state.draftSessionId || currentSessionId();
    state.invalid.delete(key);
    if (valuesEqual(value, original)) {
      state.pending.delete(key);
    } else {
      state.pending.set(key, {
        componentType: component.componentType || component.type || '',
        property: name,
        value: value,
        original: original,
        row: row,
        meta: meta,
        sessionId: draftSessionId
      });
    }
    if (!hasPendingChanges()) state.draftSessionId = '';
    row.classList.toggle('pending', state.pending.has(key));
    row.classList.remove('invalid');
    var panel = row.classList.contains('component-panel') ? row : row.closest('.component-panel');
    if (panel) panel.classList.toggle('has-pending', hasPendingForComponent(component, index));
    if (error) error.textContent = '';
    var reset = row.querySelector('.property-reset');
    if (reset) reset.disabled = !state.pending.has(key);
    renderApplyState();
  }

  function renderApplyState() {
    var pendingCount = state.pending.size;
    var invalidCount = state.invalid.size;
    var connected = state.host?.status === 'ready' && state.host?.runtime?.connected === true;
    var stale = hasStalePendingChanges();
    var targetAvailable = Boolean(state.selectedNode);
    elements.applyButton.disabled = pendingCount === 0 || invalidCount > 0 || !connected || stale || !targetAvailable;
    elements.applyButton.textContent = invalidCount > 0 ? '修正无效值'
      : pendingCount > 1 ? '应用 ' + pendingCount + ' 项并回读' : '应用并回读';
    elements.revertButton.disabled = pendingCount === 0 && invalidCount === 0;
    elements.applyStatus.textContent = invalidCount > 0
      ? invalidCount + ' 项输入无效，应用前请修正'
      : pendingCount > 0 && !connected ? '连接已断开，未应用修改已保留'
        : stale ? '运行会话已变化，未应用修改已保留'
          : pendingCount > 0 && !targetAvailable ? '目标节点已离开运行树，未应用修改已保留'
      : pendingCount > 0 ? pendingCount + ' 项修改尚未应用' : '与运行时一致';
  }

  async function applyPending() {
    if (!state.pending.size || state.invalid.size || !state.selectedPath) return;
    if (state.host?.status !== 'ready' || state.host?.runtime?.connected !== true) {
      showToast('运行连接已断开，重新连接后才能应用修改', true);
      return;
    }
    if (!state.selectedNode || hasStalePendingChanges()) {
      showToast('运行会话或目标节点已变化，请还原旧修改后重试', true);
      return;
    }
    var selectedPath = state.selectedPath;
    var selectedNode = state.selectedNode;
    var selectedSessionId = currentSessionId();
    elements.applyButton.disabled = true;
    var applied = 0;
    var normalized = 0;
    var failed = [];
    var entries = Array.from(state.pending.entries());
    for (var entry of entries) {
      if (state.selectedPath !== selectedPath || currentSessionId() !== selectedSessionId) break;
      var key = entry[0];
      var change = entry[1];
      try {
        var result = await api('/api/property', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: selectedSessionId,
            path: selectedPath,
            componentType: change.componentType,
            property: change.property,
            value: change.value
          })
        });
        if (!result || result.property !== change.property
          || !Object.prototype.hasOwnProperty.call(result, 'readback')) {
          throw new Error('应用后回读值不一致');
        }
        if (!valuesEqual(result.readback, change.value)) normalized += 1;
        state.pending.delete(key);
        state.invalid.delete(key);
        applied += 1;
      } catch (error) {
        change.error = conciseError(error);
        state.pending.set(key, change);
        failed.push(change.property + '：' + change.error);
      }
    }
    if (state.selectedPath === selectedPath && selectedNode) {
      await selectNode(selectedNode, { preserveChanges: true });
    }
    renderApplyState();
    if (failed.length) {
      showToast('已应用 ' + applied + ' 项，仍有 ' + failed.length + ' 项失败', true);
    } else if (normalized > 0) {
      showToast('已应用并回读，' + normalized + ' 项由引擎自动归一化');
    } else {
      showToast('运行时属性已写入并回读');
    }
  }

  function revertPending() {
    if (!state.pending.size && !state.invalid.size) return;
    state.pending.clear();
    state.invalid.clear();
    state.draftSessionId = '';
    renderProperties();
    renderApplyState();
    showToast('未应用的属性修改已还原');
  }

  function reconcileSelection() {
    if (!state.selectedPath) return false;
    var node = findNodeByPath(state.hierarchy?.root, state.selectedPath);
    if (node) {
      state.selectedNode = node;
      updateSelectionHeader();
      return true;
    }
    if (hasPendingChanges()) {
      state.selectedNode = null;
      updateSelectionHeader();
      showToast('当前节点已离开运行树，未应用修改仍保留', true);
      return false;
    }
    clearSelection({ discardChanges: true });
    return false;
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

  function clearSelection(options) {
    options = options || {};
    if (!options.discardChanges && hasPendingChanges()) return false;
    state.selectedPath = '';
    state.selectedNode = null;
    state.components = [];
    state.pending.clear();
    state.invalid.clear();
    state.draftSessionId = '';
    updateSelectionHeader();
    elements.propertyView.innerHTML = '<div class="empty-state">从左侧选择一个运行时节点</div>';
    renderApplyState();
    return true;
  }

  function hasPendingChanges() {
    return state.pending.size > 0 || state.invalid.size > 0;
  }

  function currentSessionId() {
    return state.host?.session?.sessionId || '';
  }

  function hasStalePendingChanges() {
    var sessionId = currentSessionId();
    return Boolean(state.draftSessionId && state.draftSessionId !== sessionId)
      || Array.from(state.pending.values()).some(function (change) {
      return Boolean(change.sessionId) && change.sessionId !== sessionId;
    });
  }

  function scheduleNativeEmbed(showErrors) {
    clearTimeout(state.nativeTimer);
    state.nativeTimer = setTimeout(function () { void embedNativeWindow(showErrors); }, showErrors ? 0 : 80);
  }

  async function embedNativeWindow(showErrors) {
    var sessionId = state.host?.session?.sessionId || '';
    if (!sessionId || state.host?.status !== 'ready' || state.nativeBusy) return;
    state.nativeBusy = true;
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
      renderState();
    }
  }

  function nativeWindowBounds() {
    var rect = elements.previewStage.getBoundingClientRect();
    var size = state.host?.session?.actualResolution || currentDeviceSize();
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

  /** 按会话与游标读取日志；清空或切换期间返回的旧响应不能重新显示。 */
  async function refreshConsole() {
    const sessionId = state.host?.session?.sessionId || '';
    if (!sessionId || state.host?.status !== 'ready' || state.consoleBusy) return;
    if (state.consoleSessionId !== sessionId) resetConsole(sessionId);
    const generation = state.consoleGeneration;
    state.consoleBusy = true;
    try {
      const result = await api('/api/console?sinceSeq=' + encodeURIComponent(String(state.consoleSeq)));
      if (state.consoleSessionId !== sessionId) return;
      if (typeof result.nextSeq === 'number') state.consoleSeq = Math.max(state.consoleSeq, result.nextSeq);
      if (generation !== state.consoleGeneration) return;
      if (result.entries?.length) {
        state.consoleEntries = state.consoleEntries.concat(result.entries).slice(-500);
        state.consoleCleared = false;
        renderConsole();
      } else renderConsoleMeta();
    } catch (error) {
      if (!String(error.message).includes('NOT_READY')) showToast(error.message || String(error), true);
    } finally {
      state.consoleBusy = false;
    }
  }

  /**
   * 新运行使用独立日志缓冲，停止时保留记录供定位问题。
   * @param sessionId 当前运行会话标识，空值表示已停止。
   */
  function resetConsole(sessionId) {
    if (state.consoleSessionId === (sessionId || '')) return;
    state.consoleSessionId = sessionId || '';
    state.consoleGeneration += 1;
    if (sessionId) {
      state.consoleSeq = 0;
      state.consoleEntries = [];
      state.consoleFollow = true;
      state.consoleCleared = false;
    }
    renderConsole();
  }

  /**
   * 组合日志级别与文本过滤，搜索范围包含错误堆栈。
   * @param entry 原始日志记录。
   * @param level 所选级别，info 同时包含普通 log。
   * @param query 用户输入的筛选文本。
   * @returns 当前记录是否匹配。
   */
  function consoleMatches(entry, level, query) {
    const matchesLevel = level === 'all' || entry.level === level || (level === 'info' && entry.level === 'log');
    return matchesLevel && (String(entry.text || '') + '\n' + String(entry.stack || '')).toLowerCase().includes(String(query || '').trim().toLowerCase());
  }

  /** 呈现最近日志；用户向上阅读时保持滚动位置，筛选不丢弃原始记录。 */
  function renderConsole() {
    const scrollTop = elements.consoleView.scrollTop;
    const expandedStacks = new Set(Array.from(elements.consoleView.querySelectorAll('.console-stack[open]')).map(function (stack) { return stack.dataset.seq; }));
    const entries = state.consoleEntries.filter(function (entry) {
      return consoleMatches(entry, elements.consoleLevel.value, elements.consoleSearch.value);
    });
    const fragment = document.createDocumentFragment();
    const levels = { log: '日志', info: '信息', warn: '警告', error: '错误', debug: '调试' };
    for (const entry of entries) {
      const level = levels[entry.level] ? entry.level : 'log';
      const line = document.createElement('div');
      line.className = 'console-line ' + level;
      const time = document.createElement('time');
      time.className = 'console-time';
      const date = new Date(entry.timestamp);
      time.textContent = Number.isNaN(date.valueOf()) ? '—' : date.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(date.getMilliseconds()).padStart(3, '0');
      time.title = entry.timestamp || '';
      const badge = document.createElement('span');
      badge.className = 'console-level';
      badge.textContent = levels[level];
      const content = document.createElement('div');
      content.className = 'console-content';
      const message = document.createElement('div');
      message.textContent = entry.text || '';
      content.appendChild(message);
      if (entry.stack) {
        const stack = document.createElement('details');
        stack.className = 'console-stack';
        stack.dataset.seq = String(entry.seq);
        stack.open = expandedStacks.has(String(entry.seq));
        const summary = document.createElement('summary');
        summary.textContent = '查看堆栈';
        const text = document.createElement('pre');
        text.textContent = entry.stack;
        stack.append(summary, text);
        content.appendChild(stack);
      }
      line.append(time, badge, content);
      fragment.appendChild(line);
    }
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'console-empty';
      empty.textContent = state.consoleEntries.length ? '没有匹配的日志，试试其他级别或关键词'
        : state.consoleCleared ? '日志已清空，新的输出会继续显示'
          : state.consoleSessionId ? '正在等待运行日志…' : '启动模拟器后，日志会实时显示在这里';
      fragment.appendChild(empty);
    }
    elements.consoleView.replaceChildren(fragment);
    elements.consoleView.scrollTop = state.consoleFollow ? elements.consoleView.scrollHeight : scrollTop;
    renderConsoleMeta();
  }

  /** 更新数量、筛选计数和跟随状态，不干扰正在阅读的日志内容。 */
  function renderConsoleMeta() {
    const count = state.consoleEntries.length;
    const connected = state.host?.status === 'ready' && state.host?.runtime?.connected === true && Boolean(state.consoleSessionId);
    elements.consoleMeta.textContent = (connected ? '实时' : count ? '已停止，记录已保留' : '等待运行') + (count ? ' · ' + count + ' 条' : '');
    elements.consoleMeta.title = elements.consoleMeta.textContent;
    const labels = { all: '全部', info: '日志与信息', warn: '警告', error: '错误', debug: '调试' };
    for (const option of elements.consoleLevel.options) {
      option.textContent = labels[option.value] + ' (' + state.consoleEntries.filter(function (entry) { return consoleMatches(entry, option.value, ''); }).length + ')';
    }
    elements.consoleFollowButton.setAttribute('aria-pressed', String(state.consoleFollow));
  }

  /** 清空当前视图并使在途旧响应失效，保留递增游标。 */
  function clearConsole() {
    state.consoleEntries = [];
    state.consoleGeneration += 1;
    state.consoleCleared = true;
    renderConsole();
  }

  function setBusy(value) {
    elements.startButton.disabled = value;
    elements.resolutionSelect.disabled = value || !state.settings;
    elements.orientationSelect.disabled = value || !state.settings;
  }

  function showToast(message, error) {
    clearTimeout(state.toastTimer);
    state.lastToast = String(message);
    elements.toast.textContent = message;
    elements.toast.className = 'toast visible' + (error ? ' error' : '');
    state.toastTimer = setTimeout(function () {
      elements.toast.className = 'toast';
      state.lastToast = '';
    }, 3500);
  }

  function formatTime(value) {
    if (!value) return '—';
    var date = new Date(value);
    return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleTimeString();
  }

  function isObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
  }

  /** 分隔条统一支持鼠标拖动和方向键调整，始终为预览保留可用空间。 */
  function installSplitters() {
    document.querySelectorAll('.splitter').forEach(function (splitter) {
      const kind = splitter.dataset.splitter;
      const vertical = kind === 'console';
      const property = vertical ? '--console-height' : kind === 'tree' ? '--tree-width' : '--inspector-width';
      const pane = vertical ? splitter.nextElementSibling : splitter.previousElementSibling;
      function limits() {
        const minimum = vertical ? 132 : kind === 'tree' ? 176 : 300;
        if (vertical) return { minimum: minimum, maximum: Math.max(minimum, splitter.parentElement.clientHeight - 220) };
        const otherPane = document.querySelector(kind === 'tree' ? '.inspector-pane' : '.tree-pane');
        const style = getComputedStyle(elements.workspace);
        const maximum = elements.workspace.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - otherPane.getBoundingClientRect().width - 292;
        return { minimum: minimum, maximum: Math.max(minimum, maximum) };
      }
      function updateRange(value) {
        const bounds = limits();
        splitter.setAttribute('aria-valuemin', String(bounds.minimum));
        splitter.setAttribute('aria-valuemax', String(Math.round(bounds.maximum)));
        splitter.setAttribute('aria-valuenow', String(Math.round(value)));
        splitter.setAttribute('aria-valuetext', Math.round(value) + ' 像素');
      }
      function applySize(value) {
        const bounds = limits();
        const size = Math.min(bounds.maximum, Math.max(bounds.minimum, value));
        document.documentElement.style.setProperty(property, size + 'px');
        updateRange(size);
      }
      const initialRect = pane.getBoundingClientRect();
      updateRange(vertical ? initialRect.height : initialRect.width);
      window.addEventListener('resize', function () {
        const rect = pane.getBoundingClientRect();
        updateRange(vertical ? rect.height : rect.width);
      });
      splitter.addEventListener('keydown', function (event) {
        const direction = vertical ? { ArrowUp: 1, ArrowDown: -1 } : { ArrowRight: 1, ArrowLeft: -1 };
        if (!direction[event.key]) return;
        event.preventDefault();
        const rect = pane.getBoundingClientRect();
        applySize((vertical ? rect.height : rect.width) + direction[event.key] * 16);
        scheduleNativeEmbed(false);
      });
      splitter.addEventListener('pointerdown', function (event) {
        if (event.button !== 0) return;
        event.preventDefault();
        const start = vertical ? event.clientY : event.clientX;
        const rect = pane.getBoundingClientRect();
        const initialSize = vertical ? rect.height : rect.width;
        splitter.classList.add('dragging');
        splitter.setPointerCapture(event.pointerId);
        function move(moveEvent) {
          const delta = (vertical ? moveEvent.clientY : moveEvent.clientX) - start;
          applySize(initialSize + (vertical ? -delta : delta));
        }
        function up() {
          splitter.classList.remove('dragging');
          splitter.removeEventListener('pointermove', move);
          splitter.removeEventListener('pointerup', up);
          splitter.removeEventListener('pointercancel', up);
          scheduleNativeEmbed(false);
        }
        splitter.addEventListener('pointermove', move);
        splitter.addEventListener('pointerup', up);
        splitter.addEventListener('pointercancel', up);
      });
    });
  }

  elements.startButton.addEventListener('click', function () { void toggleSession(); });
  elements.applyButton.addEventListener('click', function () { void applyPending(); });
  elements.revertButton.addEventListener('click', revertPending);
  elements.treeSearch.addEventListener('input', renderTree);
  elements.resolutionSelect.addEventListener('change', scheduleSettingsApply);
  elements.orientationSelect.addEventListener('change', scheduleSettingsApply);
  elements.clearConsoleButton.addEventListener('click', clearConsole);
  elements.consoleSearch.addEventListener('input', renderConsole);
  elements.consoleLevel.addEventListener('change', renderConsole);
  elements.consoleFollowButton.addEventListener('click', function () {
    state.consoleFollow = !state.consoleFollow;
    if (state.consoleFollow) elements.consoleView.scrollTop = elements.consoleView.scrollHeight;
    renderConsoleMeta();
  });
  elements.consoleView.addEventListener('scroll', function () {
    if (state.consoleFollow && elements.consoleView.scrollHeight - elements.consoleView.clientHeight - elements.consoleView.scrollTop > 24) {
      state.consoleFollow = false;
      renderConsoleMeta();
    }
  });
  elements.toggleComponentsButton.addEventListener('click', toggleAllComponents);
  new ResizeObserver(function () { scheduleNativeEmbed(false); }).observe(elements.previewStage);
  window.addEventListener('pagehide', function () {
    navigator.sendBeacon('/api/native-window/detach');
  });
  installSplitters();
  void refreshSettings();
  void refreshState().then(function () {
    if (!state.userStopped && state.host?.userStopped !== true && !state.autoStarting
      && state.host?.runtime?.connected === true && state.host.status !== 'ready') {
      state.autoStarting = true;
      void startSession().finally(function () { state.autoStarting = false; });
    }
  });
  setInterval(refreshState, 1000);
  setInterval(refreshHierarchy, 200);
  setInterval(refreshConsole, 500);
})();
