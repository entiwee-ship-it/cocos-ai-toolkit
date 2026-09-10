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
    consoleHasEntries: false,
    userStopped: false,
    autoStarting: false
  };

  var elements = Object.fromEntries([
    'connectionState', 'sceneName', 'resolution', 'startButton',
    'treeSearch', 'treeView', 'treeMeta', 'selectionHeader', 'selectedName', 'selectedUuid', 'selectedPath', 'selectionMeta',
    'propertyView', 'applyButton', 'revertButton', 'applyStatus', 'liveState', 'processName', 'previewStage', 'previewPlaceholder', 'embedMeta',
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

  function renderProperties() {
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
    renderApplyState();
  }

  function componentKey(component, index) {
    return String(component.componentType || component.type || 'component') + ':' + index;
  }

  function normalizedComponentType(type) {
    return String(type || '').replace(/^cc\./, '');
  }

  var COMPONENT_LABELS = {
    UITransform: 'UI 变换', UIOpacity: 'UI 不透明度', Widget: '布局对齐', Canvas: '画布',
    Sprite: '精灵', Label: '文本标签', RichText: '富文本', Button: '按钮', Toggle: '开关',
    ToggleContainer: '开关容器', Layout: '布局', Mask: '遮罩', ScrollView: '滚动视图',
    PageView: '分页视图', EditBox: '输入框', Slider: '滑块', ProgressBar: '进度条', Camera: '相机'
  };

  var COMPONENT_PROPERTY_ORDER = {
    UITransform: ['contentSize', 'anchorPoint', 'priority'],
    Widget: ['target', 'isAlignTop', 'isAlignBottom', 'isAlignLeft', 'isAlignRight',
      'isAlignVerticalCenter', 'isAlignHorizontalCenter', 'isStretchWidth', 'isStretchHeight',
      'top', 'bottom', 'left', 'right', 'horizontalCenter', 'verticalCenter', 'alignMode'],
    Sprite: ['spriteFrame', 'type', 'fillType', 'fillCenter', 'fillStart', 'fillRange', 'trim', 'grayscale', 'sizeMode', 'color'],
    Label: ['string', 'fontSize', 'lineHeight', 'horizontalAlign', 'verticalAlign', 'overflow', 'color'],
    Button: ['interactable', 'transition', 'duration', 'zoomScale', 'clickEvents'],
    Layout: ['type', 'resizeMode', 'spacingX', 'spacingY', 'cellSize', 'startAxis', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom']
  };

  var COMPONENT_PROPERTY_GROUPS = {
    UITransform: { contentSize: '尺寸', anchorPoint: '锚点', priority: '层级' },
    Widget: { target: '对齐', alignMode: '对齐', top: '边距', bottom: '边距', left: '边距', right: '边距',
      horizontalCenter: '边距', verticalCenter: '边距' },
    Sprite: { spriteFrame: '资源', type: '填充', fillType: '填充', fillCenter: '填充', fillStart: '填充',
      fillRange: '填充', trim: '外观', grayscale: '外观', sizeMode: '尺寸', color: '外观' },
    Label: { string: '文本', fontSize: '文本', lineHeight: '文本', horizontalAlign: '排版',
      verticalAlign: '排版', overflow: '排版', color: '外观' },
    Button: { interactable: '交互', transition: '交互', duration: '交互', zoomScale: '交互', clickEvents: '事件' },
    Layout: { type: '布局', resizeMode: '布局', spacingX: '间距', spacingY: '间距', cellSize: '布局',
      startAxis: '布局', paddingLeft: '边距', paddingRight: '边距', paddingTop: '边距', paddingBottom: '边距' }
  };

  var GROUP_ORDER = { 基本: 0, 尺寸: 10, 锚点: 20, 变换: 30, 布局: 40, 对齐: 50, 边距: 60, 资源: 70, 填充: 80, 外观: 90, 文本: 100, 排版: 110, 交互: 120, 事件: 130, 常规: 200 };
  var REFERENCE_PROPERTY_NAMES = new Set([
    'target', 'spriteFrame', 'spriteAtlas', 'font', 'labelAtlas', 'normalSprite',
    'pressedSprite', 'hoverSprite', 'disabledSprite', 'hoverSpriteFrame', 'customMaterial',
    'material', 'sharedMaterial', 'texture', 'clip', 'prefab'
  ]);
  var READONLY_REASON_LABELS = {
    'property-read-only': '只读', 'runtime-reference': '运行时引用', 'array-not-editable': '数组只读',
    'unsupported-value': '不支持编辑', 'invalid-number': '无效数值', hidden: '隐藏'
  };

  function componentDisplayName(type) {
    var normalized = normalizedComponentType(type);
    return COMPONENT_LABELS[normalized] || normalized || '未知组件';
  }

  function propertyMetaFor(component, name, value) {
    var meta = component.propertyMeta && component.propertyMeta[name];
    if (meta && typeof meta === 'object') return meta;
    return inferPropertyMeta(name, value);
  }

  function inferPropertyMeta(name, value) {
    var reference = REFERENCE_PROPERTY_NAMES.has(name) || isReference(value);
    var kind = reference ? 'reference'
      : value === null ? 'null'
        : Array.isArray(value) ? 'array'
          : typeof value;
    if (isColor(value)) kind = 'color';
    else if (isRect(value)) kind = 'rect';
    else if (isSize(value)) kind = 'size';
    else if (isVector(value)) kind = 'vector';
    var editable = !reference && ['boolean', 'number', 'string', 'color', 'rect', 'size', 'vector'].includes(kind);
    return {
      kind: kind,
      editable: editable,
      visible: true,
      ...(editable ? {} : { readOnlyReason: reference ? 'runtime-reference' : 'unsupported-value' })
    };
  }

  function summarizeComponents() {
    var summary = { components: 0, editable: 0, readonly: 0 };
    state.components.forEach(function (component) {
      if (component.error) return;
      summary.components += 1;
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
    var typeName = document.createElement('small');
    typeName.className = 'component-type';
    typeName.textContent = type;
    if (displayName === normalizedComponentType(type)) heading.append(name);
    else heading.append(name, typeName);
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
    if (typeof properties.enabled === 'boolean') {
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
    } else {
      groupVisibleProperties(component, visibleNames).forEach(function (group) {
        var groupNode = document.createElement('section');
        groupNode.className = 'component-group';
        var groupTitle = document.createElement('div');
        groupTitle.className = 'component-group-title';
        groupTitle.textContent = group.name;
        groupNode.appendChild(groupTitle);
        group.properties.forEach(function (property) {
          groupNode.appendChild(createPropertyRow(component, index, property, properties[property], propertyMetaFor(component, property, properties[property])));
        });
        body.appendChild(groupNode);
      });
    }
    panel.appendChild(body);
    return panel;
  }

  function visiblePropertyNames(component) {
    var properties = component.properties || {};
    var type = normalizedComponentType(component.componentType || component.type);
    var names = Object.keys(properties).filter(function (name) {
      return shouldShowProperty(name, properties[name], propertyMetaFor(component, name, properties[name]), type, properties);
    });
    var order = COMPONENT_PROPERTY_ORDER[type] || [];
    return names.sort(function (left, right) {
      var leftMeta = propertyMetaFor(component, left, properties[left]);
      var rightMeta = propertyMetaFor(component, right, properties[right]);
      var leftIndex = order.indexOf(left);
      var rightIndex = order.indexOf(right);
      var leftOrder = leftIndex >= 0 ? leftIndex : (typeof leftMeta.displayOrder === 'number' ? leftMeta.displayOrder : 10_000);
      var rightOrder = rightIndex >= 0 ? rightIndex : (typeof rightMeta.displayOrder === 'number' ? rightMeta.displayOrder : 10_000);
      return leftOrder - rightOrder || left.localeCompare(right);
    });
  }

  function shouldShowProperty(name, value, meta, componentType, properties) {
    if (meta && meta.declared === false) return false;
    if (name.startsWith('_') || name.startsWith('internal') || name.startsWith('editor')) return false;
    if ([
      'constructor', 'node', 'name', 'uuid', 'enabled', 'enabledInHierarchy', 'isValid', 'hideFlags',
      'renderData', 'materials', 'sharedMaterials', 'renderEntity', 'batchingHint', 'visibility',
      'cameraPriority', 'alignFlags', 'hash', 'localMat', 'customMaterial', 'material', 'sharedMaterial',
      'stencilStage', 'srcBlendFactor', 'useVertexOpacity', 'isStretchWidth', 'isStretchHeight'
    ].includes(name)) return false;
    if (componentType === 'Sprite' && name === 'priority') return false;
    if (componentType === 'Sprite' && name === 'trim' && properties.type !== 0) return false;
    if (componentType === 'Sprite' && ['fillType', 'fillCenter', 'fillStart', 'fillRange'].includes(name) && properties.type !== 3) return false;
    if (properties.contentSize && ['width', 'height'].includes(name)) return false;
    if (properties.anchorPoint && ['anchorX', 'anchorY'].includes(name)) return false;
    if (meta && meta.visible === false) return false;
    if (!REFERENCE_PROPERTY_NAMES.has(name) && containsRuntimeMarker(value)) return false;
    if (meta && ['undefined', 'function', 'object', 'circular-reference', 'max-depth-exceeded', 'complex-object', 'promise', 'truncated'].includes(meta.kind)) {
      return REFERENCE_PROPERTY_NAMES.has(name) && meta.kind === 'object';
    }
    if (value === null && !REFERENCE_PROPERTY_NAMES.has(name) && meta?.kind !== 'reference') return false;
    if (componentType && !typeMatchesReference(name, meta, value) && meta?.kind === 'unknown') return false;
    return true;
  }

  function typeMatchesReference(name, meta, value) {
    return REFERENCE_PROPERTY_NAMES.has(name) || meta?.kind === 'reference' || isReference(value);
  }

  function containsRuntimeMarker(value, depth) {
    depth = depth || 0;
    if (depth > 3 || value === null || value === undefined) return false;
    if (isRuntimeMarker(value)) return true;
    if (Array.isArray(value)) return value.some(function (item) { return containsRuntimeMarker(item, depth + 1); });
    if (isObject(value)) return Object.keys(value).some(function (key) { return containsRuntimeMarker(value[key], depth + 1); });
    return false;
  }

  function groupVisibleProperties(component, names) {
    var type = normalizedComponentType(component.componentType || component.type);
    var mapping = COMPONENT_PROPERTY_GROUPS[type] || {};
    var groups = Object.create(null);
    names.forEach(function (name) {
      var meta = propertyMetaFor(component, name, component.properties?.[name]);
      var group = meta.group || mapping[name] || inferPropertyGroup(name);
      if (!groups[group]) groups[group] = [];
      groups[group].push(name);
    });
    return Object.keys(groups).sort(function (left, right) {
      return (GROUP_ORDER[left] || 500) - (GROUP_ORDER[right] || 500) || left.localeCompare(right);
    }).map(function (name) { return { name: name, properties: groups[name] }; });
  }

  function inferPropertyGroup(name) {
    if (['contentSize', 'width', 'height', 'anchorPoint', 'anchorX', 'anchorY'].includes(name)) return '变换';
    if (['string', 'fontSize', 'lineHeight', 'fontFamily'].includes(name)) return '文本';
    if (['color', 'opacity', 'grayscale', 'trim', 'sizeMode'].includes(name)) return '外观';
    if (name.endsWith('Events')) return '事件';
    return '常规';
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
    row.dataset.property = name;
    row.dataset.component = component.componentType || component.type || '';
    row.dataset.pendingKey = key;
    var label = document.createElement('div');
    label.className = 'property-name';
    var labelText = document.createElement('span');
    labelText.textContent = propertyLabel(meta.displayName || name);
    var kind = document.createElement('small');
    kind.className = 'property-kind' + (meta.editable ? ' editable' : ' readonly');
    kind.textContent = meta.editable ? valueKindLabel(meta.kind) : (READONLY_REASON_LABELS[meta.readOnlyReason] || '只读');
    label.append(labelText, kind);
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
    paddingTop: '上内边距', paddingBottom: '下内边距', alignCanvasWithScreen: '画布跟随屏幕',
    clearFlag: '清除标志', renderMode: '渲染模式', camera: '相机', enableWrapText: '自动换行',
    useSystemFont: '系统字体', lineSpacing: '行间距', overflow: '溢出方式'
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
    var text = String(name || '').replace(/^i18n:[^.]*/, '').replace(/^.*\./, '').replace(/ForInspector$/, '');
    return PROPERTY_LABELS[text] || text.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  }

  function createEditor(componentType, name, value, onChange, meta) {
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
      var enumKey = normalizedComponentType(componentType) + '.' + name;
      var enumOptions = ENUM_OPTIONS[enumKey] || meta.enumOptions;
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

  function valueKindLabel(kind) {
    return {
      boolean: '布尔', number: '数值', string: '文本', enum: '枚举', color: '颜色', vector: '向量',
      size: '尺寸', rect: '矩形', reference: '引用', array: '数组', null: '空值'
    }[kind] || '属性';
  }

  function readonlyEditor(value, meta, name) {
    if (meta.kind === 'reference' || REFERENCE_PROPERTY_NAMES.has(name)) return referenceValue(value, name);
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
      empty.textContent = propertyName ? propertyLabel(propertyName) : '运行时引用';
      node.append(title, empty);
      return node;
    }
    var label = {
      'node-reference': '节点',
      'component-reference': '组件',
      'asset-reference': '资源'
    }[value.__type] || (propertyName ? propertyLabel(propertyName) : '引用');
    title.textContent = label + (value.name ? ' · ' + value.name : '');
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
  elements.revertButton.addEventListener('click', revertPending);
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
