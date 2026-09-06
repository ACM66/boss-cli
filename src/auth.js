'use strict';

// 登录态管理：扫码登录、登录态探测、登出。
// 登录态本身由持久化 profile 承载，登录一次即可跨命令复用。

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { openContext, getPage, getExistingBossPage } = require('./browser');
const { LOGIN_URL, BASE_URL, SELECTORS, ROOT_DIR } = require('./config');
const { sleep, logger, redact } = require('./util');
const { assertNoRiskControl, firstVisible } = require('./anticrawl');

// 判断给定页面当前是否处于已登录态。
// 策略：登录入口元素消失 + 出现用户头像/菜单 视为已登录。
// cookie 只能说明可能存在会话，不能在白页或跳转中代替页面确认。
async function isLoggedInOnPage(page) {
  const loginBtn = await firstVisible(page, SELECTORS.loginEntry);
  if (loginBtn) return false;
  const mark = await firstVisible(page, SELECTORS.loggedInMark);
  return Boolean(mark);
}

async function waitForLoginState(page, timeoutMs = 15000) {
  try {
    await page.waitForSelector([...SELECTORS.loginEntry, ...SELECTORS.loggedInMark].join(', '), {
      state: 'visible',
      timeout: timeoutMs,
    });
  } catch (e) {
    logger.debug(`未等到明确的页面登录标志：${e.message}`);
  }
  await assertNoRiskControl(page);
  return isLoggedInOnPage(page);
}

// 2026-09-05 登录前后 cookie 元数据实测：wt2/zp_at 是会话候选；
// __zp_stoken__ 等签名/设备字段不是身份认证证据。候选仍需真实页面核验。
function isSessionCookie(cookie, nowSeconds = Date.now() / 1000) {
  return (cookie.name === 'wt2' || cookie.name === 'zp_at') &&
    typeof cookie.value === 'string' && cookie.value.length > 0 &&
    (cookie.expires === -1 || cookie.expires > nowSeconds);
}

// 不发起导航的前置闸门：只接受已经观测到的明确会话候选。
async function hasLoginCookie(context) {
  const cookies = await context.cookies(BASE_URL);
  return cookies.some((cookie) => isSessionCookie(cookie));
}

// 通过专用浏览器检查持久化登录态是否有效。
async function whoami({ context: suppliedContext } = {}) {
  const context = suppliedContext || await openContext({ headless: false });
  try {
    context.accessGuard.assertAllowed();
    // Cookie 仅作为会话候选；联网核验同样受统一访问策略约束。
    if (!(await hasLoginCookie(context))) {
      logger.warn('未登录或登录态已过期，请运行：boss login');
      console.log('logged_out');
      return false;
    }
    // 有疑似登录 token：导航真实页核验是否仍有效（过期/被踢会在此暴露；也可能撞频控墙）
    const page = await getPage(context);
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    const logged = await waitForLoginState(page);
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
    if (!suppliedContext) await context.close();
  }
}

async function openWebsite({ existingOnly = false } = {}) {
  const context = await openContext({ headless: false, requireVisible: true });
  try {
    if (!(await hasLoginCookie(context))) throw new Error('专用 Chrome 尚未登录，请先运行 boss login；不会改用其他浏览器。');
    let page = await getExistingBossPage(context);
    const reusedPage = Boolean(page);
    if (!page) {
      if (existingOnly) throw new Error('专用 Chrome 中没有已有的 BOSS 页面，本次未导航。需要打开首页时运行 boss open。');
      page = await getPage(context);
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    }
    if (!(await waitForLoginState(page))) throw new Error('专用页面未通过登录核验，请运行 boss login；未打开其他浏览器。');
    await page.send('Page.bringToFront');
    const url = new URL(page.url());
    await context.handoff();
    logger.ok('专用 Chrome 页面已交给你操作，自动化连接和命令锁已释放');
    const result = { opened: true, browser: 'dedicated_chrome', reusedPage, loggedIn: true, url: url.origin + url.pathname };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    await context.close();
    throw error;
  }
}

// ── 扫码登录（二维码渲染式）────────────────────────────────────────────────
// 不再依赖「弹出的浏览器窗口」（窗口可能跑到别的桌面/被挡住，用户根本看不到）。
// 抓取登录二维码 → 落地为可查看的 qr.png（VSCode 标签）+ 自刷新 qr.html（浏览器），
// 用户扫码后登录态持久化到 profile。二维码随 BOSS 刷新而刷新，不怕扫码前过期。
//
// 实证（2026-06-03）：BOSS 默认是「微信扫码」安全登录，二维码是 img.mini-qrcode（200x200，
// src 来自 img.bosszhipin.com/.../weixin-service/...）。用微信扫，不是 BOSS App。

const QR_PNG = path.join(ROOT_DIR, 'qr.png');
const QR_HTML = path.join(ROOT_DIR, 'qr.html');
const QR_DIAGNOSTIC_PNG = path.join(ROOT_DIR, 'login-diagnostic.png');
const QR_SELECTORS = [
  'img.mini-qrcode',
  'img[src*="weixin-service"]',
  'img[src*="qrcode"]',
  '.qr-img-box img',
  '.qrcode img',
  '.login-qr img',
];

// 仅截图已经加载的二维码图片；整页截图不能作为二维码成功的证据。
async function captureQr(page) {
  for (const s of QR_SELECTORS) {
    const loc = page.locator(s).first();
    try {
      if ((await loc.count()) && (await loc.isVisible())) {
        const loaded = await loc.evaluate((img) => img.complete && img.naturalWidth > 0 && img.naturalHeight > 0);
        if (loaded) return { buf: await loc.screenshot(), how: s };
      }
    } catch (_) {
      /* 选择器瞬时态问题，试下一个 */
    }
  }
  return null;
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
// 关键：用 headless:false（真窗口）。实证（2026-06-03）BOSS 登录页会反爬无头模式——
// headless:true 下页面被 blank/抽掉二维码（about:blank、hasQr=false）；真窗口则稳定出码。
// 窗口会弹出但无需用户去找：二维码会被截图渲染到 qr.png（VSCode 标签）+ qr.html（浏览器）。
async function login({ timeoutMs = 600000 } = {}) {
  const context = await openContext({ headless: false });
  try {
    const page = await getPage(context);

    if (await hasLoginCookie(context)) {
      logger.info('发现会话 cookie，正在通过页面核验登录态...');
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      if (await waitForLoginState(page)) {
        logger.ok('已通过页面确认登录态，无需重复登录');
        return true;
      }
      logger.warn('会话 cookie 未通过页面登录核验，继续扫码登录');
    }

    logger.info('打开 BOSS 登录页，准备渲染二维码...');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await assertNoRiskControl(page); // 撞墙（IP 频控）会在这里抛 wall，立即停
    // 二维码图是异步从 CDN 加载的，先等它出现再截
    await page
      .waitForSelector([...QR_SELECTORS, '.wx-login-btn', ...SELECTORS.loggedInMark].join(', '), { timeout: 15000 })
      .catch(() => {});
    await sleep(800);
    await assertNoRiskControl(page);

    if (await isLoggedInOnPage(page)) {
      logger.ok('登录页已跳转到登录后的页面，登录态已确认');
      return true;
    }

    let first = await captureQr(page);
    if (!first) {
      const switchToWechat = await firstVisible(page, ['.wx-login-btn']);
      if (switchToWechat) {
        logger.info('当前为验证码登录，切换到微信扫码入口');
        await switchToWechat.click();
        await page.waitForSelector(QR_SELECTORS.join(', '), { timeout: 15000 });
        first = await captureQr(page);
      }
    }
    if (!first) {
      try {
        atomicWrite(QR_DIAGNOSTIC_PNG, await page.screenshot());
        logger.error(`未找到已加载的登录二维码，未生成扫码文件。页面诊断图：${QR_DIAGNOSTIC_PNG}`);
      } catch (e) {
        logger.error(`未找到已加载的登录二维码，且诊断截图失败：${e.message}`);
      }
      return false;
    }
    persistQr(first.buf);
    openQrViewers();
    logger.ok(`二维码已落地：${QR_PNG}（VSCode 标签）+ ${QR_HTML}（浏览器）`);
    logger.info(`定位方式：${first.how}；请用「微信」扫码（最长 ${Math.round(timeoutMs / 1000)}s）`);

    const deadline = Date.now() + timeoutMs;
    let logged = false;
    while (Date.now() < deadline) {
      await sleep(2500);
      // 访问限制和人工验证均中止自动轮询，冷却期由浏览器层持久化。
      await assertNoRiskControl(page);
      // 先确认真实页面的登录标志，避免扫码跳转后把白页/整页图当作二维码。
      if (await isLoggedInOnPage(page)) {
        logged = true;
        break;
      }
      // 只刷新真实二维码；跳转过程中暂时不存在二维码时保留上一张。
      try {
        const qr = await captureQr(page);
        if (qr) persistQr(qr.buf);
      } catch (_) {
        /* 截图偶发失败不阻断轮询 */
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
  const context = await openContext({ headless: true, offline: true });
  try {
    await context.clearCookies();
    fs.rmSync(path.join(ROOT_DIR, 'read-cache.json'), { force: true });
    try { await context.clearOriginStorage(BASE_URL); }
    catch (error) { throw new Error('Cookie 和岗位缓存已清除，但站点存储清理未完成：' + error.message); }
    logger.ok('已清除本地 Cookie、岗位缓存和站点存储；访问冷却和沟通记录保留。下次操作需重新 boss login');
    return true;
  } finally {
    await context.close();
  }
}

module.exports = { login, logout, whoami, openWebsite, isLoggedInOnPage, hasLoginCookie, isSessionCookie };
