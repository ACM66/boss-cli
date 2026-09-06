'use strict';

// 统一访问预算、异常暂停及页面交互辅助；这些措施不能保证平台接受自动化。

const fs = require('fs');
const path = require('path');
const { sleep, randInt, logger } = require('./util');
const { RISK_SIGNALS, ROOT_DIR, ACCESS_POLICY } = require('./config');

class RiskControlError extends Error {
  // kind: 'captcha' | 'wall'
  constructor(message, kind = 'captcha', retryAt = 0) {
    super(message);
    this.name = 'RiskControlError';
    this.kind = kind;
    this.retryAt = retryAt;
  }
}

function isBossUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) &&
      (url.hostname === 'zhipin.com' || url.hostname.endsWith('.zhipin.com'));
  } catch (_) { return false; }
}

function publicUrl(value) {
  try { const url = new URL(value); return url.origin + url.pathname; }
  catch (_) { return ''; }
}

function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function parseRecoveryTime(text, now = Date.now()) {
  const match = text.match(/将于\s*(?:(\d{4})-(\d{1,2})-(\d{1,2})\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*恢复正常/);
  if (!match) return 0;
  const chinaDate = new Date(now + 8 * 3600000);
  const year = match[1] ? Number(match[1]) : chinaDate.getUTCFullYear();
  const month = match[2] ? Number(match[2]) : chinaDate.getUTCMonth() + 1;
  const day = match[3] ? Number(match[3]) : chinaDate.getUTCDate();
  const hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6] || 0);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return 0;
  const stamp = Date.UTC(year, month - 1, day, hour - 8, minute, second);
  const check = new Date(stamp + 8 * 3600000);
  return check.getUTCFullYear() === year && check.getUTCMonth() + 1 === month && check.getUTCDate() === day ? stamp : 0;
}

function classifyRisk({ url = '', text = '', status, headers = {} }, now = Date.now()) {
  if (!isBossUrl(url)) return null;
  const pathname = new URL(url).pathname;
  // 接口名称可能包含 captcha/security（例如登录初始化）；名称不代表展示了验证页。
  const isApi = pathname.startsWith('/wapi/');
  const wall = (!isApi && RISK_SIGNALS.wallUrlParts.find((part) => pathname.includes(part))) ||
    RISK_SIGNALS.wallTexts.find((part) => text.includes(part));
  if (wall) return new RiskControlError(`平台限制访问：${wall}。具体触发原因未确认，请按平台提示处理。`, 'wall', parseRecoveryTime(text, now));
  if (status === 403 || status === 429) {
    const retry = Object.entries(headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
    const value = String(retry ?? '').trim();
    const retryAt = /^\d+$/.test(value) ? now + Number(value) * 1000 : Date.parse(value);
    return new RiskControlError(`平台返回 HTTP ${status}，已停止后续访问。`, 'http_limit', Number.isSafeInteger(retryAt) && Math.abs(retryAt) < 8640000000000000 ? retryAt : 0);
  }
  const captcha = (!isApi && RISK_SIGNALS.captchaUrlParts.find((part) => pathname.includes(part))) ||
    RISK_SIGNALS.captchaTexts.find((part) => text.includes(part));
  if (captcha) return new RiskControlError(`平台要求人工验证：${captcha}。自动操作已暂停，请通过官方页面完成验证。`, 'captcha');
  return null;
}

// 在浏览器命令锁内使用；导航、写操作和风险事件共享同一份跨进程记录。
class AccessGuard {
  constructor({ rootDir = ROOT_DIR, policy = {} } = {}) {
    this.logScope = rootDir === ROOT_DIR ? '' : '[隔离目录] ';
    this.stateFile = path.join(rootDir, 'access-state.json');
    this.policyFile = path.join(rootDir, 'access-policy.json');
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(this.policyFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error(`无法读取访问策略：${error.message}`); }
    for (const source of [saved, policy]) {
      if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('访问策略必须为 JSON 对象');
      for (const [key, value] of Object.entries(source)) {
        if (!Object.hasOwn(ACCESS_POLICY, key) || !Number.isSafeInteger(value) || value < 0 ||
            value > (key.endsWith('Ms') ? 30 * 86400000 : 100000) ||
            (key.startsWith('max') && value === 0) || (key === 'cooldownMs' && value === 0)) {
          throw new Error(`无效访问策略：${key}`);
        }
      }
    }
    this.policy = { ...ACCESS_POLICY, ...saved, ...policy };
  }

  readState() {
    let state;
    try { state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`无法读取访问记录，已停止操作：${error.message}`);
      return { version: 1, navigations: [], writes: [], navEvents: [], apiResponses: [], lastNavigation: 0, lastWrite: 0, cooldown: null };
    }
    const stamp = (value) => Number.isSafeInteger(value) && value >= 0;
    if (!state || state.version !== 1 || !stamp(state.lastNavigation) || !stamp(state.lastWrite) ||
        !['navigations', 'writes', 'navEvents', 'apiResponses'].every((key) =>
          Array.isArray(state[key]) && state[key].length <= 100000 && state[key].every(stamp)) ||
        (state.cooldown !== null && (!state.cooldown || !stamp(state.cooldown.until) ||
          typeof state.cooldown.reason !== 'string' || typeof state.cooldown.kind !== 'string'))) {
      throw new Error(`访问记录损坏，已停止操作：${this.stateFile}`);
    }
    const now = Date.now();
    for (const key of ['navigations', 'writes']) state[key] = state[key].filter((time) => time > now - 86400000).sort((a, b) => a - b);
    for (const key of ['navEvents', 'apiResponses']) state[key] = state[key].filter((time) => time > now - 60000).sort((a, b) => a - b);
    return state;
  }

  assertAllowed() {
    const state = this.readState();
    if (state.cooldown?.until > Date.now()) {
      throw new RiskControlError(`${state.cooldown.reason} 本地暂停至 ${new Date(state.cooldown.until).toISOString()}；不会通过重启命令重试。`, state.cooldown.kind, state.cooldown.until);
    }
    return state;
  }

  recordRisk(error, url = '') {
    const state = this.readState();
    const until = Math.max(Date.now() + this.policy.cooldownMs,
      (error.retryAt || 0) + this.policy.recoveryBufferMs, state.cooldown?.until || 0);
    state.cooldown = { until, kind: error.kind || 'unknown', reason: error.message.slice(0, 400), url: publicUrl(url) };
    writeJSON(this.stateFile, state);
    error.retryAt = until;
    logger.warn(`${this.logScope}访问已暂停至 ${new Date(until).toISOString()}：${state.cooldown.reason}`);
    return error;
  }

  checkBudget(state, write) {
    const now = Date.now();
    const checks = write ? [[state.writes, this.policy.maxWritesPerDay, 86400000, '24 小时写操作']] : [
      [state.navigations.filter((time) => time > now - 3600000), this.policy.maxNavigationsPerHour, 3600000, '每小时页面访问'],
      [state.navigations, this.policy.maxNavigationsPerDay, 86400000, '24 小时页面访问'],
    ];
    for (const [history, limit, windowMs, label] of checks) {
      if (history.length >= limit) throw new RiskControlError(`已达到本工具的${label}预算 ${limit} 次，稍后再操作。此预算不是平台安全阈值。`, 'budget', history[history.length - limit] + windowMs);
    }
  }

  async beforeAction(url, write, { signal } = {}) {
    signal?.throwIfAborted();
    if (!isBossUrl(url)) return;
    let state = this.assertAllowed();
    this.checkBudget(state, write);
    const now = Date.now();
    const last = Math.max(state.lastNavigation, state.lastWrite);
    if (last > now) throw new Error('系统时间早于最近访问记录，已停止操作；请检查系统时钟。');
    const interval = write ? this.policy.writeIntervalMs : this.policy.navigationIntervalMs;
    const waitMs = Math.max(0, interval - (now - last));
    if (waitMs) logger.info(`${this.logScope}按本地访问策略等待 ${Math.ceil(waitMs / 1000)} 秒`);
    const deadline = now + waitMs;
    while (Date.now() < deadline) {
      await sleep(Math.min(250, deadline - Date.now()));
      signal?.throwIfAborted();
      this.assertAllowed();
    }
    // 等待期间页面自身可能产生风险事件，必须重新检查并合并磁盘最新状态。
    state = this.assertAllowed();
    signal?.throwIfAborted();
    this.checkBudget(state, write);
    const time = Date.now();
    state[write ? 'writes' : 'navigations'].push(time);
    state[write ? 'lastWrite' : 'lastNavigation'] = time;
    writeJSON(this.stateFile, state);
  }

  beforeNavigation(url, options) { return this.beforeAction(url, false, options); }
  beforeWrite(url, options) { return this.beforeAction(url, true, options); }

  inspectNavigation(url) {
    if (!isBossUrl(url)) return null;
    const state = this.assertAllowed();
    const risk = classifyRisk({ url });
    if (risk) return this.recordRisk(risk, url);
    state.navEvents.push(Date.now());
    writeJSON(this.stateFile, state);
    if (state.navEvents.length > this.policy.maxNavigationEventsPerMinute) {
      return this.recordRisk(new RiskControlError('页面短时间内反复导航，已停止加载以避免跳转循环。', 'navigation_loop'), url);
    }
    return null;
  }

  inspectResponse({ url, status, headers }) {
    if (!isBossUrl(url)) return null;
    const state = this.assertAllowed();
    const risk = classifyRisk({ url, status, headers });
    if (risk) return this.recordRisk(risk, url);
    if (new URL(url).pathname.startsWith('/wapi/')) {
      state.apiResponses.push(Date.now());
      writeJSON(this.stateFile, state);
      if (state.apiResponses.length > this.policy.maxApiResponsesPerMinute) {
        return this.recordRisk(new RiskControlError('页面短时间内产生过多业务接口响应，已停止后续访问。', 'request_volume'), url);
      }
    }
    return null;
  }

  async assertPage(page) {
    this.assertAllowed();
    const text = await page.evaluate(() => document.body?.innerText.slice(0, 4000) || '');
    const risk = classifyRisk({ url: page.url(), text });
    if (risk) throw this.recordRisk(risk, page.url());
  }

  status() {
    const state = this.readState();
    const now = Date.now();
    return {
      checkedAt: new Date(now).toISOString(), networkAccessed: false,
      paused: Boolean(state.cooldown?.until > now),
      cooldown: state.cooldown ? { ...state.cooldown, until: new Date(state.cooldown.until).toISOString() } : null,
      usage: { navigationsLastHour: state.navigations.filter((time) => time > now - 3600000).length, navigationsLast24Hours: state.navigations.length, writesLast24Hours: state.writes.length },
      policy: this.policy,
    };
  }
}

// 同 profile 的命令由 browser 层串行执行；落盘时间戳让不同 CLI 进程共享动作间隔。
class RateLimiter {
  constructor(minMs = 3000, maxMs = 7000, stateFile = path.join(ROOT_DIR, 'action-time.json')) {
    this.minMs = minMs;
    this.maxMs = maxMs;
    this.last = 0;
    this.stateFile = stateFile;
  }

  async wait(label = '') {
    let savedLast = 0;
    try {
      const state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (!state || !Number.isSafeInteger(state.last) || state.last < 0) {
        throw new Error('最近动作时间必须是非负整数');
      }
      savedLast = state.last;
    } catch (e) {
      if (e.code !== 'ENOENT') {
        throw new Error(`无法读取限频状态 ${this.stateFile}，已停止操作：${e.message}`);
      }
    }
    this.last = Math.max(this.last, savedLast);
    const target = randInt(this.minMs, this.maxMs);
    while (this.last && Date.now() - this.last < target) {
      const waitMs = target - (Date.now() - this.last);
      logger.debug(`限频等待 ${waitMs}ms ${label}`);
      await sleep(waitMs);
    }

    const last = Date.now();
    const tmp = `${this.stateFile}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify({ last }), { mode: 0o600 });
      fs.renameSync(tmp, this.stateFile);
    } catch (e) {
      throw new Error(`无法保存限频状态 ${this.stateFile}，已停止操作：${e.message}`);
    }
    this.last = last;
  }
}

// 人类化短延迟（点击/输入前后的迟疑）
function humanDelay(min = 400, max = 1200) {
  return sleep(randInt(min, max));
}

// 检测当前页是否落到风控/验证页。命中即抛 RiskControlError，由上层决定如何停下。
// 先判“访问受限/需登录/频控”墙，再判“验证码/滑块”，处置建议不同。
async function assertNoRiskControl(page) {
  const context = page.context?.();
  const guard = context?.accessGuard;
  if (guard) {
    try { return await guard.assertPage(page); }
    catch (error) { await context.freeze(error); throw error; }
  }
  const text = await page.evaluate(() => document.body?.innerText.slice(0, 4000) || '');
  const risk = classifyRisk({ url: page.url(), text });
  if (risk) throw risk;
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
  AccessGuard,
  isBossUrl,
  classifyRisk,
  parseRecoveryTime,
  RateLimiter,
  humanDelay,
  assertNoRiskControl,
  firstVisible,
  humanScroll,
  humanClick,
};
