'use strict';

// 登录态管理：扫码登录、登录态探测、登出。
// 登录态本身由持久化 profile 承载，登录一次即可跨命令复用。

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { openContext, getPage } = require('./browser');
const { LOGIN_URL, BASE_URL, RECOMMEND_URL, SELECTORS, ROOT_DIR } = require('./config');
const { sleep, logger, color, redact } = require('./util');
const { assertNoRiskControl, firstVisible } = require('./anticrawl');

// 判断给定页面当前是否处于已登录态。
// 策略：登录入口元素消失 + 出现用户头像/菜单 视为已登录。
// 二者都依赖 DOM，故同时检查 cookie 作为兜底信号。
async function isLoggedInOnPage(page) {
  const loginBtn = await firstVisible(page, SELECTORS.loginEntry);
  if (loginBtn) return false;
  const mark = await firstVisible(page, SELECTORS.loggedInMark);
  if (mark) return true;
  // 兜底：cookie 里存在求职者 token 类字段
  const cookies = await page.context().cookies(BASE_URL).catch(() => []);
  const tokenLike = cookies.find((c) =>
    /token|zp_sseed|geek/i.test(c.name) && c.value && c.value.length > 8
  );
  return Boolean(tokenLike);
}

// 仅凭持久化 profile 里的 cookie 判断「是否可能已登录」——离线读盘、不导航、不发任何
// 网络请求，因此绝不会触发频控墙。这是 necessary-not-sufficient 的前置闸门：
// 无 token 必定未登录；有 token 仍可能已过期，需联网核验。
// 口径复用 isLoggedInOnPage 的 cookie 兜底逻辑（/token|zp_sseed|geek/），不另立新口径。
async function hasLoginCookie(context) {
  const cookies = await context.cookies(BASE_URL).catch(() => []);
  return cookies.some(
    (c) => /token|zp_sseed|geek/i.test(c.name) && c.value && c.value.length > 8
  );
}

// 不弹窗、快速检查当前持久化登录态是否有效。
async function whoami() {
  const context = await openContext({ headless: true });
  try {
    // 先离线读 cookie：没有任何登录 token 就直接判未登录，不导航、不触发频控墙。
    // 这样 whoami 能干净区分两种状态——「未登录」（离线即知）vs「已登录但撞频控」
    // （仅当有 token、联网核验时才会在下方撞墙暴露），而不是一上来导航就被墙、两者糊成一团。
    if (!(await hasLoginCookie(context))) {
      logger.warn('未登录或登录态已过期，请运行：boss login');
      console.log('logged_out');
      return false;
    }
    // 有疑似登录 token：导航真实页核验是否仍有效（过期/被踢会在此暴露；也可能撞频控墙）
    const page = await getPage(context);
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(1500);
    await assertNoRiskControl(page);
    const logged = await isLoggedInOnPage(page);
    if (logged) {
      // 尝试读个昵称展示，读不到也不影响结论
      let nick = '';
      try {
        nick = await page.evaluate(() => {
          const el = document.querySelector('.nav-figure img');
          return (el && (el.alt || el.title)) || '';
        });
      } catch (_) {}
      logger.ok(`已登录${nick ? `（${redact(nick)}）` : ''}`);
      console.log('logged_in');
      return true;
    }
    logger.warn('未登录或登录态已过期，请运行：boss login');
    console.log('logged_out');
    return false;
  } finally {
    await context.close();
  }
}

// ── 扫码登录（二维码渲染式）────────────────────────────────────────────────
// 不再依赖「弹出的浏览器窗口」（窗口可能跑到别的桌面/被挡住，用户根本看不到）。
// 改为无头抓取登录二维码 → 落地为可查看的 qr.png（VSCode 标签）+ 自刷新 qr.html（浏览器），
// 用户扫码后登录态持久化到 profile。二维码随 BOSS 刷新而刷新，不怕扫码前过期。
//
// 实证（2026-06-03）：BOSS 默认是「微信扫码」安全登录，二维码是 img.mini-qrcode（200x200，
// src 来自 img.bosszhipin.com/.../weixin-service/...）。用微信扫，不是 BOSS App。

const QR_PNG = path.join(ROOT_DIR, 'qr.png');
const QR_HTML = path.join(ROOT_DIR, 'qr.html');
const QR_SELECTORS = [
  'img.mini-qrcode',
  'img[src*="weixin-service"]',
  'img[src*="qrcode"]',
  '.qr-img-box img',
  '.qrcode img',
  '.login-qr img',
];

// 截出二维码，返回 PNG Buffer。优先按已知选择器做元素截图（天然紧裁），最后兜底整页。
async function captureQr(page) {
  for (const s of QR_SELECTORS) {
    const loc = page.locator(s).first();
    try {
      if ((await loc.count()) && (await loc.isVisible())) {
        return { buf: await loc.screenshot(), how: s };
      }
    } catch (_) {
      /* 选择器瞬时态问题，试下一个 */
    }
  }
  return { buf: await page.screenshot(), how: 'fullpage' };
}

function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function qrHtml(b64) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="3"><title>BOSS 扫码登录</title></head>
<body style="font-family:-apple-system,system-ui,sans-serif;text-align:center;background:#f5f5f5;padding:28px">
<h2 style="color:#222;margin:8px">微信扫一扫，登录 BOSS 直聘</h2>
<img src="data:image/png;base64,${b64}" width="260"
 style="border:1px solid #ddd;border-radius:10px;background:#fff;padding:10px">
<p style="color:#999;font-size:13px">用<b>微信</b>扫码并在手机上确认；二维码每 3 秒自动刷新，扫码成功后本页会显示「登录成功」</p>
</body></html>`;
}

function doneHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>登录成功</title></head>
<body style="font-family:-apple-system,system-ui,sans-serif;text-align:center;background:#f0fff4;padding:60px">
<h1 style="color:#1a7f37">✅ 登录成功</h1>
<p style="color:#555">登录态已保存到 boss-cli，本页可以关闭了。</p></body></html>`;
}

function persistQr(buf) {
  atomicWrite(QR_PNG, buf);
  atomicWrite(QR_HTML, qrHtml(buf.toString('base64')));
}

// 打开查看器：VSCode 图片标签（主，随文件刷新自动重载）+ 默认浏览器自刷新页（备）。
// 装了哪个开哪个，没装的静默失败。
function openQrViewers() {
  execFile('code', [QR_PNG], () => {});
  execFile('open', [QR_HTML], () => {});
}

// 扫码登录：渲染二维码到可查看文件，轮询检测登录成功。
async function login({ timeoutMs = 600000 } = {}) {
  const context = await openContext({ headless: true });
  try {
    const page = await getPage(context);

    if (await hasLoginCookie(context)) {
      logger.ok('当前 profile 已是登录态，无需重复登录');
      return true;
    }

    logger.info('打开 BOSS 登录页，准备渲染二维码...');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await assertNoRiskControl(page); // 撞墙（IP 频控）会在这里抛 wall，立即停
    // 二维码图是异步从 CDN 加载的，先等它出现再截
    await page
      .waitForSelector('img.mini-qrcode, img[src*="qrcode"], img[src*="weixin-service"]', { timeout: 15000 })
      .catch(() => {});
    await sleep(800);

    const first = await captureQr(page);
    persistQr(first.buf);
    openQrViewers();
    logger.ok(`二维码已落地：${QR_PNG}（VSCode 标签）+ ${QR_HTML}（浏览器）`);
    logger.info(`定位方式：${first.how}；请用「微信」扫码（最长 ${Math.round(timeoutMs / 1000)}s）`);

    const deadline = Date.now() + timeoutMs;
    let logged = false;
    while (Date.now() < deadline) {
      await sleep(2500);
      // 风控页处置：wall（访问受限/IP 频控）立即停，绝不硬刚；captcha 提示但继续等
      try {
        await assertNoRiskControl(page);
      } catch (e) {
        if (e.kind === 'wall') {
          logger.error(e.message);
          logger.error('已触发访问限制，停止登录轮询以免加重频控。请按提示等待后再重试 boss login。');
          return false;
        }
        logger.warn(e.message);
      }
      // 刷新二维码（BOSS 会定期换码）
      try {
        persistQr((await captureQr(page)).buf);
      } catch (_) {
        /* 截图偶发失败不阻断轮询 */
      }
      // 扫码成功判定：profile 出现登录 token
      if (await hasLoginCookie(context)) {
        logged = true;
        break;
      }
    }

    if (logged) {
      atomicWrite(QR_HTML, doneHtml());
      logger.ok('登录成功，登录态已持久化到本地 profile，后续命令免扫码复用');
      await sleep(1200); // 给 cookie 落盘留点时间
      return true;
    }
    logger.error('扫码超时未完成。请重试 boss login，确保用微信扫码并在手机上确认');
    return false;
  } finally {
    await context.close();
  }
}

// 登出：清掉持久化 profile 里的登录态（保留 profile 本体以维持指纹老化）。
// BOSS 是 SPA，身份/历史可能存在 localStorage，故除 cookie 外还清 storage——
// 共享机器复用同一 ~/.boss-cli 时，避免把登录态泄露给下一个使用者。
async function logout() {
  const context = await openContext({ headless: true });
  try {
    await context.clearCookies();
    try {
      const page = await getPage(context);
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => {
        try { localStorage.clear(); } catch (e) {}
        try { sessionStorage.clear(); } catch (e) {}
      });
    } catch (e) {
      // cookie 已清，storage 清理失败不阻断（如撞频控墙），仅提示
      logger.warn(`本地存储清理未完成（cookie 已清除）：${e.message}`);
    }
    logger.ok('已清除登录态（cookie + localStorage + sessionStorage）。下次操作需重新 boss login');
    return true;
  } finally {
    await context.close();
  }
}

module.exports = { login, logout, whoami, isLoggedInOnPage, hasLoginCookie };
