'use strict';

// 只封装本 CLI 使用的页面操作；不启用 Runtime 域或注入浏览器环境补丁。
const fs = require('fs');
const { EventEmitter } = require('events');
const { logger } = require('./util');
const { classifyRisk, isBossUrl } = require('./anticrawl');

class Connection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`CDP ${pending.method}：${message.error.message}`));
        else pending.resolve(message.result);
      } else this.emit('event', message.method, message.params, message.sessionId);
    });
    socket.addEventListener('close', () => {
      const error = new Error('Chrome 连接已关闭');
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      this.emit('closed', error);
    });
  }
  send(method, params = {}, sessionId, { timeout = 30000 } = {}) {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Chrome 连接已关闭'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时（${timeout}ms）`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, method, sessionId });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  rejectSession(sessionId, error) {
    for (const [id, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }
  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      this.socket.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.close();
    });
  }
}

class Context extends EventEmitter {
  constructor(connection, { accessGuard, offline = false } = {}) {
    super();
    this.connection = connection;
    this.accessGuard = accessGuard;
    this.offline = offline;
    this.ownedPages = new Map();
    this.attachingPages = new Map();
    this.timeout = 30000;
    this.navigationTimeout = 45000;
    this.listener = (method, params) => {
      if (method === 'Target.targetCreated' && params.targetInfo.type === 'page' &&
          this.ownedPages.has(params.targetInfo.openerId)) {
        if (this.riskError || this.offline) {
          connection.send('Target.closeTarget', { targetId: params.targetInfo.targetId }).catch(() => {});
        } else {
          this.attachPage(params.targetInfo).catch((error) => {
            connection.send('Target.closeTarget', { targetId: params.targetInfo.targetId }).catch(() => {});
            logger.warn(`无法连接新打开的页面：${error.message}`);
          });
        }
      }
      if (method === 'Target.targetDestroyed') {
        const page = this.ownedPages.get(params.targetId);
        if (page) page.dispose(new Error('Chrome 页面已关闭'));
        this.ownedPages.delete(params.targetId);
      }
      if (method === 'Target.detachedFromTarget') {
        const page = this.pages().find((item) => item.sessionId === params.sessionId);
        if (page) { page.dispose(new Error('Chrome 页面连接已断开')); this.ownedPages.delete(page.targetId); }
      }
    };
    connection.on('event', this.listener);
    connection.once('closed', (error) => {
      this.closed = true;
      for (const page of this.pages()) page.dispose(error);
      this.ownedPages.clear();
      connection.removeListener('event', this.listener);
      this.emit('closed', error);
    });
  }
  assertActive() {
    if (this.riskError) throw this.riskError;
    if (this.closed) throw new Error('Chrome 连接已关闭');
  }
  freeze(error) {
    if (this.riskError) return this.freezePromise;
    this.riskError = error;
    // 先拒绝业务等待，再阻断请求并停止加载。不得通过业务重试继续访问。
    const pages = this.pages();
    for (const page of pages) page.fail(error);
    this.freezePromise = Promise.all(pages.map(async (page) => {
      await page.blockNetwork();
      await page.extendLoadedRecovery();
    }));
    this.emit('risk', error);
    return this.freezePromise;
  }
  inspect(method, value) {
    if (!this.accessGuard || this.offline || this.riskError) return;
    try {
      const error = this.accessGuard[method](value);
      if (error) void this.freeze(error);
    } catch (error) { void this.freeze(error); }
  }
  async attachPage(info) {
    this.assertActive();
    if (this.ownedPages.has(info.targetId)) return this.ownedPages.get(info.targetId);
    if (this.attachingPages.has(info.targetId)) return this.attachingPages.get(info.targetId);
    const attaching = (async () => {
      const { sessionId } = await this.connection.send('Target.attachToTarget', { targetId: info.targetId, flatten: true });
      const page = new Page(this, info, sessionId);
      this.ownedPages.set(info.targetId, page);
      try {
        this.assertActive();
        await page.send('Network.enable');
        if (this.offline) await page.blockNetwork();
        await page.send('Page.enable');
        const { frameTree } = await page.send('Page.getFrameTree');
        page.currentUrl = frameTree.frame.url;
        page.mainFrameId = frameTree.frame.id;
        // 连接已有页面不是一次导航；下方只读检查风险，避免反复展示窗口被误计为跳转循环。
        this.assertActive();
        if (!this.offline && this.accessGuard && /^https?:/.test(page.currentUrl)) {
          try { await this.accessGuard.assertPage(page); }
          catch (error) { await this.freeze(error); throw error; }
        }
        return page;
      } catch (error) {
        await page.close().catch(() => {});
        throw error;
      }
    })();
    this.attachingPages.set(info.targetId, attaching);
    try { return await attaching; }
    finally { this.attachingPages.delete(info.targetId); }
  }
  async newPage() {
    this.assertActive();
    const { targetId } = await this.connection.send('Target.createTarget', { url: 'about:blank' });
    return this.attachPage({ targetId, url: 'about:blank' });
  }
  pages() { return [...this.ownedPages.values()]; }
  setDefaultTimeout(timeout) { this.timeout = timeout; }
  setDefaultNavigationTimeout(timeout) { this.navigationTimeout = timeout; }
  async cookies(urls) {
    const { cookies } = await this.connection.send('Storage.getCookies');
    const targets = (Array.isArray(urls) ? urls : urls ? [urls] : []).map((url) => new URL(url));
    return cookies.filter((cookie) => !targets.length || targets.some((url) => {
      const domain = cookie.domain.replace(/^\./, '');
      return (url.hostname === domain || cookie.domain.startsWith('.') && url.hostname.endsWith(`.${domain}`)) &&
        url.pathname.startsWith(cookie.path) && (!cookie.secure || url.protocol === 'https:');
    }));
  }
  async clearCookies() { await this.connection.send('Storage.clearCookies'); }
  async clearOriginStorage(origin) {
    // 该 Storage 方法需要 page session；空白页即可，不需要访问待清理站点。
    const page = this.pages().find((item) => !item.isClosed()) || await this.newPage();
    await page.send('Storage.clearDataForOrigin', { origin: new URL(origin).origin, storageTypes: 'all' });
  }
}

class Page extends EventEmitter {
  constructor(context, info, sessionId) {
    super();
    this.owner = context;
    this.targetId = info.targetId;
    this.sessionId = sessionId;
    this.currentUrl = info.url;
    this.closed = false;
    this.abortController = new AbortController();
    this.signal = this.abortController.signal;
    this.responses = new Map();
    this.requests = new Map();
    this.listener = (method, params, session) => {
      if (session !== this.sessionId) return;
      if (method === 'Page.frameNavigated' && !params.frame.parentId) {
        this.currentUrl = params.frame.url;
        this.mainFrameId = params.frame.id;
        this.lastLoaderId = params.frame.loaderId;
        this.owner.inspect('inspectNavigation', this.currentUrl);
      }
      if (method === 'Page.navigatedWithinDocument' && params.frameId === this.mainFrameId) this.currentUrl = params.url;
      if (this.terminalError) return;
      if (method === 'Network.requestWillBeSent') this.requests.set(params.requestId, params.request);
      if (method === 'Network.responseReceived') {
        let isBossAPI = false;
        try {
          const url = new URL(params.response.url);
          isBossAPI = (url.hostname === 'zhipin.com' || url.hostname.endsWith('.zhipin.com')) && url.pathname.startsWith('/wapi/');
        } catch (_) { /* 非 HTTP 地址不作接口响应检测 */ }
        if (params.type === 'Document' || isBossAPI) {
          this.owner.inspect('inspectResponse', {
            url: params.response.url, status: params.response.status, headers: params.response.headers,
          });
          if (this.terminalError) return;
        }
        const request = this.requests.get(params.requestId);
        const response = {
          url: () => params.response.url,
          status: () => params.response.status,
          request: () => ({ url: () => request?.url, method: () => request?.method, postData: () => request?.postData }),
          json: async () => {
            const result = await this.send('Network.getResponseBody', { requestId: params.requestId });
            return JSON.parse(result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body);
          },
        };
        this.responses.set(params.requestId, response);
        if (params.type === 'Document' && (!this.mainFrameId || params.frameId === this.mainFrameId)) this.navigationResponse = response;
      }
      if (method === 'Network.loadingFinished') {
        const response = this.responses.get(params.requestId);
        this.responses.delete(params.requestId);
        this.requests.delete(params.requestId);
        if (response) this.emit('response', response);
      }
      if (method === 'Network.loadingFailed') {
        this.responses.delete(params.requestId);
        this.requests.delete(params.requestId);
      }
      this.emit(method, params);
    };
    context.connection.on('event', this.listener);
    this.mouse = { wheel: (deltaX, deltaY) => this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 500, y: 350, deltaX, deltaY }) };
    this.keyboard = { press: async (key) => {
      const keys = { Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }, Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 } };
      if (!keys[key]) throw new Error(`暂不支持键盘操作：${key}`);
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...keys[key] });
      const { text, ...up } = keys[key];
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...up });
    } };
  }
  assertActive() {
    if (this.terminalError) throw this.terminalError;
    this.owner.assertActive();
    if (this.closed) throw new Error('Chrome 页面已关闭');
  }
  send(method, params) {
    try {
      this.assertActive();
      if (method.startsWith('Input.')) {
        if (this.owner.offline) throw new Error('离线上下文禁止页面交互');
        this.owner.accessGuard?.assertAllowed();
      }
    } catch (error) {
      if (!this.terminalError) void this.owner.freeze(error);
      return Promise.reject(error);
    }
    return this.owner.connection.send(method, params, this.sessionId);
  }
  fail(error) {
    if (this.terminalError) return;
    this.terminalError = error;
    this.abortController.abort(error);
    this.owner.connection.rejectSession(this.sessionId, error);
    this.emit('terminated', error);
  }
  async blockNetwork() {
    const stopped = await Promise.allSettled([
      this.owner.connection.send('Network.setBlockedURLs', { urls: ['*'] }, this.sessionId),
      this.owner.connection.send('Page.stopLoading', {}, this.sessionId),
    ]);
    const failed = stopped.find((result) => result.status === 'rejected');
    if (failed) {
      logger.debug(`停止页面访问失败，关闭该页面：${failed.reason.message}`);
      await this.close().catch((error) => logger.debug(`关闭受限页面：${error.message}`));
    }
  }
  async extendLoadedRecovery() {
    if (this.closed || this.owner.offline || !this.owner.accessGuard || !isBossUrl(this.url())) return;
    try {
      // 已阻网后只读现有 DOM；不等待页面变完整，不继续请求来获取恢复时间。
      const result = await this.owner.connection.send('Runtime.evaluate', {
        expression: 'document.body?.innerText.slice(0, 4000) || ""',
        returnByValue: true, awaitPromise: false,
      }, this.sessionId, { timeout: 500 });
      if (result.exceptionDetails) return;
      const risk = classifyRisk({ url: this.url(), text: result.result.value || '' });
      if (risk?.retryAt > 0) {
        const until = this.owner.accessGuard.recordRisk(risk, this.url()).retryAt;
        this.owner.riskError.retryAt = Math.max(this.owner.riskError.retryAt || 0, until);
      }
    } catch (error) {
      // 不可读或无法更新磁盘时仍保持原有冻结与冷却，不降低暂停时长。
      logger.debug(`未补充页面恢复时间：${error.message}`);
    }
  }
  untilTerminated(operation) {
    try { this.assertActive(); }
    catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const stopped = (error) => { this.removeListener('terminated', stopped); reject(error); };
      this.once('terminated', stopped);
      Promise.resolve(operation).then((value) => {
        this.removeListener('terminated', stopped);
        try { this.assertActive(); resolve(value); } catch (error) { reject(error); }
      }, (error) => { this.removeListener('terminated', stopped); reject(error); });
    });
  }
  eventWait(event, { predicate = () => true, timeout = this.owner.timeout, description = event } = {}) {
    let cancel;
    const promise = new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.removeListener(event, handler);
        this.removeListener('terminated', stopped);
        if (error) reject(error); else resolve(value);
      };
      const stopped = (error) => finish(error);
      const handler = async (value) => {
        try { if (await predicate(value)) finish(null, value); }
        catch (error) { finish(error); }
      };
      cancel = () => finish();
      try { this.assertActive(); } catch (error) { finish(error); return; }
      this.on(event, handler);
      this.once('terminated', stopped);
      timer = setTimeout(() => finish(new Error(`${description}超时（${timeout}ms）`)), timeout);
    });
    // 调用者可能仍在等待 Page.navigate 的 CDP 回包。
    promise.catch(() => {});
    return { promise, cancel };
  }
  url() { return this.currentUrl; }
  context() { return this.owner; }
  isClosed() { return this.closed; }
  async evaluate(fn, arg) {
    const expression = typeof fn === 'function' ? `(${fn.toString()})(${JSON.stringify(arg) ?? 'undefined'})` : String(fn);
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  async goto(url, { timeout = this.owner.navigationTimeout, waitUntil = 'domcontentloaded' } = {}) {
    if (!['domcontentloaded', 'load', 'commit'].includes(waitUntil)) throw new Error(`不支持导航等待模式：${waitUntil}`);
    this.assertActive();
    if (this.owner.offline && /^https?:/i.test(url)) throw new Error('离线上下文禁止网络导航');
    if (this.owner.accessGuard && !this.owner.offline) {
      try { await this.untilTerminated(this.owner.accessGuard.beforeNavigation(url, { signal: this.signal })); }
      catch (error) { await this.owner.freeze(error); throw error; }
    }
    this.assertActive();
    const loaded = this.eventWait(waitUntil === 'load' ? 'Page.loadEventFired' : 'Page.domContentEventFired', { timeout, description: `页面导航：${url}` });
    this.navigationResponse = null;
    try {
      const result = await this.send('Page.navigate', { url });
      if (result.errorText) throw new Error(`页面导航失败：${result.errorText}`);
      if (result.loaderId && waitUntil !== 'commit') await loaded.promise;
      this.assertActive();
      if (waitUntil !== 'commit' && this.owner.accessGuard && !this.owner.offline) {
        try { await this.owner.accessGuard.assertPage(this); }
        catch (error) { await this.owner.freeze(error); throw error; }
      }
      return this.navigationResponse;
    } catch (error) {
      // 超时或 CDP 失败后，已提交的导航仍可能继续加载；明确停止，避免后台重复请求。
      this.fail(error);
      await this.blockNetwork();
      throw error;
    } finally { loaded.cancel(); }
  }
  locator(selector) { return new Locator(this, selector); }
  async waitForSelector(selector, { state = 'visible', timeout = this.owner.timeout } = {}) {
    const locator = this.locator(selector).first();
    const deadline = Date.now() + timeout;
    do {
      try {
        const count = await locator.count();
        const matched = state === 'attached' ? count > 0 : state === 'detached' ? count === 0 :
          state === 'hidden' ? !count || !(await locator.isVisible()) : count > 0 && await locator.isVisible();
        if (matched) return state === 'hidden' || state === 'detached' ? null : locator;
      } catch (error) {
        if (!/Cannot find context|Execution context was destroyed|元素不存在/.test(error.message)) throw error;
      }
      await this.waitForTimeout(100);
    } while (Date.now() < deadline);
    throw new Error(`等待元素超时（${timeout}ms）：${selector}`);
  }
  waitForTimeout(ms) {
    return new Promise((resolve, reject) => {
      let timer;
      const stopped = (error) => { clearTimeout(timer); this.removeListener('terminated', stopped); reject(error); };
      try { this.assertActive(); } catch (error) { reject(error); return; }
      this.once('terminated', stopped);
      timer = setTimeout(() => { this.removeListener('terminated', stopped); resolve(); }, ms);
    });
  }
  waitForResponse(predicate, { timeout = this.owner.timeout } = {}) {
    return this.eventWait('response', {
      predicate: typeof predicate === 'string' ? (response) => response.url() === predicate : predicate,
      timeout, description: '等待页面响应',
    }).promise;
  }
  async screenshot({ fullPage = false, path: outputPath, clip } = {}) {
    if (fullPage && !clip) {
      const { cssContentSize } = await this.send('Page.getLayoutMetrics');
      clip = { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 };
    }
    // 普通元素裁剪使用现有 viewport。Chrome 的超视口捕获会临时 resize，可能触发页面响应式逻辑。
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: Boolean(fullPage), ...(clip ? { clip } : {}) });
    const buffer = Buffer.from(data, 'base64');
    if (outputPath) fs.writeFileSync(outputPath, buffer, { mode: 0o600 });
    return buffer;
  }
  dispose(error = new Error('Chrome 页面已关闭')) {
    this.fail(error);
    this.closed = true;
    this.owner.connection.removeListener('event', this.listener);
    this.responses.clear();
    this.requests.clear();
    this.removeAllListeners();
  }
  async close() {
    if (this.closed) return;
    this.dispose();
    this.owner.ownedPages.delete(this.targetId);
    await this.owner.connection.send('Target.closeTarget', { targetId: this.targetId });
  }
}

class Locator {
  constructor(page, selector, index = null) { this.page = page; this.selector = selector; this.index = index; }
  first() { return new Locator(this.page, this.selector, 0); }
  nth(index) { return new Locator(this.page, this.selector, index); }
  count() { return this.page.evaluate(({ selector, index }) => index === null ? document.querySelectorAll(selector).length : Number(Boolean(document.querySelectorAll(selector)[index])), { selector: this.selector, index: this.index }); }
  async evaluate(fn, arg) {
    const expression = `(() => { const el = document.querySelectorAll(${JSON.stringify(this.selector)})[${this.index ?? 0}]; if (!el) throw new Error('元素不存在'); return (${fn.toString()})(el, ${JSON.stringify(arg) ?? 'undefined'}); })()`;
    return this.page.evaluate(expression);
  }
  isVisible() { return this.evaluate((el) => { const rect = el.getBoundingClientRect(); const style = getComputedStyle(el); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.display !== 'none'; }); }
  textContent() { return this.evaluate((el) => el.textContent); }
  innerText() { return this.evaluate((el) => el.innerText); }
  getAttribute(name) { return this.evaluate((el, attr) => el.getAttribute(attr), name); }
  scrollIntoViewIfNeeded() { return this.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' })); }
  async point() {
    await this.scrollIntoViewIfNeeded();
    return this.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height || el.disabled) throw new Error('目标元素不可交互');
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      const target = document.elementFromPoint(x, y);
      if (!target || !(target === el || el.contains(target))) throw new Error('目标元素被遮挡，未执行点击');
      return { x, y };
    });
  }
  async hover() { await this.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...await this.point() }); }
  async click() {
    const point = await this.point();
    await this.page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await this.page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  }
  async type(text, { delay = 0 } = {}) {
    await this.evaluate((el) => { if (el.disabled || el.readOnly) throw new Error('输入框不可编辑'); el.focus(); });
    for (const char of String(text)) {
      await this.page.send('Input.insertText', { text: char });
      if (delay) await this.page.waitForTimeout(delay);
    }
  }
  async fill(text) {
    await this.evaluate((el) => {
      if (el.disabled || el.readOnly) throw new Error('输入框不可编辑');
      el.focus();
      if (el.isContentEditable) { const range = document.createRange(); range.selectNodeContents(el); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); }
      else if (typeof el.select === 'function') el.select();
      else throw new Error('目标不是可编辑输入框');
    });
    if (String(text)) await this.page.send('Input.insertText', { text: String(text) });
    else {
      await this.page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await this.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    }
  }
  async screenshot(options = {}) {
    await this.scrollIntoViewIfNeeded();
    const clip = await this.evaluate((el) => { const rect = el.getBoundingClientRect(); return { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height, scale: 1 }; });
    return this.page.screenshot({ ...options, fullPage: false, clip });
  }
}

async function connectBrowser(endpoint, options = {}) {
  if (typeof WebSocket === 'undefined') throw new Error('原生 CDP 需要 Node.js 22 或更新版本。');
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('连接 Chrome WebSocket 超时')); }, 10000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连接 Chrome WebSocket 失败')); }, { once: true });
  });
  const connection = new Connection(socket);
  const context = new Context(connection, options);
  try { await connection.send('Target.setDiscoverTargets', { discover: true }); }
  catch (error) { await connection.close(); throw error; }
  return {
    contexts: () => [context],
    isConnected: () => socket.readyState === WebSocket.OPEN,
    newBrowserCDPSession: async () => connection,
    close: () => connection.close(),
  };
}

module.exports = { connectBrowser };
