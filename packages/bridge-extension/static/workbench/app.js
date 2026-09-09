(function () {
  'use strict';

  var state = {
    host: null,
    hierarchy: null,
    selectedPath: '',
    selectedNode: null,
    components: [],
    expanded: new Set(),
    componentExpanded: new Set(),
    pending: new Map(),
    nativeTimer: 0,
    nativeBusy: false,
    polling: false,
    toastTimer: 0,
    lastToast: '',
    settings: null,
    settingsTimer: 0,
    settingsBusy: false,
    consoleSessionId: '',
    consoleSeq: 0,
    consoleBusy: false,
    consoleHasEntries: false,
    userStopped: false,
    autoStarting: false
  };

  var elements = Object.fromEntries([
    'connectionState', 'sceneName', 'resolution', 'startButton',
    'treeSearch', 'treeView', 'treeMeta', 'selectionHeader', 'selectedName', 'selectedUuid', 'selectedPath',
    'propertyView', 'applyButton', 'liveState', 'processName', 'previewStage', 'previewPlaceholder', 'embedMeta',
    'runtimeId', 'sceneEpoch', 'lastUpdated', 'workspace', 'toast', 'resolutionSelect', 'orientationSelect',
    'consoleMeta', 'consoleView', 'clearConsoleButton'
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
        void refreshSettings();
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

  async function stopSession() {
    setBusy(true);
    try {
      state.host = await api('/api/stop', { method: 'POST' });
      resetConsole('');
      state.hierarchy = null;
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

  async function refreshSettings() {
    try {
      state.settings = await api('/api/simulator-settings');
      renderSettings();
    } catch (error) {
      if (state.host?.status === 'ready') showToast(error.message || String(error), true);
    }
  }

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
    elements.treeMeta.textContent = (state.hierarchy?.nodeCount || 0) + ' 个节点 · revision ' + (state.hierarchy?.revision ?? '—');
    elements.startButton.disabled = busy;
    elements.startButton.textContent = host.status === 'starting'
      ? '正在启动…'
      : host.status === 'stopping' ? '正在停止…'
        : running ? '停止模拟器' : '启动模拟器';
    elements.startButton.className = running ? 'danger' : 'primary';
    elements.resolutionSelect.disabled = !state.settings || busy;
    elements.orientationSelect.disabled = !state.settings || busy;
    elements.consoleMeta.textContent = connected ? (state.consoleHasEntries ? '实时' : '暂无日志') : '等待运行';
    if (host.error && host.error !== state.lastToast) showToast(host.error, true);
    if (nativeWindow.error && nativeWindow.error !== state.lastToast) showToast(nativeWindow.error, true);
    if (connected && session.sessionId && nativeWindow.state === 'idle') scheduleNativeEmbed(false);
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

  async function selectNode(node) {
    state.selectedNode = node;
    state.selectedPath = node.path || '';
    state.pending.clear();
    state.components = [];
    updateSelectionHeader();
    renderTree();
    renderApplyState();
    if (!(node.components || []).length) {
      elements.propertyView.innerHTML = '<div class="empty-state">此运行时节点没有组件</div>';
      return;
    }
    elements.propertyView.innerHTML = '<div class="empty-state">正在读取组件属性</div>';
    var results = await Promise.all((node.components || []).map(async function (component) {
      try {
        return await api('/api/component?path=' + encodeURIComponent(state.selectedPath)
          + '&componentType=' + encodeURIComponent(component.type));
      } catch (error) {
        return { componentType: component.type, properties: {}, error: error.message || String(error) };
      }
    }));
    if (state.selectedPath !== node.path) return;
    state.components = results;
    state.componentExpanded.clear();
    results.forEach(function (component, index) {
      state.componentExpanded.add(componentKey(component, index));
    });
    renderProperties();
  }

  function updateSelectionHeader() {
    var node = state.selectedNode;
    elements.selectionHeader.classList.toggle('empty', !node);
    elements.selectedName.textContent = node?.name || '未选择节点';
    elements.selectedUuid.textContent = node?.uuid || '—';
    elements.selectedPath.textContent = node?.path || '—';
  }

  function renderProperties() {
    elements.propertyView.textContent = '';
    if (!state.components.length) {
      elements.propertyView.innerHTML = '<div class="empty-state">没有可读取的公开属性</div>';
      return;
    }
    state.components.forEach(function (component, index) {
      elements.propertyView.appendChild(createComponentPanel(component, index));
    });
  }

  function componentKey(component, index) {
    return String(component.componentType || component.type || 'component') + ':' + index;
  }

  function createComponentPanel(component, index) {
    var type = component.componentType || component.type || '未知组件';
    var key = componentKey(component, index);
    var expanded = state.componentExpanded.has(key);
    var panel = document.createElement('section');
    panel.className = 'component-panel' + (expanded ? '' : ' collapsed');
    var title = document.createElement('div');
    title.className = 'component-title';
    title.tabIndex = 0;
    title.setAttribute('role', 'button');
    title.setAttribute('aria-expanded', String(expanded));
    title.innerHTML = '<span aria-hidden="true">' + (expanded ? '⌄' : '›') + '</span>';
    var name = document.createElement('strong');
    name.textContent = type;
    var count = document.createElement('span');
    count.className = 'component-count';
    var properties = component.properties || {};
    var visibleNames = visiblePropertyNames(properties);
    count.textContent = visibleNames.length + ' 项';
    title.append(name);
    if (typeof properties.enabled === 'boolean') {
      var enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.className = 'component-enabled';
      enabled.checked = properties.enabled;
      enabled.title = '启用组件';
      enabled.setAttribute('aria-label', '启用 ' + type);
      enabled.addEventListener('click', function (event) { event.stopPropagation(); });
      enabled.addEventListener('change', function () {
        markPending(type, 'enabled', enabled.checked, panel);
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
      var arrow = title.querySelector('span');
      if (arrow) arrow.textContent = nextExpanded ? '⌄' : '›';
    }
    title.addEventListener('click', toggle);
    title.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
    });
    panel.appendChild(title);
    var body = document.createElement('div');
    body.className = 'component-properties';
    if (component.error) {
      body.innerHTML = '<div class="empty-state">' + escapeText(component.error) + '</div>';
    } else if (!visibleNames.length) {
      body.appendChild(emptyPropertyRow());
    } else {
      visibleNames.forEach(function (property) {
        body.appendChild(createPropertyRow(type, property, properties[property]));
      });
    }
    panel.appendChild(body);
    return panel;
  }

  function visiblePropertyNames(properties) {
    return Object.keys(properties).filter(function (name) {
      if (!shouldShowProperty(name)) return false;
      if (properties.contentSize && ['width', 'height'].includes(name)) return false;
      if (properties.anchorPoint && ['anchorX', 'anchorY'].includes(name)) return false;
      return true;
    });
  }

  function shouldShowProperty(name) {
    if (name.startsWith('_') || name.startsWith('internal') || name.startsWith('editor')) return false;
    return ![
      'constructor', 'node', 'name', 'uuid', 'enabled', 'enabledInHierarchy', 'isValid', 'hideFlags',
      'renderData', 'materials', 'sharedMaterials', 'renderEntity', 'batchingHint', 'visibility',
      'cameraPriority', 'alignFlags', 'hash', 'localMat', 'customMaterial'
    ].includes(name);
  }

  function createPropertyRow(componentType, name, value) {
    var row = document.createElement('div');
    row.className = 'property-row';
    row.dataset.property = name;
    row.dataset.component = componentType;
    var label = document.createElement('label');
    label.className = 'property-name';
    label.textContent = propertyLabel(name);
    label.title = name;
    var control = document.createElement('div');
    control.className = 'property-control';
    var editor = createEditor(componentType, name, value, function (nextValue) {
      markPending(componentType, name, nextValue, row);
    });
    control.appendChild(editor.node);
    row.append(label, control);
    return row;
  }

  var PROPERTY_LABELS = {
    contentSize: '内容尺寸', anchorPoint: '锚点', priority: '优先级', target: '目标节点',
    position: '位置', rotation: '旋转', scale: '缩放', color: '颜色', opacity: '不透明度',
    spriteFrame: '精灵帧', type: '类型', fillType: '填充类型', fillCenter: '填充中心',
    fillStart: '填充起点', fillRange: '填充范围', sizeMode: '尺寸模式', trim: '裁剪透明边缘',
    grayscale: '灰度', string: '文本', fontSize: '字体大小', lineHeight: '行高', fontFamily: '字体',
    horizontalAlign: '水平对齐', verticalAlign: '垂直对齐', overflow: '溢出方式',
    interactable: '可交互', transition: '过渡方式', duration: '过渡时长', zoomScale: '缩放比例',
    clickEvents: '点击事件', isAlignTop: '顶部对齐', isAlignBottom: '底部对齐',
    isAlignLeft: '左侧对齐', isAlignRight: '右侧对齐', isAlignVerticalCenter: '垂直居中',
    isAlignHorizontalCenter: '水平居中', isStretchWidth: '拉伸宽度', isStretchHeight: '拉伸高度',
    top: '顶部', bottom: '底部', left: '左侧', right: '右侧', horizontalCenter: '水平中心',
    verticalCenter: '垂直中心', alignMode: '对齐模式', isAbsoluteTop: '顶部使用像素',
    isAbsoluteBottom: '底部使用像素', isAbsoluteLeft: '左侧使用像素', isAbsoluteRight: '右侧使用像素',
    isAbsoluteHorizontalCenter: '水平中心使用像素', isAbsoluteVerticalCenter: '垂直中心使用像素',
    resizeMode: '尺寸调整', spacingX: '水平间距', spacingY: '垂直间距', cellSize: '单元尺寸',
    startAxis: '起始轴', paddingLeft: '左内边距', paddingRight: '右内边距',
    paddingTop: '上内边距', paddingBottom: '下内边距'
  };

  var ENUM_OPTIONS = {
    'Widget.alignMode': [[0, '仅一次'], [1, '窗口变化时'], [2, '始终']],
    'Sprite.type': [[0, '普通'], [1, '九宫格'], [2, '平铺'], [3, '填充']],
    'Sprite.fillType': [[0, '水平'], [1, '垂直'], [2, '扇形']],
    'Sprite.sizeMode': [[0, '自定义'], [1, '裁剪尺寸'], [2, '原始尺寸']],
    'Label.horizontalAlign': [[0, '左对齐'], [1, '居中'], [2, '右对齐']],
    'Label.verticalAlign': [[0, '顶部'], [1, '居中'], [2, '底部']],
    'Label.overflow': [[0, '不限制'], [1, '裁剪'], [2, '自动缩小'], [3, '自动增高']],
    'Button.transition': [[0, '无'], [1, '颜色'], [2, '精灵帧'], [3, '缩放']],
    'Layout.type': [[0, '无'], [1, '水平'], [2, '垂直'], [3, '网格']],
    'Layout.resizeMode': [[0, '不调整'], [1, '调整容器'], [2, '调整子节点']]
  };

  function propertyLabel(name) {
    return PROPERTY_LABELS[name] || name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  }

  function createEditor(componentType, name, value, onChange) {
    if (value === null) return { node: readonlyValue('空') };
    if (typeof value === 'boolean') {
      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = value;
      checkbox.setAttribute('aria-label', '布尔值');
      checkbox.addEventListener('change', function () { onChange(checkbox.checked); });
      return { node: checkbox };
    }
    if (typeof value === 'number') {
      var enumOptions = ENUM_OPTIONS[componentType.replace(/^cc\./, '') + '.' + name];
      if (enumOptions) return { node: enumEditor(value, enumOptions, onChange) };
      var number = document.createElement('input');
      number.type = 'number';
      number.step = 'any';
      number.value = String(value);
      number.setAttribute('aria-label', '数字');
      number.addEventListener('input', function () {
        var next = Number(number.value);
        if (Number.isFinite(next)) onChange(next);
      });
      return { node: number };
    }
    if (typeof value === 'string') {
      var text = document.createElement(value.includes('\n') || value.length > 120 ? 'textarea' : 'input');
      if (text.tagName === 'INPUT') text.type = 'text';
      text.value = value;
      text.setAttribute('aria-label', '字符串');
      text.addEventListener('input', function () { onChange(text.value); });
      return { node: text };
    }
    if (isReference(value)) return { node: referenceValue(value) };
    if (isRuntimeMarker(value)) return { node: readonlyValue(markerText(value)) };
    if (isColor(value)) return { node: colorEditor(value, onChange) };
    if (isRect(value)) return { node: compoundEditor(value, ['x', 'y', 'width', 'height'], onChange) };
    if (isSize(value)) return { node: compoundEditor(value, ['width', 'height'], onChange) };
    if (isVector(value)) return { node: compoundEditor(value, vectorKeys(value), onChange) };
    return { node: structuredValue(value) };
  }

  function enumEditor(value, options, onChange) {
    var select = document.createElement('select');
    options.forEach(function (item) {
      var option = document.createElement('option');
      option.value = String(item[0]);
      option.textContent = item[1];
      select.appendChild(option);
    });
    select.value = String(value);
    select.addEventListener('change', function () { onChange(Number(select.value)); });
    return select;
  }

  function colorEditor(value, onChange) {
    var wrapper = document.createElement('div');
    wrapper.className = 'color-control';
    var current = Object.assign({}, value);
    var swatch = document.createElement('input');
    swatch.type = 'color';
    swatch.value = rgbHex(current);
    swatch.title = '选择颜色';
    var fields = compoundEditor(current, ['r', 'g', 'b', 'a'], function (next) {
      current = next;
      swatch.value = rgbHex(current);
      onChange(Object.assign({}, current));
    });
    swatch.addEventListener('input', function () {
      current.r = parseInt(swatch.value.slice(1, 3), 16);
      current.g = parseInt(swatch.value.slice(3, 5), 16);
      current.b = parseInt(swatch.value.slice(5, 7), 16);
      fields.querySelectorAll('input').forEach(function (input, index) {
        input.value = String(current[['r', 'g', 'b', 'a'][index]]);
      });
      onChange(Object.assign({}, current));
    });
    wrapper.append(swatch, fields);
    return wrapper;
  }

  function rgbHex(value) {
    return '#' + ['r', 'g', 'b'].map(function (key) {
      return Math.max(0, Math.min(255, Math.round(value[key] || 0))).toString(16).padStart(2, '0');
    }).join('');
  }

  function structuredValue(value) {
    var details = document.createElement('details');
    details.className = 'structured-value';
    var summary = document.createElement('summary');
    summary.textContent = Array.isArray(value) ? '数组 · ' + value.length + ' 项' : '对象';
    var content = document.createElement('pre');
    content.textContent = JSON.stringify(value, null, 2);
    details.append(summary, content);
    return details;
  }

  function compoundEditor(value, keys, onChange) {
    var wrapper = document.createElement('div');
    wrapper.className = 'compound-control';
    var current = Object.assign({}, value);
    keys.forEach(function (key) {
      var field = document.createElement('label');
      field.className = 'compound-field';
      var caption = document.createElement('span');
      caption.textContent = key;
      var input = document.createElement('input');
      input.type = 'number';
      input.step = 'any';
      input.value = String(value[key] ?? 0);
      input.setAttribute('aria-label', key);
      input.addEventListener('input', function () {
        var next = Number(input.value);
        if (!Number.isFinite(next)) return;
        current[key] = next;
        onChange(Object.assign({}, current));
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

  function isColor(value) {
    return isObject(value) && ['r', 'g', 'b', 'a'].every(function (key) { return typeof value[key] === 'number'; });
  }

  function isRect(value) {
    return isObject(value) && ['x', 'y', 'width', 'height'].every(function (key) { return typeof value[key] === 'number'; });
  }

  function isSize(value) {
    return isObject(value) && ['width', 'height'].every(function (key) { return typeof value[key] === 'number'; })
      && !Object.prototype.hasOwnProperty.call(value, 'x');
  }

  function isVector(value) {
    return isObject(value) && ['x', 'y'].every(function (key) { return typeof value[key] === 'number'; })
      && Object.keys(value).every(function (key) { return ['x', 'y', 'z', 'w'].includes(key); });
  }

  function isReference(value) {
    return isObject(value) && ['node-reference', 'component-reference', 'asset-reference'].includes(value.__type);
  }

  function isRuntimeMarker(value) {
    return isObject(value) && ['circular-reference', 'max-depth-exceeded', 'complex-object', 'truncated', 'function'].includes(value.__type);
  }

  function markerText(value) {
    if (value.__type === 'complex-object') return '复杂对象（' + (value.keys || 0) + ' 个字段）';
    if (value.__type === 'truncated') return '已截断（共 ' + (value.total || 0) + ' 项）';
    return value.__type || '运行时对象';
  }

  function referenceValue(value) {
    var node = document.createElement('div');
    node.className = 'property-reference';
    var title = document.createElement('strong');
    var label = {
      'node-reference': '节点',
      'component-reference': '组件',
      'asset-reference': '资源'
    }[value.__type] || '引用';
    title.textContent = label + (value.name ? ' · ' + value.name : '');
    var uuid = document.createElement('span');
    uuid.textContent = value.uuid || value.objectUuid || '未解析';
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

  function markPending(componentType, name, value, row) {
    var key = componentType + '::' + name;
    state.pending.set(key, { componentType: componentType, property: name, value: value, row: row });
    row.classList.add('pending');
    renderApplyState();
  }

  function renderApplyState() {
    elements.applyButton.disabled = state.pending.size === 0;
    elements.applyButton.textContent = state.pending.size > 1
      ? '应用 ' + state.pending.size + ' 项并回读' : '应用并回读';
  }

  async function applyPending() {
    if (!state.pending.size || !state.selectedPath) return;
    elements.applyButton.disabled = true;
    try {
      var entries = Array.from(state.pending.entries());
      for (var entry of entries) {
        var change = entry[1];
        await api('/api/property', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            path: state.selectedPath,
            componentType: change.componentType,
            property: change.property,
            value: change.value
          })
        });
        state.pending.delete(entry[0]);
      }
      await selectNode(state.selectedNode);
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
    if (node) {
      state.selectedNode = node;
      updateSelectionHeader();
    } else clearSelection();
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
    state.components = [];
    state.pending.clear();
    updateSelectionHeader();
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

  async function refreshConsole() {
    var sessionId = state.host?.session?.sessionId || '';
    if (!sessionId || state.host?.status !== 'ready' || state.consoleBusy) return;
    if (state.consoleSessionId !== sessionId) resetConsole(sessionId);
    state.consoleBusy = true;
    try {
      var result = await api('/api/console?sinceSeq=' + encodeURIComponent(String(state.consoleSeq)));
      (result.entries || []).forEach(appendConsoleEntry);
      if (typeof result.nextSeq === 'number') state.consoleSeq = result.nextSeq;
    } catch (error) {
      if (!String(error.message).includes('NOT_READY')) showToast(error.message || String(error), true);
    } finally {
      state.consoleBusy = false;
    }
  }

  function resetConsole(sessionId) {
    state.consoleSessionId = sessionId || '';
    state.consoleSeq = 0;
    state.consoleHasEntries = false;
    elements.consoleView.textContent = '启动模拟器后显示调试输出';
    elements.consoleMeta.textContent = sessionId ? '读取中' : '等待运行';
  }

  function appendConsoleEntry(entry) {
    if (!state.consoleHasEntries) {
      elements.consoleView.textContent = '';
      state.consoleHasEntries = true;
    }
    var line = document.createElement('div');
    line.className = 'console-line ' + (entry.level || 'log');
    line.textContent = '[' + formatTime(entry.timestamp) + '] [' + (entry.level || 'log') + '] ' + (entry.text || '')
      + (entry.stack ? '\n' + entry.stack : '');
    elements.consoleView.appendChild(line);
    while (elements.consoleView.childElementCount > 500) elements.consoleView.firstElementChild.remove();
    elements.consoleView.scrollTop = elements.consoleView.scrollHeight;
  }

  function clearConsole() {
    state.consoleHasEntries = false;
    elements.consoleView.textContent = '日志已清空';
    elements.consoleMeta.textContent = state.consoleSessionId ? '实时' : '等待运行';
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

  function escapeText(value) {
    var element = document.createElement('span');
    element.textContent = String(value);
    return element.innerHTML;
  }

  function isObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
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
        var maximum = Math.max(minimum, elements.workspace.clientWidth - workspacePadding - otherPane.getBoundingClientRect().width - 390);
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
          scheduleNativeEmbed(false);
        }
        splitter.addEventListener('pointermove', move);
        splitter.addEventListener('pointerup', up);
      });
    });
  }

  elements.startButton.addEventListener('click', function () { void toggleSession(); });
  elements.applyButton.addEventListener('click', function () { void applyPending(); });
  elements.treeSearch.addEventListener('input', renderTree);
  elements.resolutionSelect.addEventListener('change', scheduleSettingsApply);
  elements.orientationSelect.addEventListener('change', scheduleSettingsApply);
  elements.clearConsoleButton.addEventListener('click', clearConsole);
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
