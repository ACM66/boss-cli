'use strict';

// 岗位查询：搜索列表 + 详情抓取。
// 反爬策略：不直接调签名 API，而是导航到真实搜索页、让站点自己的 JS 带 __zp_stoken__
// 把数据渲染出来，我们只从 DOM 读结果——和真人浏览无法区分。

const { openContext, getPage } = require('./browser');
const { BASE_URL, CITY_CODES, SELECTORS } = require('./config');
const { logger, printTable, warnIfUncalibrated } = require('./util');
const { RateLimiter, assertNoRiskControl, humanScroll } = require('./anticrawl');
const { hasLoginCookie } = require('./auth');

const limiter = new RateLimiter(3000, 7000);

function resolveCity(city) {
  if (!city) return CITY_CODES['全国'];
  if (/^\d+$/.test(city)) return city; // 已经是编码
  if (CITY_CODES[city]) return CITY_CODES[city];
  logger.warn(`未知城市「${city}」，已退回全国。可直接传城市编码：--city 101010100`);
  return CITY_CODES['全国'];
}

// 在浏览器内提取岗位卡片。把候选选择器传进页面上下文，逐个兜底。
async function extractJobs(page, sel) {
  return page.evaluate((S) => {
    const pick = (root, list) => {
      for (const s of list) {
        const el = root.querySelector(s);
        if (el) return el;
      }
      return null;
    };
    const pickAll = (root, list) => {
      for (const s of list) {
        const els = root.querySelectorAll(s);
        if (els && els.length) return Array.from(els);
      }
      return [];
    };
    let cards = [];
    for (const s of S.jobCard) {
      cards = Array.from(document.querySelectorAll(s));
      if (cards.length) break;
    }
    return cards.map((card) => {
      const text = (el) => (el ? el.textContent.trim().replace(/\s+/g, ' ') : '');
      const linkEl = pick(card, S.jobLink);
      let href = linkEl ? linkEl.getAttribute('href') : '';
      if (href && href.startsWith('/')) href = location.origin + href;
      return {
        name: text(pick(card, S.jobName)),
        salary: text(pick(card, S.jobSalary)),
        area: text(pick(card, S.jobArea)),
        company: text(pick(card, S.jobCompany)),
        tags: pickAll(card, S.jobTags).map((e) => e.textContent.trim()).filter(Boolean),
        url: href,
      };
    });
  }, sel);
}

async function search({ query, city, limit = 20, headless = true }) {
  if (!query) throw new Error('请提供搜索关键词，例如：boss search "后端工程师"');
  warnIfUncalibrated();
  const cityCode = resolveCity(city);
  const url = `${BASE_URL}/web/geek/job?query=${encodeURIComponent(query)}&city=${cityCode}`;

  const context = await openContext({ headless });
  try {
    const page = await getPage(context);
    // 未登录前置闸门（离线，导航前）：BOSS 对未登录的岗位搜索会跳 403 访问受限墙、
    // 并触发 IP 频控（实证见 README「已知约束」）。在 page.goto 之前就拦下，避免白烧 IP。
    if (!(await hasLoginCookie(context))) {
      throw new Error(
        '未登录：BOSS 对未登录的岗位搜索会跳 403 访问受限墙并触发 IP 频控，已在导航前拦下。请先运行：boss login'
      );
    }
    await limiter.wait('search');
    logger.info(`搜索：${query} @ city=${cityCode}`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await assertNoRiskControl(page);

    // 等岗位卡片渲染（站点 JS 自行带签名拉数据）
    const cardSel = SELECTORS.jobCard.join(', ');
    try {
      await page.waitForSelector(cardSel, { timeout: 20000 });
    } catch (_) {
      await assertNoRiskControl(page); // 可能是被风控拦了
      logger.warn('未等到岗位卡片，可能是无结果、需登录或 DOM 结构已变化');
    }

    await humanScroll(page, 2); // 触发懒加载 + 模拟真人
    const jobs = await extractJobs(page, SELECTORS);
    const sliced = jobs.slice(0, limit);

    if (!sliced.length) {
      // 区分三种“空”：选择器漂移 / 需登录 / 确实无结果，给针对性提示，不笼统甩锅选择器
      const diag = await page.evaluate(() => {
        const body = document.body ? document.body.innerText : '';
        return {
          hasJobish: !!document.querySelector('[class*="job"], a[href*="/job_detail/"]'),
          needLogin: /登录后查看|请登录|扫码登录/.test(body),
          len: body.length,
        };
      });
      if (diag.hasJobish) {
        logger.warn(
          '页面里检测到疑似岗位元素，但现有选择器没解析出来——基本可判定是选择器漂移。' +
            '请按 README「选择器校准」更新 config.js 的 SELECTORS（jobCard / jobName 等）。'
        );
      } else if (diag.needLogin) {
        logger.warn('页面要求登录。请先运行 boss login 扫码登录后再搜索。');
      } else {
        logger.warn('没有解析到岗位：可能该条件下确实无结果，或页面结构已变化。可加 --show 打开窗口核对。');
      }
      return [];
    }

    // 业务结果走 stdout
    if (process.env.BOSS_JSON) {
      console.log(JSON.stringify(sliced, null, 2));
    } else {
      printTable(
        ['#', '岗位', '薪资', '公司', '地区'],
        sliced.map((j, i) => [i + 1, j.name, j.salary, j.company, j.area])
      );
      console.log('');
      sliced.forEach((j, i) => {
        if (j.url) console.log(`  ${i + 1}. ${j.url}`);
      });
    }
    logger.ok(`共解析 ${sliced.length} 个岗位`);
    return sliced;
  } finally {
    // 错误统一由 bin/boss.js 顶层 catch 打印，这里只负责释放浏览器
    await context.close();
  }
}

// 岗位详情：传入 job_detail 完整 URL 或加密 id。
// 安全：show/greet 会在“带登录态”的浏览器里 page.goto 这个 URL，必须把目标限定在 zhipin.com，
// 否则可被诱导把用户的登录态带去任意站点（认证态滥用 / CSRF 式风险）。
function normalizeJobUrl(idOrUrl) {
  if (!idOrUrl) throw new Error('请提供岗位 URL 或加密 id');
  if (/^https?:\/\//.test(idOrUrl)) {
    let u;
    try {
      u = new URL(idOrUrl);
    } catch (_) {
      throw new Error(`非法 URL：${idOrUrl}`);
    }
    const host = u.hostname.toLowerCase();
    if (host !== 'zhipin.com' && !host.endsWith('.zhipin.com')) {
      throw new Error(`出于安全考虑，只允许 zhipin.com 域名的链接，拒绝：${host}`);
    }
    return u.toString();
  }
  // 纯 id：做基本字符校验，避免拼接出畸形/越界路径
  const id = String(idOrUrl).replace(/\.html.*$/, '');
  if (!/^[A-Za-z0-9~_-]+$/.test(id)) {
    throw new Error(`非法岗位 id：${idOrUrl}`);
  }
  return `${BASE_URL}/job_detail/${id}.html`;
}

async function detail({ job, headless = true }) {
  const url = normalizeJobUrl(job);
  const context = await openContext({ headless });
  try {
    const page = await getPage(context);
    // 未登录前置闸门（离线，导航前）：未登录访问岗位详情同样会撞 403 墙并触发频控，先拦下
    if (!(await hasLoginCookie(context))) {
      throw new Error(
        '未登录：BOSS 对未登录的岗位详情访问会跳 403 访问受限墙并触发 IP 频控，已在导航前拦下。请先运行：boss login'
      );
    }
    await limiter.wait('detail');
    logger.info(`打开岗位详情：${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await assertNoRiskControl(page);
    await page.waitForTimeout(1500);

    const info = await page.evaluate(() => {
      const t = (s) => {
        const el = document.querySelector(s);
        return el ? el.textContent.trim().replace(/\s+/g, ' ') : '';
      };
      return {
        name: t('.job-banner .name h1') || t('.job-primary .name') || t('h1'),
        salary: t('.job-banner .salary') || t('.salary'),
        company: t('.company-info .name') || t('.sider-company .name'),
        desc:
          (document.querySelector('.job-detail-section .desc, .job-sec-text, .job-detail .text')
            ? document
                .querySelector('.job-detail-section .desc, .job-sec-text, .job-detail .text')
                .innerText.trim()
            : '') || '',
      };
    });

    if (process.env.BOSS_JSON) {
      console.log(JSON.stringify({ url, ...info }, null, 2));
    } else {
      console.log(`\n岗位：${info.name}   ${info.salary}`);
      console.log(`公司：${info.company}`);
      console.log(`链接：${url}`);
      if (info.desc) console.log(`\n职位描述：\n${info.desc}\n`);
    }
    return { url, ...info };
  } finally {
    await context.close();
  }
}

module.exports = { search, detail, resolveCity, normalizeJobUrl };
