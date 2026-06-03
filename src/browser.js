'use strict';

// 浏览器上下文管理：用真实 Chrome + 持久化 profile 启动，注入 stealth 脚本。
// 这是整个工具抗反爬的地基：真实指纹 + 老化登录态 + 隐藏自动化特征。

const { chromium } = require('playwright');
const { USER_DATA_DIR } = require('./config');
const { logger, sleep } = require('./util');

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

// 拿到上下文里第一个 page（持久化上下文启动时会带一个空白页），没有就新建
async function getPage(context) {
  const pages = context.pages();
  const page = pages.length ? pages[0] : await context.newPage();
  return page;
}

module.exports = { openContext, getPage, STEALTH_SCRIPT };
