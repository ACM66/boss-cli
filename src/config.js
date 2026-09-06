'use strict';

const os = require('os');
const path = require('path');

const HOME = os.homedir();

// 所有运行时状态集中在 ~/.boss-cli 下，绝不放进仓库
const ROOT_DIR = path.join(HOME, '.boss-cli');
// 持久化 Chrome profile —— 反爬第一对策：登录态老化、cookie 真实
const USER_DATA_DIR = path.join(ROOT_DIR, 'userdata');
const LOG_DIR = path.join(ROOT_DIR, 'logs');

const BASE_URL = 'https://www.zhipin.com';

// 登录入口（求职者侧）
const LOGIN_URL = `${BASE_URL}/web/user/?ka=header-login`;
const SEARCH_URL = `${BASE_URL}/web/geek/jobs`;
// 求职者推荐页（需要登录态，用作登录态探测）
const RECOMMEND_URL = `${BASE_URL}/web/geek/recommend`;

// BOSS 直聘城市编码（与中国天气网同源的城市码，非行政区划码）。
// 不在表里的城市，直接用 `--city <code>` 传原始编码。
const CITY_CODES = {
  全国: '100010000',
  北京: '101010100',
  上海: '101020100',
  广州: '101280100',
  深圳: '101280600',
  杭州: '101210100',
  成都: '101270100',
  武汉: '101200100',
  南京: '101190100',
  西安: '101110100',
  苏州: '101190400',
  厦门: '101230200',
  长沙: '101250100',
  天津: '101030100',
  重庆: '101040100',
  郑州: '101180100',
  东莞: '101281600',
  福州: '101230100',
  合肥: '101220100',
  青岛: '101120200',
};

// 按操作记录真实页面验收；查询和发送前检查通过不代表消息发送已验收。
// greet 的 2026-09-06 指 startChat 按钮在真实岗位页建立联系已验收（证据见
// log/2026-09-06-e2e-result.md 与 log/e2e-live-2026-09-06.json 的 greet_contact）；
// 独立 CLI 的 `greet -m` 自定义消息仍未适配，由 src/chat.js 单独拦截。
const SELECTORS_CALIBRATED_AT = { search: '2026-09-05', detail: '2026-09-05', greet: '2026-09-06' };

// 本工具的保守访问预算，不代表平台公布或验证过的安全阈值。
const ACCESS_POLICY = {
  navigationIntervalMs: 15000,
  writeIntervalMs: 60000,
  maxNavigationsPerHour: 30,
  maxNavigationsPerDay: 200,
  maxWritesPerDay: 10,
  maxNavigationEventsPerMinute: 8,
  maxApiResponsesPerMinute: 120,
  cooldownMs: 30 * 60 * 1000,
  recoveryBufferMs: 5 * 60 * 1000,
  cacheTtlMs: 5 * 60 * 1000,
};

// 集中管理页面选择器：BOSS 前端是 SPA，DOM 会随版本漂移。
// 每个语义都给一组候选选择器，按顺序兜底，便于后续单点维护。
const SELECTORS = {
  // 首页/任意页判断是否已登录：登录入口存在 = 未登录
  loginEntry: ['.header-login-btn', 'a[ka="header-login"]', '.nav-figure .login-text'],
  // 已登录后头像/用户菜单
  loggedInMark: ['.nav-figure a[ka="header-username"] img'],
  // 搜索结果岗位卡片
  jobCard: ['.job-card-box', '.job-card-wrapper', 'li.job-primary'],
  // 卡片内字段（相对卡片根）
  jobName: ['.job-name', '.job-title .job-name', '.name .job-name'],
  jobSalary: ['.job-salary', '.salary', '.job-limit .red'],
  jobArea: ['.job-area', '.job-area-wrapper .job-area', '.company-location'],
  jobLink: ['a.job-card-left', 'a.job-card-body', 'a[href*="/job_detail/"]', 'a[ka^="search_list"]'],
  jobCompany: ['.boss-name', '.company-name', '.company-info .company-name', '.company-text .name'],
  jobTags: ['.tag-list li', '.tag-list span', '.company-tag-list li'],
  jobExp: ['.job-info .tag-list li:nth-child(1)', '.job-card-footer .tag-list li'],
  detailName: ['.job-banner .name h1'],
  detailSalary: ['.job-banner .salary'],
  detailCompany: ['.sider-company a[ka^="job-detail-company_"]', '.sider-company .company-info a[title]'],
  detailDesc: ['.job-detail .job-sec-text', '.job-sec-text'],
  // 岗位详情页：发起沟通按钮（打招呼）
  startChat: [
    '.btn.btn-startchat',
    'a.btn-startchat',
    '.op-btn-chat',
    '.btn-startchat',
    'a[ka="job-detail-startchat"]',
  ],
  // 沟通页输入框与发送
  chatInput: ['#chat-input', '.chat-input', '.input-area textarea', 'div[contenteditable="true"].chat-input'],
  chatSend: ['.btn-send', '.submit-btn', 'button[type="submit"]'],
};

// 风控/验证页特征：URL 或文本命中即视为撞墙，停下，绝不硬刚。
// 分两类，给出不同的处置建议：
//  - captcha：滑块/验证码 → 需在窗口里手动完成验证
//  - wall：访问受限 / 需登录 / IP 频控（如 /web/passport/zp/403.html）
//          → 停止访问并按平台提示处理，无法仅凭此页面确定风控根因
// 实证来源（2026-06-03）：logged-out 访问 /web/geek/job 被跳到 403 页，
// 文案「访问受限…您的 IP 存在异常行为，请登录后使用…将于 HH:MM 恢复正常」。
const RISK_SIGNALS = {
  captchaUrlParts: ['/web/common/security-check', '/web/passport/zp/security.html', 'verify-slider', '/safe/verify', 'captcha'],
  captchaTexts: ['安全验证', '完成验证', '滑动验证', '拖动下方滑块', 'security check', '请完成以下验证'],
  wallUrlParts: ['/web/passport/zp/403', 'passport/zp/403', '/passport/error'],
  wallTexts: ['访问受限', '暂时无法访问此页面', 'IP 存在异常', '暂时被禁止访问', '违规访问行为'],
};

module.exports = {
  HOME,
  ROOT_DIR,
  USER_DATA_DIR,
  LOG_DIR,
  BASE_URL,
  LOGIN_URL,
  SEARCH_URL,
  RECOMMEND_URL,
  CITY_CODES,
  SELECTORS,
  SELECTORS_CALIBRATED_AT,
  ACCESS_POLICY,
  RISK_SIGNALS,
};
