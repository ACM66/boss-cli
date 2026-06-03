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

// ⚠️ 选择器校准状态：登录态下的搜索结果页 / 岗位详情页 / 打招呼按钮 / 聊天输入框
// 这些选择器为“先验值”，截至 2026-06-03 仅验证了首页可达，尚未在真实登录态下校准。
// 首次使用务必用 --show 跑一遍 search/show/greet 校准（方法见 README「选择器校准」）。
// 校准通过后把下面改成日期字符串（如 '2026-06-10'），运行时即不再提示风险。
const SELECTORS_CALIBRATED_AT = null;

// 集中管理页面选择器：BOSS 前端是 SPA，DOM 会随版本漂移。
// 每个语义都给一组候选选择器，按顺序兜底，便于后续单点维护。
const SELECTORS = {
  // 首页/任意页判断是否已登录：登录入口存在 = 未登录
  loginEntry: ['.header-login-btn', 'a[ka="header-login"]', '.nav-figure .login-text'],
  // 已登录后头像/用户菜单
  loggedInMark: ['.nav-figure img', '.user-nav', '.geek-nav'],
  // 搜索结果岗位卡片
  jobCard: ['.job-card-wrapper', '.job-list-box .job-card-box', 'li.job-primary'],
  // 卡片内字段（相对卡片根）
  jobName: ['.job-name', '.job-title .job-name', '.name .job-name'],
  jobSalary: ['.salary', '.job-limit .red', '.job-title .salary'],
  jobArea: ['.job-area', '.job-area-wrapper .job-area', '.company-location'],
  jobLink: ['a.job-card-left', 'a.job-card-body', 'a[href*="/job_detail/"]', 'a[ka^="search_list"]'],
  jobCompany: ['.company-name', '.company-info .company-name', '.company-text .name'],
  jobTags: ['.tag-list li', '.tag-list span', '.company-tag-list li'],
  jobExp: ['.job-info .tag-list li:nth-child(1)', '.job-card-footer .tag-list li'],
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
//          → 先登录；已登录则是触发频控，需冷却等待
// 实证来源（2026-06-03）：logged-out 访问 /web/geek/job 被跳到 403 页，
// 文案「访问受限…您的 IP 存在异常行为，请登录后使用…将于 HH:MM 恢复正常」。
const RISK_SIGNALS = {
  captchaUrlParts: ['/web/common/security-check', 'verify-slider', '/safe/verify', 'captcha'],
  captchaTexts: ['安全验证', '完成验证', '滑动验证', '拖动下方滑块', 'security check', '请完成以下验证'],
  wallUrlParts: ['/web/passport/zp/403', 'passport/zp/403', '/passport/error'],
  wallTexts: ['访问受限', '无法访问此页面', 'IP 存在异常', '禁止访问', '请登录后使用', '违规访问行为', '恢复正常'],
};

module.exports = {
  HOME,
  ROOT_DIR,
  USER_DATA_DIR,
  LOG_DIR,
  BASE_URL,
  LOGIN_URL,
  RECOMMEND_URL,
  CITY_CODES,
  SELECTORS,
  SELECTORS_CALIBRATED_AT,
  RISK_SIGNALS,
};
