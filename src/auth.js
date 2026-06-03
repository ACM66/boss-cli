'use strict';

// 登录态管理：扫码登录、登录态探测、登出。
// 登录态本身由持久化 profile 承载，登录一次即可跨命令复用。

const { openContext, getPage } = require('./browser');
const { LOGIN_URL, BASE_URL, RECOMMEND_URL, SELECTORS } = require('./config');
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

// 不弹窗、快速检查当前持久化登录态是否有效。
async function whoami() {
  const context = await openContext({ headless: true });
  try {
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

// 扫码登录：弹出真实浏览器窗口，用户用 BOSS App 扫码，轮询检测登录成功。
async function login({ timeoutMs = 180000 } = {}) {
  const context = await openContext({ headless: false });
  try {
    const page = await getPage(context);
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(1200);

    if (await isLoggedInOnPage(page)) {
      logger.ok('当前 profile 已是登录态，无需重复登录');
      return true;
    }

    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await assertNoRiskControl(page);

    console.log(color('cyan', '\n请用「BOSS 直聘」App 扫描浏览器窗口中的二维码完成登录...'));
    console.log(color('dim', `（最长等待 ${Math.round(timeoutMs / 1000)} 秒）\n`));

    const deadline = Date.now() + timeoutMs;
    let logged = false;
    while (Date.now() < deadline) {
      await sleep(2500);
      // 风控页出现的处置：
      //  - wall（访问受限/IP 频控）：立即停止轮询，避免反复刷新加重频控
      //  - captcha（滑块）：继续等待，让用户在弹出的窗口里手动完成验证
      try {
        await assertNoRiskControl(page);
      } catch (e) {
        if (e.kind === 'wall') {
          logger.error(e.message);
          logger.error('已触发访问限制，停止登录轮询以免加重频控。请按上面的提示等待后再重试 boss login。');
          return false;
        }
        logger.warn(e.message);
      }
      logged = await isLoggedInOnPage(page).catch(() => false);
      if (logged) break;
      // 登录成功后 BOSS 通常会跳离 /web/user 登录页
      if (!page.url().includes('/web/user')) {
        await sleep(1500);
        logged = await isLoggedInOnPage(page).catch(() => false);
        if (logged) break;
      }
    }

    if (logged) {
      logger.ok('登录成功，登录态已持久化到本地 profile，后续命令免扫码复用');
      await sleep(1000); // 给 cookie 落盘留点时间
      return true;
    }
    logger.error('登录超时未完成。请重试 boss login，并确保在窗口内完成扫码确认');
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

module.exports = { login, logout, whoami, isLoggedInOnPage };
