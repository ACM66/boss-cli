'use strict';

// 与 HR 打招呼：导航到岗位详情页，点「立即沟通」发起会话，可选追加一句自定义开场白。
// 这是写操作，全程走真实 UI 点击（最贴近真人、最抗反爬），不直接调接口。
// 默认弹出可见窗口，便于用户观察过程、必要时人工接管处理验证。

const { openContext, getPage } = require('./browser');
const { SELECTORS } = require('./config');
const { sleep, logger, warnIfUncalibrated } = require('./util');
const {
  RateLimiter,
  assertNoRiskControl,
  firstVisible,
  humanClick,
  humanDelay,
} = require('./anticrawl');
const { isLoggedInOnPage, hasLoginCookie } = require('./auth');
const { normalizeJobUrl } = require('./jobs');

const limiter = new RateLimiter(5000, 12000); // 写操作更保守，间隔更长

async function greet({ job, message, headless = false }) {
  const url = normalizeJobUrl(job); // 含 zhipin.com 域名白名单校验
  warnIfUncalibrated();
  const context = await openContext({ headless });
  try {
    const page = await getPage(context);
    // 未登录前置闸门（离线，导航前）：未登录打招呼必失败且会撞墙烧 IP，先拦下；
    // 导航后另有 isLoggedInOnPage 兜底（cookie 在但已过期的情况）。
    if (!(await hasLoginCookie(context))) {
      logger.error('未登录，无法打招呼。请先运行：boss login');
      return false;
    }
    await limiter.wait('greet');
    logger.info(`准备与岗位 HR 打招呼：${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await assertNoRiskControl(page);
    await sleep(1500);

    // 必须已登录，否则点了也只会被导去登录
    if (!(await isLoggedInOnPage(page))) {
      logger.error('未登录，无法打招呼。请先运行：boss login');
      return false;
    }

    // 找“立即沟通/我要应聘/继续沟通”按钮
    const startBtn = await firstVisible(page, SELECTORS.startChat);
    if (!startBtn) {
      logger.error('未找到「立即沟通」按钮：可能岗位已停招、已沟通过，或按钮选择器漂移（见 config.js startChat）');
      return false;
    }

    const btnText = (await startBtn.textContent().catch(() => '')) || '';
    logger.info(`点击沟通按钮：「${btnText.trim() || '立即沟通'}」`);
    await humanClick(startBtn);
    await sleep(2500);
    await assertNoRiskControl(page);

    // 沟通界面可能在当前页弹层打开，也可能在新标签页打开——取上下文里最新的页面
    const pages = context.pages();
    const activePage = pages.length ? pages[pages.length - 1] : page;
    if (activePage !== page) await assertNoRiskControl(activePage);

    // 关键：必须确认沟通界面“真的打开”（找到聊天输入框）才算成功，绝不臆测“假成功”。
    // 找不到输入框时如实返回失败 + 可诊断的原因，让用户能自救。
    const input = await firstVisible(activePage, SELECTORS.chatInput);
    if (!input) {
      logger.error(
        '点击沟通按钮后未检测到聊天输入框，无法确认沟通已发起。可能原因：' +
          '岗位已停招 / 已沟通过 / 需先完善简历 / 触发了验证 / 聊天界面选择器漂移（见 config.js chatInput）。' +
          '建议加 --headless 关闭后用可见窗口（默认即可见）观察实际页面。'
      );
      return false;
    }

    // 到这里沟通界面已确认打开，BOSS 通常已自动发出默认招呼语。
    // 若用户给了自定义开场白，则补发一句。
    if (message) {
      await input.click().catch(() => {});
      await humanDelay(300, 800);
      await input.type(message, { delay: 60 }); // 逐字输入，模拟真人打字
      await humanDelay(400, 900);

      const sendBtn = await firstVisible(activePage, SELECTORS.chatSend);
      if (sendBtn) {
        await humanClick(sendBtn);
      } else {
        await activePage.keyboard.press('Enter'); // 兜底：回车发送
      }
      await sleep(1500);
      // 隐私：开场白可能含个人信息，日志只记字数不记明文
      logger.ok(`已发起沟通并发送开场白（${message.length} 字）`);
    } else {
      logger.ok('已发起沟通（聊天界面已打开，BOSS 默认招呼语应已发送）');
    }
    return true;
  } finally {
    // 给会话写入留点时间再关闭；错误统一由 bin/boss.js 顶层 catch 打印
    await sleep(800);
    await context.close();
  }
}

module.exports = { greet };
