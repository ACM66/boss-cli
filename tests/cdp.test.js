'use strict';

// 真实 Chrome + localhost 的传输/中止测试；临时 profile 不含登录态，也不访问 BOSS。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { connectBrowser } = require('../src/cdp');
const { AccessGuard, RiskControlError } = require('../src/anticrawl');

const chromePath = process.env.BOSS_CHROME_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');

async function fixture(t, options = {}) {
  const { policy, chromeArgs = [], ...browserOptions } = options;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-cdp-test-'));
  let child;
  let browser;
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (request.url === '/pending') { response.write('<title>pending local navigation</title>'); return; }
    if (request.url === '/responsive') {
      response.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Responsive screenshot transport test</title>
        <style>
          html, body { margin: 0; background: rgb(20, 30, 40); min-height: 2600px; }
          #target { position: absolute; left: 1040px; top: 160px; width: 160px; height: 120px; background: rgb(10, 180, 70); }
          @media (max-width: 900px) { body { background: rgb(230, 20, 30); } #target { display: none; } }
        </style>
        <div id="target"></div>
        <script>
          window.resizeEvents = [];
          window.narrowSeen = false;
          addEventListener('resize', () => {
            resizeEvents.push({ width: innerWidth, height: innerHeight, scale: devicePixelRatio });
            narrowSeen ||= innerWidth < 900;
          });
        </script>`);
      return;
    }
    response.end('<!doctype html><title>Local CDP test</title><p id="ready">Local transport ready</p>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (browser?.isConnected()) await browser.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      for (let i = 0; i < 60 && child.exitCode === null && child.signalCode === null; i++) await delay(50);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      for (let i = 0; i < 40 && child.exitCode === null && child.signalCode === null; i++) await delay(50);
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const portFinder = net.createServer();
  await new Promise((resolve) => portFinder.listen(0, '127.0.0.1', resolve));
  const port = portFinder.address().port;
  await new Promise((resolve) => portFinder.close(resolve));
  child = spawn(chromePath, [
    `--user-data-dir=${root}`, `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1', '--headless=new',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--no-first-run', '--no-default-browser-check', ...chromeArgs, 'about:blank',
  ], { stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  let endpoint;
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(300) });
      endpoint = (await response.json()).webSocketDebuggerUrl;
      break;
    } catch (_) { await delay(100); }
  }
  assert.ok(endpoint, '独立 Chrome 应在 6 秒内启动');
  const accessGuard = new AccessGuard({ rootDir: root, policy });
  browser = await connectBrowser(endpoint, { accessGuard, ...browserOptions });
  return { browser, context: browser.contexts()[0], requests, url: `http://127.0.0.1:${server.address().port}`, accessGuard };
}

test('真实本地浏览器的导航、关闭与风险中止', { skip: !fs.existsSync(chromePath), timeout: 30000 }, async (t) => {
  const f = await fixture(t);

  await t.test('导航取得真实页面与请求元数据', async () => {
    const page = await f.context.newPage();
    const responseWait = page.waitForResponse(`${f.url}/`);
    await page.goto(`${f.url}/`);
    const response = await responseWait;
    assert.equal(response.status(), 200);
    assert.equal(response.request().method(), 'GET');
    assert.equal(response.request().url(), `${f.url}/`);
    assert.equal(await page.locator('#ready').innerText(), 'Local transport ready');
    assert.equal(page.listenerCount('response'), 0);
    assert.equal(page.listenerCount('terminated'), 0);
    await page.close();
  });

  await t.test('页面关闭立即拒绝 CDP 执行、响应及元素等待', async () => {
    const page = await f.context.newPage();
    await page.goto(`${f.url}/`);
    const waiting = [
      page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 15000))),
      page.waitForResponse(`${f.url}/not-requested`),
      page.waitForSelector('#does-not-exist'),
    ].map((operation) => assert.rejects(operation, /页面已关闭/));
    await delay(100);
    const start = Date.now();
    await page.close();
    await Promise.all(waiting);
    assert.ok(Date.now() - start < 1500);
    assert.equal(page.listenerCount('terminated'), 0);
    assert.equal(page.listenerCount('response'), 0);
  });

  await t.test('导航超时后确实停止页面流量并拒绝后续操作', async () => {
    const page = await f.context.newPage();
    await assert.rejects(page.goto(`${f.url}/pending`, { timeout: 150 }), /页面导航.*超时/);
    await assert.rejects(page.goto(`${f.url}/must-not-navigate`), /页面导航.*超时/);
    assert.equal(f.requests.includes('/must-not-navigate'), false);
    assert.equal(page.listenerCount('Page.domContentEventFired'), 0);
    assert.equal(page.listenerCount('terminated'), 0);
    await page.close();
  });

  await t.test('context 中止所有自有页，保留同一错误且阻断定时发起的真实 HTTP', async () => {
    const first = await f.context.newPage();
    const second = await f.context.newPage();
    await first.goto(`${f.url}/`);
    await second.goto(`${f.url}/`);
    await first.evaluate(() => { setTimeout(() => fetch('/after-freeze').catch(() => {}), 350); });
    const risk = new Error('本地显式中止测试');
    const waiting = [
      first.waitForResponse(`${f.url}/not-requested`),
      second.waitForSelector('#does-not-exist'),
      first.waitForTimeout(15000),
      second.goto(`${f.url}/pending`),
    ].map((operation) => assert.rejects(operation, (error) => error === risk));
    await delay(100);
    const start = Date.now();
    await f.context.freeze(risk);
    await Promise.all(waiting);
    assert.ok(Date.now() - start < 1500);
    await assert.rejects(f.context.newPage(), (error) => error === risk);
    await delay(450);
    assert.equal(f.requests.includes('/after-freeze'), false);
    for (const page of [first, second]) {
      assert.equal(page.listenerCount('terminated'), 0);
      assert.equal(page.listenerCount('response'), 0);
      await page.close();
    }
  });
});

test('Chrome 连接断开立即结束所有页面等待', { skip: !fs.existsSync(chromePath), timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const page = await f.context.newPage();
  await page.goto(`${f.url}/`);
  const waiting = [
    page.waitForResponse(`${f.url}/not-requested`),
    page.waitForSelector('#does-not-exist'),
    page.waitForTimeout(15000),
    page.goto(`${f.url}/pending`),
  ].map((operation) => assert.rejects(operation, /Chrome 连接已关闭/));
  await delay(100);
  const start = Date.now();
  await f.browser.close();
  await Promise.all(waiting);
  assert.ok(Date.now() - start < 1500);
  assert.equal(f.context.pages().length, 0);
  assert.equal(page.listenerCount('terminated'), 0);
  assert.equal(page.listenerCount('response'), 0);
  assert.equal(f.context.connection.listenerCount('event'), 0);
});

test('离线上下文阻止导航和页面脚本请求，站点存储仍可清理', { skip: !fs.existsSync(chromePath), timeout: 15000 }, async (t) => {
  const f = await fixture(t, { offline: true });
  const page = await f.context.newPage();
  await assert.rejects(page.goto(`${f.url}/offline-navigation`), /离线上下文禁止网络导航/);
  const result = await page.evaluate(async (url) => {
    try { await fetch(url); return 'unexpected-success'; }
    catch (_) { return 'blocked'; }
  }, `${f.url}/offline-script`);
  assert.equal(result, 'blocked');
  await f.context.clearCookies();
  await f.context.clearOriginStorage(f.url);
  assert.deepEqual(f.requests, []);
});

test('点击前重新读取跨命令冷却记录并阻断页面交互', { skip: !fs.existsSync(chromePath), timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const page = await f.context.newPage();
  await page.goto(`${f.url}/`);
  await page.evaluate(() => { document.querySelector('#ready').onclick = () => fetch('/clicked'); });
  f.accessGuard.recordRisk(new RiskControlError('本地交互门禁测试', 'wall'));
  await assert.rejects(page.locator('#ready').click(), /本地交互门禁测试/);
  await f.context.freezePromise;
  assert.equal(f.requests.includes('/clicked'), false);
  assert.ok(f.context.riskError);
});

test('限频等待期间关闭页面会取消内部等待，不延迟消耗额度或发出导航', { skip: !fs.existsSync(chromePath), timeout: 15000 }, async (t) => {
  const f = await fixture(t, { policy: { navigationIntervalMs: 800 } });
  const page = await f.context.newPage();
  // 双保险：测试期间即使实现回归，也不允许 Chrome 访问任何远程站点。
  await page.send('Network.setBlockedURLs', { urls: ['*'] });
  const target = 'https://www.zhipin.com/';
  await f.accessGuard.beforeNavigation(target);
  const before = f.accessGuard.readState().navigations;
  let mainNavigations = 0;
  page.on('Page.frameNavigated', () => { mainNavigations++; });
  const waiting = assert.rejects(page.goto(target), /Chrome 页面已关闭/);
  await delay(100);
  const start = Date.now();
  await page.close();
  await waiting;
  assert.ok(Date.now() - start < 500);
  assert.equal(page.signal.aborted, true);
  assert.equal(page.signal.reason, page.terminalError);
  await delay(850);
  assert.deepEqual(f.accessGuard.readState().navigations, before);
  assert.equal(mainNavigations, 0);
  assert.deepEqual(f.requests, []);
});

test('元素截图保持响应式 viewport，裁剪包含正确的目标像素', { skip: !fs.existsSync(chromePath), timeout: 15000 }, async (t) => {
  const f = await fixture(t, { chromeArgs: ['--force-device-scale-factor=2', '--window-size=1442,1006'] });
  const page = await f.context.newPage();
  await page.goto(`${f.url}/responsive`);
  await page.waitForTimeout(100);
  for (const [label, top] of [['element', 160], ['scrolled', 1800]]) {
    await page.locator('#target').evaluate((el, y) => { el.style.top = `${y}px`; }, top);
    const before = await page.evaluate(() => {
      resizeEvents.length = 0;
      return { width: innerWidth, height: innerHeight, scale: devicePixelRatio };
    });
    const artifactDir = process.env.BOSS_SCREENSHOT_ARTIFACT_DIR;
    if (artifactDir) fs.mkdirSync(artifactDir, { recursive: true });
    const buffer = await page.locator('#target').screenshot(artifactDir ? { path: path.join(artifactDir, `${label}.png`) } : {});
    await page.waitForTimeout(100);
    const after = await page.evaluate(() => ({
      width: innerWidth, height: innerHeight, scale: devicePixelRatio,
      events: resizeEvents, narrowSeen, scrollY, targetVisible: Boolean(document.querySelector('#target').getBoundingClientRect().width),
    }));
    const image = await page.evaluate(async (data) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return { width: img.width, height: img.height, center: [...ctx.getImageData(Math.floor(img.width / 2), Math.floor(img.height / 2), 1, 1).data] };
    }, buffer.toString('base64'));
    const evidence = { label, before, after, image };
    t.diagnostic(JSON.stringify(evidence));
    if (artifactDir) fs.writeFileSync(path.join(artifactDir, label === 'element' ? 'evidence.json' : 'scrolled-evidence.json'), JSON.stringify(evidence, null, 2));
    assert.deepEqual(after.events, []);
    assert.equal(after.narrowSeen, false);
    assert.equal(after.targetVisible, true);
    assert.deepEqual({ width: after.width, height: after.height, scale: after.scale }, before);
    assert.deepEqual(image, { width: 320, height: 240, center: [10, 180, 70, 255] });
    if (label === 'scrolled') assert.ok(after.scrollY > 0);
  }
});
