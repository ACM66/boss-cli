'use strict';

// 真实 Chrome + localhost 的登录二维码获取测试；临时 profile 不含登录态，也不访问 BOSS。
// 页面结构照抄 2026-09-06 在 www.zhipin.com 登录组件上实测到的 DOM：
// 默认渲染 .sign-form.sign-sms，点 .sign-tab .link-scan 才切到 .sign-form.sign-scan，
// 码是 .qrcodeimg-box > img，过期时 .invalid-box 盖住图片并提供刷新按钮。
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
const { AccessGuard } = require('../src/anticrawl');
const { acquireQr, readQrHint, refreshExpiredQr } = require('../src/auth');

const chromePath = process.env.BOSS_CHROME_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');

// 1x1 PNG：只要 naturalWidth>0 就满足「图片真的加载了」，显示尺寸由 CSS 撑开。
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const style = `<style>
  .hide { display: none; }
  .qrcodeimg-box { position: relative; width: 200px; height: 200px; }
  .qrcodeimg-box img { width: 200px; height: 200px; }
  .invalid-box { position: absolute; inset: 0; background: #fff; }
</style>`;

const scanForm = (invalid = false) => `
<div class="sign-form sign-scan">
  <div class="sign-tab"><span class="link-scan cur">扫码登录</span></div>
  <div class="qrcode-box">
    <p><span>使用 BOSS直聘 APP 扫码登录</span><em>扫码帮助</em></p>
    <div class="qrcodeimg-box">
      <div class="invalid-box ${invalid ? '' : 'hide'}"><p>请重新刷新二维码</p><button class="btn">点击刷新</button></div>
      <img src="${invalid ? '' : PNG}">
    </div>
  </div>
</div>`;

const PAGES = {
  // 默认短信表单，二维码要点「扫码登录」才渲染（真实页面的默认形态）
  '/sms-first': `<!doctype html><meta charset="utf-8"><title>sms first</title>${style}
    <div class="sign-form sign-sms">
      <div class="sign-tab"><span class="link-scan">扫码登录</span></div>
      <input class="phone" placeholder="手机号">
    </div>
    <div id="scan-holder"></div>
    <script>
      document.querySelector('.sign-tab .link-scan').addEventListener('click', () => {
        document.querySelector('.sign-form.sign-sms').classList.add('hide');
        // 真实页面的码是异步取回来的，这里也延后渲染，验证会等图片真的加载
        setTimeout(() => { document.getElementById('scan-holder').innerHTML = ${JSON.stringify(scanForm())}; }, 600);
      });
    </script>`,
  // 页面直接就在扫码态
  '/scan-first': `<!doctype html><meta charset="utf-8"><title>scan first</title>${style}${scanForm()}`,
  // 既没有码也没有任何扫码入口
  '/no-entry': `<!doctype html><meta charset="utf-8"><title>no entry</title>${style}
    <div class="sign-form sign-sms"><input class="phone" placeholder="手机号"></div>`,
  // 点了也不出码：.sign-tab .link-scan 与 .link-scan 是同一个元素，不该被当成两个入口试两遍
  '/dead-entry': `<!doctype html><meta charset="utf-8"><title>dead entry</title>${style}
    <div class="sign-form sign-sms"><div class="sign-tab"><span class="link-scan">扫码登录</span></div></div>`,
  // 码已失效，必须点刷新按钮才换新码
  '/expired': `<!doctype html><meta charset="utf-8"><title>expired</title>${style}${scanForm(true)}
    <script>
      document.querySelector('.invalid-box .btn').addEventListener('click', () => {
        document.querySelector('.invalid-box').classList.add('hide');
        document.querySelector('.qrcodeimg-box img').src = ${JSON.stringify(PNG)};
      });
    </script>`,
};

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-login-qr-test-'));
  let child;
  let browser;
  const server = http.createServer((request, response) => {
    const body = PAGES[request.url];
    response.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(body || '<!doctype html><title>404</title>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (browser?.isConnected()) await browser.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      for (let i = 0; i < 60 && child.exitCode === null && child.signalCode === null; i++) await delay(50);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
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
    '--no-first-run', '--no-default-browser-check', 'about:blank',
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
  browser = await connectBrowser(endpoint, { accessGuard: new AccessGuard({ rootDir: root }) });
  return { context: browser.contexts()[0], url: `http://127.0.0.1:${server.address().port}` };
}

const isPng = (buf) => Buffer.isBuffer(buf) && buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';

test('登录页二维码的入口切换与刷新', { skip: !fs.existsSync(chromePath), timeout: 60000 }, async (t) => {
  const f = await fixture(t);

  await t.test('默认短信表单时先点扫码入口，再等到真实加载的二维码', async () => {
    const page = await f.context.newPage();
    await page.goto(`${f.url}/sms-first`);
    const { qr, tried } = await acquireQr(page);
    assert.ok(qr, '点过扫码入口后应取到二维码');
    assert.equal(qr.entry, '.sign-tab .link-scan');
    assert.equal(qr.how, '.qrcodeimg-box img');
    assert.ok(isPng(qr.buf));
    assert.deepEqual(tried, ['.sign-tab .link-scan（扫码登录）']);
    assert.equal(await readQrHint(page), '使用 BOSS直聘 APP 扫码登录');
    await page.close();
  });

  await t.test('页面已经在扫码态时不点任何入口', async () => {
    const page = await f.context.newPage();
    await page.goto(`${f.url}/scan-first`);
    const { qr, tried } = await acquireQr(page);
    assert.ok(qr && isPng(qr.buf));
    assert.equal(qr.entry, undefined);
    assert.deepEqual(tried, []);
    await page.close();
  });

  await t.test('既无二维码又无入口时如实返回空，不伪造结果', async () => {
    const page = await f.context.newPage();
    await page.goto(`${f.url}/no-entry`);
    const { qr, tried } = await acquireQr(page, { entryTimeoutMs: 500 });
    assert.equal(qr, null);
    assert.deepEqual(tried, []);
    assert.equal(await readQrHint(page), '请按 BOSS 登录页上二维码旁的提示扫码');
    await page.close();
  });

  await t.test('多个候选命中同一个入口元素时只试一次', async () => {
    const page = await f.context.newPage();
    await page.goto(`${f.url}/dead-entry`);
    const started = Date.now();
    const { qr, tried } = await acquireQr(page, { entryTimeoutMs: 500 });
    assert.equal(qr, null);
    assert.deepEqual(tried, ['.sign-tab .link-scan（扫码登录）'], '同一个元素不应被记成两个入口');
    assert.ok(Date.now() - started < 2000, '去重后不该为同一个元素等两轮');
    await page.close();
  });

  await t.test('二维码失效时点刷新按钮换新码', async () => {
    const page = await f.context.newPage();
    await page.goto(`${f.url}/expired`);
    assert.equal(await refreshExpiredQr(page), true);
    await page.waitForSelector('.qrcodeimg-box img', { state: 'visible' });
    const { qr } = await acquireQr(page);
    assert.ok(qr && isPng(qr.buf), '刷新后应取到新的二维码');
    assert.equal(await refreshExpiredQr(page), false, '没有失效遮罩时不应再点击');
    await page.close();
  });
});
