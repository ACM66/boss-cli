'use strict';

// 浏览器上下文管理：用真实 Chrome + 持久化 profile 启动，注入 stealth 脚本。
// 这是整个工具抗反爬的地基：真实指纹 + 老化登录态 + 隐藏自动化特征。

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { USER_DATA_DIR } = require('./config');
const { logger, sleep } = require('./util');

// 清掉持久化 profile 的「会话恢复」状态（仅 tab/session 文件，绝不碰 Cookies/Local Storage 等登录态）。
// 实证（2026-06-03）：Chrome 每次退出都会写 Current/Last Session/Tabs；下次启动尝试恢复上次标签，
// 会和 Playwright 的 getPage/goto 打架，导致页面卡在 about:blank（goto 返回 200 但 body 为空、
// 等不到任何元素）。每次启动前清一遍，保证从干净状态导航。Singleton* 锁不动（用于并发检测）。
function cleanSessionState() {
  const def = path.join(USER_DATA_DIR, 'Default');
  const files = ['Current Session', 'Current Tabs', 'Last Session', 'Last Tabs'];
  for (const f of files) {
    try { fs.rmSync(path.join(def, f), { force: true }); } catch (_) {}
  }
  try { fs.rmSync(path.join(def, 'Sessions'), { recursive: true, force: true }); } catch (_) {}
}

// 持久化 profile 同一时刻只能被一个 Chrome 进程占用。识别这类“被占用”错误，
// 以便给出友好提示（而不是抛 Playwright 的 cryptic 报错）。
function isProfileLockError(msg) {
  return /SingletonLock|ProcessSingleton|Failed to create|profile.*in use|cannot create .*lock|browser is already running/i.test(
    msg || ''
  );
}

// 启动持久化上下文，遇到 profile lock 时短暂重试（应对“刚关上一个命令”的竞态）
async function launchWithRetry(opts) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      return await chromium.launchPersistentContext(USER_DATA_DIR, opts);
    } catch (e) {
      lastErr = e;
      if (isProfileLockError(e.message)) {
        logger.warn(`浏览器 profile 被占用，疑似有另一个 boss 命令在运行；重试中（${i + 1}/3）...`);
        await sleep(700);
        continue;
      }
      throw e; // 非 lock 错误立即抛，交由上层决定是否回退
    }
  }
  throw lastErr;
}

// 在任何页面脚本执行前注入，抹掉常见的自动化指纹特征。
// 注意：这些只是“别太显眼”，真正扛反爬靠的是真实 Chrome + 真实登录态。
const STEALTH_SCRIPT = `
(() => {
  // navigator.webdriver -> undefined
  try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}
  // 语言
  try { Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] }); } catch (e) {}
  // 插件数（无头常为 0）
  try {
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5].map((i) => ({ name: 'plugin' + i })),
    });
  } catch (e) {}
  // window.chrome
  try { if (!window.chrome) window.chrome = { runtime: {} }; } catch (e) {}
  // 通知权限查询的常见检测点
  try {
    const orig = navigator.permissions && navigator.permissions.query;
    if (orig) {
      navigator.permissions.query = (p) =>
        p && p.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : orig(p);
    }
  } catch (e) {}
  // WebGL 厂商/型号伪装成常见独显
  try {
    const getParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (p) {
      if (p === 37445) return 'Intel Inc.';
      if (p === 37446) return 'Intel Iris OpenGL Engine';
      return getParam.call(this, p);
    };
  } catch (e) {}
  // 合理的硬件参数
  try { Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 }); } catch (e) {}
  try { Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 }); } catch (e) {}
})();
`;

// 启动持久化上下文。优先用系统 Chrome（channel: 'chrome'），UA/指纹最真实；
// 找不到则回退到 Playwright 自带 Chromium 并告警。
async function openContext({ headless = false } = {}) {
  // 启动前清掉脏的会话恢复状态，避免页面卡在 about:blank（见 cleanSessionState 注释）
  cleanSessionState();

  const baseOpts = {
    headless,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    // 关掉“自动化受控”特征位
    args: ['--disable-blink-features=AutomationControlled', '--no-default-browser-check'],
    ignoreDefaultArgs: ['--enable-automation'],
  };

  let context;
  try {
    context = await launchWithRetry({ ...baseOpts, channel: 'chrome' });
    logger.debug('使用系统 Chrome 启动持久化上下文');
  } catch (e) {
    if (isProfileLockError(e.message)) {
      throw new Error(
        '浏览器 profile 被占用：请先关闭正在运行的其它 boss 命令（同一时刻只能跑一个），稍后重试。'
      );
    }
    logger.warn(`系统 Chrome 不可用（${e.message}），尝试回退到 Playwright 内置 Chromium...`);
    try {
      context = await launchWithRetry(baseOpts);
    } catch (e2) {
      if (isProfileLockError(e2.message)) {
        throw new Error('浏览器 profile 被占用：请先关闭其它 boss 命令后重试。');
      }
      throw new Error(
        '浏览器启动失败：未找到系统 Google Chrome，且 Playwright 内置 Chromium 也不可用。\n' +
          '请安装 Google Chrome，或运行：npx playwright install chromium\n' +
          `原始错误：${e2.message}`
      );
    }
  }

  await context.addInitScript(STEALTH_SCRIPT);
  // 收敛默认超时，避免卡死
  context.setDefaultTimeout(30000);
  context.setDefaultNavigationTimeout(45000);
  return context;
}

// 新开一个干净 page 来驱动。
// 实证（2026-06-03）：持久化上下文启动时自带一个初始 about:blank 页，直接复用它去 goto
// 偶发会和浏览器对该页的初始化竞态——goto 返回 200 但页面又被恢复成 about:blank（body 空、
// 等不到任何元素，表现为"时好时坏"）。改为新开一页驱动、关掉多余空白页，规避竞态。
async function getPage(context) {
  const page = await context.newPage();
  for (const p of context.pages()) {
    if (p !== page && p.url() === 'about:blank') {
      try { await p.close(); } catch (_) { /* 关闭失败不影响 */ }
    }
  }
  return page;
}

module.exports = { openContext, getPage, STEALTH_SCRIPT };
