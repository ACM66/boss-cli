'use strict';

// 反爬纪律集中在这里：限频、人类化行为、风控页检测。
// 设计原则：宁可慢、宁可停，绝不在风控页上反复重试硬刚。

const { sleep, randInt, logger } = require('./util');
const { RISK_SIGNALS } = require('./config');

class RiskControlError extends Error {
  // kind: 'captcha' | 'wall'
  constructor(message, kind = 'captcha') {
    super(message);
    this.name = 'RiskControlError';
    this.kind = kind;
  }
}

// 全局软限频：相邻“重动作”（导航/搜索/发起沟通）之间强制随机间隔，
// 模拟真人浏览节奏，降低被频控的概率。
class RateLimiter {
  constructor(minMs = 3000, maxMs = 7000) {
    this.minMs = minMs;
    this.maxMs = maxMs;
    this.last = 0;
  }

  async wait(label = '') {
    const now = Date.now();
    const target = randInt(this.minMs, this.maxMs);
    const elapsed = now - this.last;
    if (this.last && elapsed < target) {
      const waitMs = target - elapsed;
      logger.debug(`限频等待 ${waitMs}ms ${label}`);
      await sleep(waitMs);
    }
    this.last = Date.now();
  }
}

// 人类化短延迟（点击/输入前后的迟疑）
function humanDelay(min = 400, max = 1200) {
  return sleep(randInt(min, max));
}

// 检测当前页是否落到风控/验证页。命中即抛 RiskControlError，由上层决定如何停下。
// 先判“访问受限/需登录/频控”墙，再判“验证码/滑块”，处置建议不同。
async function assertNoRiskControl(page) {
  const url = page.url();
  let bodyText = '';
  try {
    bodyText = await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 2000) : ''));
  } catch (_) {
    /* 页面可能正在跳转 */
  }

  // 1) 访问受限 / 需登录 / IP 频控墙
  const wallUrl = RISK_SIGNALS.wallUrlParts.find((p) => url.includes(p));
  const wallTxt = RISK_SIGNALS.wallTexts.find((t) => bodyText.includes(t));
  if (wallUrl || wallTxt) {
    // 尝试把“将于 HH:MM 恢复正常”的解禁时间提取出来，给用户明确等待信息
    const m = bodyText.match(/将于\s*([\d:\-\s]+?)\s*恢复正常/);
    const recover = m ? `（限制约在 ${m[1].trim()} 解除）` : '';
    throw new RiskControlError(
      `撞到访问限制墙${recover}：${wallTxt || wallUrl}。\n` +
        `处置：① 若未登录，先运行 boss login；② 若已登录，说明触发了频控，请降低频率并稍后再试，不要反复刷新。`,
      'wall'
    );
  }

  // 2) 验证码 / 滑块
  const capUrl = RISK_SIGNALS.captchaUrlParts.find((p) => url.includes(p));
  const capTxt = RISK_SIGNALS.captchaTexts.find((t) => bodyText.includes(t));
  if (capUrl || capTxt) {
    throw new RiskControlError(
      `检测到人机验证「${capTxt || capUrl}」。请在弹出的浏览器窗口里手动完成验证后重试（建议用 --show / 非 --headless 运行）。`,
      'captcha'
    );
  }
}

// 在一组候选选择器里找到第一个真实可见的元素，返回其 locator（找不到返回 null）
async function firstVisible(page, selectors) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      if (await loc.count()) {
        if (await loc.isVisible().catch(() => false)) return loc;
      }
    } catch (_) {
      /* 选择器语法/瞬时态问题，试下一个 */
    }
  }
  return null;
}

// 人类化滚动：分多次小幅滚动并停顿，触发懒加载，同时模拟真人浏览
async function humanScroll(page, steps = 3) {
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, randInt(400, 900)).catch(() => {});
    await humanDelay(600, 1500);
  }
}

// 人类化点击：先 hover、再迟疑、再点
async function humanClick(loc) {
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await humanDelay(200, 600);
  await loc.hover().catch(() => {});
  await humanDelay(150, 500);
  await loc.click();
}

module.exports = {
  RiskControlError,
  RateLimiter,
  humanDelay,
  assertNoRiskControl,
  firstVisible,
  humanScroll,
  humanClick,
};
