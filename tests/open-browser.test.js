'use strict';

// handoff 的真实进程测试：仅替换 profile 根目录，Node/Chrome/CDP/HTTP 全部实际运行。
// 页面均为通用 localhost 内容，不访问 BOSS，也不连接用户正在使用的 Chrome。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');

const run = promisify(execFile);
const browserFile = path.join(__dirname, '../src/browser.js');
const chromePath = process.env.BOSS_CHROME_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');

const childProgram = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const [browserFile, root, mode, url] = process.argv.slice(1);
const requireSource = createRequire(browserFile);
const loaded = { exports: {} };
vm.runInNewContext(fs.readFileSync(browserFile, 'utf8'), {
  module: loaded, process, URL, AbortSignal, fetch,
  require(id) {
    if (id === './config') return { ...requireSource(id), ROOT_DIR: root, USER_DATA_DIR: path.join(root, 'userdata') };
    return requireSource(id);
  },
}, { filename: browserFile });
const { openContext, getPage, getExistingBossPage } = loaded.exports;
const { AccessGuard, RiskControlError } = requireSource('./anticrawl');
const stateFile = path.join(root, 'browser.json');
const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const signalCounts = () => ['SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name));
(async () => {
  const beforeSignals = signalCounts();
  let context;
  let result;
  try {
    if (mode === 'visible') {
      try { context = await openContext({ requireVisible: true }); result = { unexpectedlyOpened: true }; }
      catch (error) { result = { error: error.message }; }
    } else if (mode === 'cold-open') {
      try { context = await openContext({ headless: true }); result = { unexpectedlyOpened: true }; }
      catch (error) { result = { error: error.message }; }
    } else {
      context = await openContext({ headless: true });
      const current = state();
      const existing = await getExistingBossPage(context);
      result = { pid: current.pid, port: current.port, foundBoss: Boolean(existing), pagesBefore: context.pages().length };
      const page = await getPage(context);
      await page.goto(url);
      result.targetId = page.targetId;
      result.url = page.url();
      if (mode === 'handoff') {
        await context.handoff();
        await context.close();
        await context.handoff();
        result.handedOff = true;
      } else if (mode === 'failure') {
        await context.freeze(new Error('独立本地失败测试'));
        try { await context.handoff(); result.unexpectedHandoff = true; }
        catch (error) { result.error = error.message; }
      } else if (mode === 'cooldown') {
        const guard = new AccessGuard({ rootDir: root });
        guard.recordRisk(new RiskControlError('独立本地冷却测试', 'wall'));
        try { await context.handoff(); result.unexpectedHandoff = true; }
        catch (error) { result.error = error.message; }
      }
    }
  } finally {
    if (context) await context.close();
  }
  result.beforeSignals = beforeSignals;
  result.afterSignals = signalCounts();
  result.lockExists = fs.existsSync(path.join(root, 'browser.lock.json'));
  console.log(JSON.stringify(result));
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
`;

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-open-test-'));
  const knownBrowsers = new Map();
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><title>Local handoff test</title><p>Browser ownership transport test</p>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const stateFile = path.join(root, 'browser.json');
  t.after(async () => {
    if (fs.existsSync(stateFile)) {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      knownBrowsers.set(state.pid, state);
    }
    for (const state of knownBrowsers.values()) {
      if (!isAlive(state.pid)) continue;
      assert.equal(state.userDataDir, path.join(root, 'userdata'));
      const command = execFileSync('ps', ['-p', String(state.pid), '-o', 'command='], { encoding: 'utf8' });
      assert.ok(command.includes(`--user-data-dir=${state.userDataDir}`), '只能清理本测试 profile 的 Chrome');
      assert.ok(command.includes(`--remote-debugging-port=${state.port}`));
      process.kill(state.pid, 'SIGTERM');
      for (let i = 0; i < 60 && isAlive(state.pid); i++) await delay(50);
      if (isAlive(state.pid)) process.kill(state.pid, 'SIGKILL');
      for (let i = 0; i < 40 && isAlive(state.pid); i++) await delay(50);
      assert.equal(isAlive(state.pid), false, '测试创建的 Chrome 必须退出');
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root, stateFile, requests,
    url: `http://127.0.0.1:${server.address().port}`,
    async command(mode, suffix = '/handoff') {
      const { stdout, stderr } = await run(process.execPath, ['-e', childProgram, browserFile, root, mode,
        `http://127.0.0.1:${server.address().port}${suffix}`], {
        env: { ...process.env, BOSS_CHROME_PATH: chromePath, BOSS_DEBUG: '' },
        timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      });
      const result = JSON.parse(stdout.trim());
      if (result.pid && fs.existsSync(stateFile)) {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        knownBrowsers.set(state.pid, state);
      }
      assert.equal(result.lockExists, false, stderr);
      assert.deepEqual(result.afterSignals, result.beforeSignals, '命令必须释放信号监听器');
      return result;
    },
    async targets(port) {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
      assert.equal(response.status, 200);
      return response.json();
    },
  };
}

test('handoff 让子 Node 自然退出并保留专用 Chrome，后续命令复用同一实例', {
  skip: !fs.existsSync(chromePath) || process.platform === 'win32', timeout: 45000,
}, async (t) => {
  const f = await fixture(t);
  const first = await f.command('handoff', '/handoff?destination=https%3A%2F%2Fwww.zhipin.com');
  assert.equal(first.handedOff, true);
  assert.equal(first.foundBoss, false);
  assert.equal(isAlive(first.pid), true);
  assert.equal(JSON.parse(fs.readFileSync(f.stateFile, 'utf8')).pid, first.pid);
  let targets = await f.targets(first.port);
  assert.ok(targets.some((target) => target.id === first.targetId && target.url === first.url));

  const reused = await f.command('reuse', '/second-command');
  assert.equal(reused.pid, first.pid);
  assert.equal(reused.foundBoss, false, 'localhost URL 即使包含 BOSS 字样也不能被当作平台页面');
  assert.equal(reused.pagesBefore, 0, '不得接管用户已有的非 BOSS 页面');
  assert.equal(isAlive(first.pid), true);
  targets = await f.targets(first.port);
  assert.ok(targets.some((target) => target.id === first.targetId && target.url === first.url));
  assert.equal(targets.some((target) => target.id === reused.targetId), false, '复用命令退出只关闭自己的新页面');

  const visible = await f.command('visible');
  assert.match(visible.error, /专用 Chrome 当前为无头模式/);
  assert.equal(visible.unexpectedlyOpened, undefined);
  assert.equal(JSON.parse(fs.readFileSync(f.stateFile, 'utf8')).pid, first.pid);
  targets = await f.targets(first.port);
  assert.ok(targets.some((target) => target.id === first.targetId && target.url === first.url));
});

test('发生失败后禁止 handoff，正常 close 清除本命令 Chrome 和锁', {
  skip: !fs.existsSync(chromePath) || process.platform === 'win32', timeout: 30000,
}, async (t) => {
  const f = await fixture(t);
  const result = await f.command('failure');
  assert.match(result.error, /独立本地失败测试/);
  assert.equal(result.unexpectedHandoff, undefined);
  assert.equal(isAlive(result.pid), false);
  assert.equal(fs.existsSync(f.stateFile), false);
});

test('冷却禁止 handoff 和下一次启动，不残留 Chrome、命令锁或信号监听器', {
  skip: !fs.existsSync(chromePath) || process.platform === 'win32', timeout: 30000,
}, async (t) => {
  const f = await fixture(t);
  const result = await f.command('cooldown');
  assert.match(result.error, /独立本地冷却测试/);
  assert.equal(result.unexpectedHandoff, undefined);
  assert.equal(isAlive(result.pid), false);
  assert.equal(fs.existsSync(f.stateFile), false);
  const requestCount = f.requests.length;
  const next = await f.command('cold-open');
  assert.match(next.error, /独立本地冷却测试/);
  assert.equal(next.unexpectedlyOpened, undefined);
  assert.equal(fs.existsSync(f.stateFile), false);
  assert.equal(f.requests.length, requestCount);
});
