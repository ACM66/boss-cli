'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const { randomUUID } = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { connectBrowser } = require('./cdp');
const { AccessGuard, isBossUrl } = require('./anticrawl');
const { ROOT_DIR, USER_DATA_DIR } = require('./config');
const { logger, sleep } = require('./util');

const STATE_FILE = path.join(ROOT_DIR, 'browser.json');
const LOCK_FILE = path.join(ROOT_DIR, 'browser.lock.json');

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`无法读取浏览器状态 ${file}：${error.message}`);
  }
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function acquireLock() {
  fs.mkdirSync(ROOT_DIR, { recursive: true, mode: 0o700 });
  const owner = { pid: process.pid, token: randomUUID() };
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = fs.openSync(LOCK_FILE, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(owner));
      fs.closeSync(fd);
      fd = undefined;
      return () => {
        if (readJSON(LOCK_FILE)?.token === owner.token) fs.unlinkSync(LOCK_FILE);
      };
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      if (error.code !== 'EEXIST') throw error;
      const existing = readJSON(LOCK_FILE);
      if (!existing || !Number.isInteger(existing.pid) || !existing.token) {
        throw new Error(`浏览器命令锁不完整：${LOCK_FILE}。确认没有 boss 命令运行后再移除该文件。`);
      }
      if (isAlive(existing.pid)) {
        throw new Error(`另一个 boss 命令正在使用浏览器（PID ${existing.pid}），请等待它结束。`);
      }
      if (readJSON(LOCK_FILE)?.token === existing.token) fs.unlinkSync(LOCK_FILE);
    }
  }
  throw new Error('浏览器命令锁发生竞争，请稍后重试。');
}

function chromeExecutable() {
  const candidates = process.env.BOSS_CHROME_PATH ? [process.env.BOSS_CHROME_PATH] : (
    process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] :
      process.platform === 'win32' ? [
        path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
      ] : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  );
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_) { /* 继续检查下一处安装路径 */ }
  }
  throw new Error('未找到 Google Chrome。请安装 Chrome，或将 BOSS_CHROME_PATH 设置为浏览器可执行文件的绝对路径。');
}

function verifyBrowserOwner(state) {
  if (state.version !== 1 || state.userDataDir !== USER_DATA_DIR ||
      !Number.isInteger(state.port) || state.port < 1 || state.port > 65535 || !isAlive(state.pid)) {
    throw new Error(`浏览器状态无效或进程已退出：${STATE_FILE}`);
  }
  let command;
  try {
    command = process.platform === 'win32'
      ? execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId = ${state.pid}").CommandLine`], { encoding: 'utf8', timeout: 5000 })
      : execFileSync('ps', ['-p', String(state.pid), '-o', 'command='], { encoding: 'utf8', timeout: 5000 });
  } catch (error) {
    throw new Error(`无法验证浏览器 PID ${state.pid} 的归属：${error.message}`);
  }
  // 参数必须与专用 profile 和调试端口同时匹配；绝不按任意可达端口接管浏览器。
  const hasArg = (value) => command.includes(`${value} `) || command.includes(`${value}"`) || command.trimEnd().endsWith(value);
  if (!/chrome|chromium/i.test(command) || !hasArg(`--user-data-dir=${USER_DATA_DIR}`) ||
      !hasArg(`--remote-debugging-port=${state.port}`)) {
    throw new Error(`PID ${state.pid} 与 boss 专用浏览器配置不匹配，拒绝连接；请检查 ${STATE_FILE}。`);
  }
  return command;
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function discoverEndpoint(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error(`Chrome 调试接口返回 HTTP ${response.status}`);
  const data = await response.json();
  const endpoint = new URL(data.webSocketDebuggerUrl);
  if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || Number(endpoint.port) !== port ||
      !endpoint.pathname.startsWith('/devtools/browser/')) {
    throw new Error('Chrome 调试接口返回了不匹配的 WebSocket 地址');
  }
  return endpoint.href;
}

async function stopChild(child) {
  const exited = () => !child.pid || child.exitCode !== null || child.signalCode !== null;
  for (const [signal, timeout] of [[null, 3000], ['SIGTERM', 2000], ['SIGKILL', 2000]]) {
    if (exited()) return;
    if (signal) child.kill(signal);
    const deadline = Date.now() + timeout;
    while (!exited() && Date.now() < deadline) await sleep(50);
  }
  if (!exited()) throw new Error(`Chrome PID ${child.pid} 未退出，profile 可能仍被占用。`);
}

// 原生 Chrome 自行启动，CDP 仅连接现有上下文，保留浏览器真实的默认环境。
async function openContext({ headless = false, offline = false, requireVisible = false } = {}) {
  if (headless && requireVisible) throw new Error('打开网页需要可见 Chrome，不能使用无头模式。');
  const accessGuard = new AccessGuard({ rootDir: ROOT_DIR });
  // 冷却检查先于进程启动和 CDP 连接；离线退出登录只允许本地 Cookie 操作。
  if (!offline) accessGuard.assertAllowed();
  const releaseLock = acquireLock();
  let child;
  let browser;
  let state;
  let closing;
  const signalHandlers = new Map();
  const close = (keepOpen = false) => {
    if (closing) return closing;
    if (keepOpen) {
      if (offline) throw new Error('离线清理上下文不能交给用户继续浏览。');
      browser?.contexts()[0].assertActive();
      accessGuard.assertAllowed();
    }
    closing = (async () => {
      let handedOff = false;
      try {
        if (browser?.isConnected()) {
          await browser.contexts()[0].freezePromise;
          if (keepOpen) {
            browser.contexts()[0].assertActive();
            accessGuard.assertAllowed();
          } else if (child) {
            try {
              const session = await browser.newBrowserCDPSession();
              await session.send('Browser.close');
            } catch (error) {
              logger.debug(`Chrome 关闭连接：${error.message}`);
            }
          } else {
            await Promise.all(browser.contexts()[0].pages().map((page) => page.close().catch((error) => logger.debug(`关闭命令页面失败：${error.message}`))));
          }
          // CDP 连接的 Browser.close() 只断开连接；复用的登录窗口保持打开。
          await browser.close();
          if (keepOpen) {
            if (browser.isConnected()) throw new Error('未能断开自动化连接，未完成窗口交接。');
            handedOff = true;
          }
        } else if (keepOpen) {
          throw new Error('浏览器连接已断开，无法确认窗口交接。');
        }
      } finally {
        try {
          if (child) {
            if (handedOff) child.unref();
            else {
              await stopChild(child);
              if (child.pid && readJSON(STATE_FILE)?.pid === child.pid) fs.unlinkSync(STATE_FILE);
            }
          }
        } finally {
          for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
          releaseLock();
        }
      }
    })();
    return closing;
  };
  for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const handler = () => close().catch((error) => logger.error(error.message)).finally(() => process.exit(exitCode));
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  try {
    state = readJSON(STATE_FILE);
    if (state && !isAlive(state.pid)) {
      fs.unlinkSync(STATE_FILE);
      state = null;
    }
    if (state) {
      const command = verifyBrowserOwner(state);
      if (requireVisible && /(?:^|\s)--headless(?:[=\s]|$)/.test(command)) throw new Error('专用 Chrome 当前为无头模式，不能显示窗口。请先结束该实例，再运行 boss open；不会切换到其他浏览器。');
      logger.debug(`复用 boss 专用 Chrome（PID ${state.pid}），保留当前显示模式和已有窗口`);
    } else {
      // 未登记的 profile 进程不能安全复用；不删除 Chrome 的锁或会话恢复文件。
      try {
        fs.lstatSync(path.join(USER_DATA_DIR, 'SingletonLock'));
        throw new Error('boss 专用 Chrome profile 已被占用但没有有效连接记录。请关闭该 Chrome 后重试。');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const executable = chromeExecutable();
      const port = await availablePort();
      fs.mkdirSync(USER_DATA_DIR, { recursive: true, mode: 0o700 });
      child = spawn(executable, [
        `--user-data-dir=${USER_DATA_DIR}`,
        '--remote-debugging-address=127.0.0.1',
        `--remote-debugging-port=${port}`,
        '--no-first-run', '--no-default-browser-check',
        ...(headless ? ['--headless=new'] : []),
        'about:blank',
      ], { stdio: ['ignore', 'ignore', 'ignore'], detached: true });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      state = { version: 1, pid: child.pid, port, userDataDir: USER_DATA_DIR };
      fs.writeFileSync(STATE_FILE, JSON.stringify(state), { mode: 0o600 });
      logger.debug(`启动 boss 专用 Chrome（PID ${child.pid}，${headless ? '无头' : '有头'}）`);
    }
    let endpoint;
    let lastError;
    const deadline = Date.now() + (child ? 15000 : 2000);
    do {
      if (child && (child.exitCode !== null || child.signalCode !== null)) {
        throw new Error(`Chrome 启动后退出（code=${child.exitCode}, signal=${child.signalCode}），请检查 profile 是否被占用。`);
      }
      try {
        // 每次从 HTTP 重新发现；DevToolsActivePort 中的旧 WS 路径可能已经失效。
        endpoint = await discoverEndpoint(state.port);
        break;
      } catch (error) {
        lastError = error;
        await sleep(150);
      }
    } while (Date.now() < deadline);
    if (!endpoint) throw new Error(`无法连接 boss Chrome 调试端口 ${state.port}：${lastError?.message}`);
    verifyBrowserOwner(state);
    if (!offline) accessGuard.assertAllowed();
    browser = await connectBrowser(endpoint, { accessGuard, offline });
    const context = browser.contexts()[0];
    if (!context) throw new Error('Chrome 未提供默认持久化上下文。');
    context.setDefaultTimeout(30000);
    context.setDefaultNavigationTimeout(45000);
    context.close = () => close(false);
    context.handoff = () => close(true);
    return context;
  } catch (error) {
    try { await close(); } catch (cleanupError) { logger.warn(`浏览器清理失败：${cleanupError.message}`); }
    throw error;
  }
}

async function getPage(context) {
  return context.pages().find((page) => !page.isClosed()) || context.newPage();
}

async function getExistingBossPage(context) {
  const { targetInfos } = await context.connection.send('Target.getTargets');
  const target = targetInfos.find((item) => item.type === 'page' && isBossUrl(item.url));
  return target ? context.attachPage(target) : null;
}

module.exports = { openContext, getPage, getExistingBossPage };
