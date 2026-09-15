(function () {
  'use strict';
  if (globalThis.__cocosAiSimulatorRuntimeAgent) return;

  void System.import('cc').then(function (cc) {
    var config = cc.settings && cc.settings.querySettings
      ? cc.settings.querySettings('plugins', 'cocosAiRuntime')
      : null;
    if (!config || typeof config.baseUrl !== 'string') return;

    var runtimeId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    var stopped = false;
    var pollIntervalMs = Number(config.pollIntervalMs) > 0 ? Number(config.pollIntervalMs) : 50;
    const consoleEntries = [];
    const consoleMethods = [];
    let consoleSequence = 0;

    function isSensitiveKey(key) {
      const normalized = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
      return /(?:authorization|password|passwd|passcode|credentials?|secret|token|apikey|privatekey|cookie|setcookie)$/.test(normalized);
    }

    function redactText(value) {
      return String(value)
        .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, function (match) {
          return match.slice(0, match.indexOf(' ') + 1) + '[REDACTED]';
        })
        .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\b/g, '[REDACTED]')
        .replace(/([?&](?:access_token|refresh_token|id_token|auth_token|session_token|token|password|passwd|passcode|secret|api_key|apikey)=)[^&#\s]*/gi, '$1[REDACTED]')
        .replace(/("(?:authorization|password|passwd|passcode|credentials?|(?:access|refresh|id|auth|session)?_?token|client_?secret|api_?key|private_?key|cookie|set-cookie)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"');
    }

    /**
     * 将日志参数保存为有界快照，避免递归遍历整棵 Cocos 对象图或执行 getter。
     * @param value 当前参数或字段值。
     * @param depth 已遍历的对象层数。
     * @param parents 当前递归路径，用于识别循环引用。
     * @returns 可安全序列化的参数摘要。
     */
    function previewValue(value, depth, parents) {
      if (value === null || typeof value !== 'object') {
        if (typeof value === 'string') return redactText(value);
        return typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol' ? String(value) : value;
      }
      if (value instanceof Error) return redactText(value);
      if (parents.includes(value)) return '[Circular]';
      if (depth >= 3) return Array.isArray(value) ? '[Array]' : '[Object]';
      const result = Array.isArray(value) ? [] : Object.create(null);
      const keys = Object.keys(value);
      for (const key of keys.slice(0, 20)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        const preview = isSensitiveKey(key) ? '[REDACTED]' : descriptor && 'value' in descriptor
          ? previewValue(descriptor.value, depth + 1, parents.concat([value])) : '[Getter]';
        if (Array.isArray(result)) result.push(preview);
        else result[key] = preview;
      }
      if (keys.length > 20) result[Array.isArray(result) ? result.length : '…'] = '[' + (keys.length - 20) + ' more]';
      return result;
    }

    /**
     * 按 console 占位符生成纯文本，保留对象摘要并消费仅用于浏览器着色的 %c 参数。
     * @param args 原始日志参数。
     * @returns 可读的日志正文。
     */
    function formatConsole(args) {
      function formatValue(value) {
        if (value instanceof Error) return redactText(value);
        return value && typeof value === 'object' ? JSON.stringify(previewValue(value, 0, [])) : redactText(value);
      }
      if (!args.length) return '';
      let index = 1;
      let text = formatValue(args[0]);
      if (typeof args[0] === 'string' && args.length > 1) {
        text = args[0].replace(/%[%sdifoOc]/g, function (token) {
          if (token === '%%') return '%';
          if (index >= args.length) return token;
          const value = args[index++];
          if (token === '%c') return '';
          if (token === '%d' || token === '%i') return String(parseInt(value, 10));
          if (token === '%f') return String(parseFloat(value));
          return formatValue(value);
        });
      }
      return redactText([text, args.slice(index).map(formatValue).join(' ')].filter(Boolean).join(' '));
    }

    /**
     * 缓存真实发生时间与错误堆栈；采集失败不影响原生输出。
     * @param level console 原始级别。
     * @param args 原始输出参数。
     */
    function captureConsole(level, args) {
      if (stopped) return;
      try {
        const error = args.find(function (value) { return value instanceof Error; });
        // Creator 的 jsb.onError 传入 location/message/stack；源码片段里的 %c 等字符不是日志格式串。
        const nativeException = level === 'error' && args.length === 3
          && args.every(function (value) { return typeof value === 'string'; })
          && /(?:^|\n)\s*at\s/.test(args[2]);
        const stack = error && error.stack ? error.stack : nativeException ? args[0] + '\n' + args[2] : '';
        consoleEntries.push({
          seq: consoleSequence++, level: level,
          text: redactText(nativeException ? args[1] : formatConsole(args.slice(0, 20))).slice(0, 4000),
          timestamp: new Date().toISOString(),
          ...(stack ? { stack: redactText(stack).slice(0, 4000) } : {})
        });
        // ponytail: 最近 500 条缓冲；单次最多读取 100 条，避免日志突发超过现有 HTTP 消息上限。
        if (consoleEntries.length > 500) consoleEntries.shift();
      } catch (_) {
        // Proxy、异常对象或自定义格式化错误不能打断游戏原本的日志调用。
      }
    }

    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
      const original = console[level];
      if (typeof original !== 'function') continue;
      const wrapped = function () {
        captureConsole(level, Array.prototype.slice.call(arguments));
        return original.apply(console, arguments);
      };
      consoleMethods.push({ level: level, original: original, wrapped: wrapped });
      console[level] = wrapped;
    }
    // Creator 3.8.x 原生 application.js 使用 INFO。插件加载时引擎已缓存 console，按相同级别重新绑定。
    cc._resetDebugSetting(cc.DebugMode.INFO);
    globalThis.__cocosAiSimulatorRuntimeAgent = {
      runtimeId: runtimeId,
      readConsole: function (sinceSeq) {
        const entries = consoleEntries.filter(function (entry) { return entry.seq >= sinceSeq; }).slice(0, 100);
        return { entries: entries, nextSeq: entries.length ? entries[entries.length - 1].seq + 1 : consoleSequence };
      },
      stop: function () {
        stopped = true;
        for (const method of consoleMethods) {
          if (console[method.level] === method.wrapped) console[method.level] = method.original;
        }
      }
    };

    function request(method, path, body) {
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open(method, config.baseUrl + path, true);
        xhr.timeout = 5000;
        if (body !== undefined) xhr.setRequestHeader('content-type', 'application/json');
        xhr.onload = function () {
          if (xhr.status === 204) return resolve(null);
          if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(xhr.responseText || ('HTTP_' + xhr.status)));
          try {
            resolve(xhr.responseText ? JSON.parse(xhr.responseText) : null);
          } catch (error) {
            reject(error);
          }
        };
        xhr.onerror = function () { reject(new Error('RUNTIME_HTTP_UNAVAILABLE')); };
        xhr.ontimeout = function () { reject(new Error('RUNTIME_HTTP_TIMEOUT')); };
        xhr.send(body === undefined ? null : JSON.stringify(body));
      });
    }

    async function poll() {
      if (stopped) return;
      var nextDelay = pollIntervalMs;
      try {
        var command = await request('GET', '/command?runtimeId=' + encodeURIComponent(runtimeId));
        if (command && typeof command.expression === 'string') {
          try {
            var value = (0, eval)(command.expression);
            if (value && typeof value.then === 'function') value = await value;
            await request('POST', '/result', { id: command.id, runtimeId: runtimeId, ok: true, value: value });
          } catch (error) {
            await request('POST', '/result', {
              id: command.id,
              runtimeId: runtimeId,
              ok: false,
              error: error && error.stack ? String(error.stack).slice(0, 8000) : String(error)
            }).catch(function () {});
          }
        }
        nextDelay = 0;
      } catch (_) {
        // Creator 或 Toolkit 暂不可用时静默重试，不影响游戏运行。
      }
      if (!stopped) setTimeout(poll, nextDelay);
    }

    console.info('[CocosAI] 模拟器运行代理已就绪，日志采集已开启', runtimeId);
    void poll();
  }).catch(function () {});
})();
