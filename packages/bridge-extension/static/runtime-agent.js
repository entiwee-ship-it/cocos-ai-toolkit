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
    globalThis.__cocosAiSimulatorRuntimeAgent = {
      runtimeId: runtimeId,
      stop: function () { stopped = true; }
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
      } catch (_) {
        // Creator 或 Toolkit 暂不可用时静默重试，不影响游戏运行。
      }
      if (!stopped) setTimeout(poll, pollIntervalMs);
    }

    console.info('[CocosAI][Runtime] Creator Simulator runtime bridge ready', runtimeId);
    void poll();
  }).catch(function () {});
})();

