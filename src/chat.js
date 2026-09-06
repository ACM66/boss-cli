'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { openContext, getPage } = require('./browser');
const { ROOT_DIR, SELECTORS } = require('./config');
const { logger, warnIfUncalibrated } = require('./util');
const { assertNoRiskControl, firstVisible, humanClick } = require('./anticrawl');
const { isLoggedInOnPage, hasLoginCookie } = require('./auth');
const { normalizeJobUrl, readDetail } = require('./jobs');

function contactJobId(job) {
  return new URL(normalizeJobUrl(job)).pathname.match(/^\/job_detail\/([A-Za-z0-9~_-]+)\.html$/)[1];
}

// 调用方持有浏览器命令锁。记录先于点击持久化，进程中断也不能自动重放。
class ContactLedger {
  constructor(directory = path.join(ROOT_DIR, 'contact-intents')) { this.directory = directory; }
  filename(job) { return path.join(this.directory, contactJobId(job) + '.json'); }
  read(job) {
    let descriptor;
    try {
      descriptor = fs.openSync(this.filename(job), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      if (!fs.fstatSync(descriptor).isFile()) throw new Error('不是常规文件');
      const value = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
      if (value?.version !== 1 || value.jobId !== contactJobId(job) ||
          !['intent', 'unknown', 'confirmed'].includes(value.state) ||
          typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string' ||
          !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt)) ||
          Object.keys(value).sort().join(',') !== 'createdAt,jobId,state,updatedAt,version') {
        throw new Error('结构不正确');
      }
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error('沟通记录无法可靠读取，已停止操作；请人工核对，不要删除记录后重试：' + error.message);
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  }
  assertNew(job) {
    const existing = this.read(job);
    if (existing) throw new Error('该岗位已有沟通记录（' + existing.state + '），不会重复点击。请在 BOSS 人工核对结果。');
  }
  persist(filename, record) {
    const descriptor = fs.openSync(filename, 'wx', 0o600);
    try {
      fs.fchmodSync(descriptor, 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(record) + '\n');
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
  }
  syncDirectory() {
    const descriptor = fs.openSync(this.directory, 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  }
  begin(job) {
    this.assertNew(job);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const now = new Date().toISOString();
    const record = { version: 1, jobId: contactJobId(job), state: 'intent', createdAt: now, updatedAt: now };
    // wx 额外防止调用方错误地绕开命令锁时覆盖已有意图。
    this.persist(this.filename(job), record);
    this.syncDirectory();
    return record;
  }
  finish(job, state) {
    if (!['unknown', 'confirmed'].includes(state)) throw new Error('非法沟通记录状态');
    const record = this.read(job);
    if (!record || record.state !== 'intent') throw new Error('沟通记录不处于本次待确认状态，已停止覆盖');
    const temporary = this.filename(job) + '.' + randomUUID() + '.tmp';
    try {
      this.persist(temporary, { ...record, state, updatedAt: new Date().toISOString() });
      fs.renameSync(temporary, this.filename(job));
      this.syncDirectory();
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
}

function contactActionUrl(actionUrl, pageUrl) {
  const action = new URL(actionUrl || '', pageUrl);
  if (!actionUrl || action.origin !== new URL(pageUrl).origin ||
      action.pathname !== '/wapi/zpgeek/friend/add.json' ||
      action.searchParams.getAll('jobId').length !== 1 || !action.searchParams.get('jobId')) {
    throw new Error('沟通按钮的接口或目标岗位契约已变化，未执行点击');
  }
  return action;
}

function matchesContactRequest(action, requestUrl, method, postData) {
  try {
    const actual = new URL(requestUrl);
    if (actual.origin !== action.origin || actual.pathname !== action.pathname || !['GET', 'POST'].includes(method)) return false;
    const parameters = new URLSearchParams(actual.search);
    if (method === 'POST' && postData) {
      for (const [key, value] of new URLSearchParams(postData)) parameters.append(key, value);
    }
    // 按按钮当时声明的目标参数逐一匹配；新增签名参数不存盘、不输出。
    for (const key of new Set(action.searchParams.keys())) {
      const expected = action.searchParams.getAll(key);
      const received = parameters.getAll(key);
      if (expected.length !== received.length || expected.some((value, index) => value !== received[index])) return false;
    }
    return true;
  } catch (_) { return false; }
}

// 当前已验收的文本入口是岗位详情内的首次沟通弹窗；独立消息页需另行适配。
async function sendInOpenChat({ page, job, company, message }) {
  const url = normalizeJobUrl(job);
  if (typeof message !== 'string' || !message.trim() || message !== message.trim()) throw new Error('消息必须为非空文本，且不能包含会被网页自动删除的首尾空白');
  if (contactJobId(page.url()) !== contactJobId(url)) throw new Error('当前页面不是目标岗位，未发送');
  const dialog = page.locator('.startchat-dialog');
  if (!(await dialog.count()) || !(await dialog.isVisible())) throw new Error('当前未打开目标岗位的沟通弹窗，未发送；独立消息页尚未适配');
  const recipient = await page.locator('.startchat-dialog .position').innerText();
  if (!company || !recipient.startsWith(company + '·')) throw new Error('沟通弹窗与目标公司不一致，未发送');
  const ledger = new ContactLedger(path.join(ROOT_DIR, 'message-intents'));
  ledger.assertNew(url);
  const readMessages = () => page.evaluate(() => [...document.querySelectorAll('.startchat-dialog .message-item')].map(e => ({
    id: e.id, text: e.querySelector('.text')?.textContent || '',
    state: e.querySelector('.status')?.className || '',
  })));
  const before = await readMessages();
  if (before.length) throw new Error('首次消息弹窗已有消息，需先核对历史以避免重复发送');
  await page.locator('.startchat-dialog textarea.input-area').fill(message);
  const input = await page.locator('.startchat-dialog textarea.input-area').evaluate(e => e.value);
  if (input !== message || /\bdisable\b/.test(await page.locator('.startchat-dialog .send-message').getAttribute('class'))) throw new Error('输入内容或发送按钮状态未通过校验，未发送');
  await page.context().accessGuard.beforeWrite(url, { signal: page.signal });
  if ((await readMessages()).length || await page.locator('.startchat-dialog textarea.input-area').evaluate(e => e.value) !== message ||
      !(await page.locator('.startchat-dialog .position').innerText()).startsWith(company + '·')) throw new Error('等待期间会话或输入内容发生变化，未发送');
  ledger.begin(url);
  try {
    await humanClick(page.locator('.startchat-dialog .send-message'));
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const messages = await readMessages();
      if (messages.length > 1 || (messages.length && messages[0].text !== message)) throw new Error('消息列表与预期不一致');
      const result = messages[0];
      if (result && /\berror\b/.test(result.state)) throw new Error('网站显示消息发送失败');
      if (result?.id && /\bsuccess\b/.test(result.state)) {
        ledger.finish(url, 'confirmed');
        const receipt = { status: 'sent', confirmation: 'site_callback', url, message, messageId: result.id };
        logger.ok('网页发送回调已确认消息：' + result.id);
        return receipt;
      }
      await page.waitForTimeout(200);
    }
    throw new Error('未等到网站的消息发送确认');
  } catch (error) {
    try { ledger.finish(url, 'unknown'); }
    catch (recordError) { logger.error('保留消息意图记录，禁止自动重试：' + recordError.message); }
    throw new Error('消息结果未确认，已阻止重复发送，请在 BOSS 核对：' + error.message);
  }
}

async function greet({ job, message, headless = false, dryRun = false, context: suppliedContext }) {
  const url = normalizeJobUrl(job);
  if (!dryRun) warnIfUncalibrated();
  if (message && !dryRun && !suppliedContext) {
    throw new Error('自定义消息目前只支持已建立联系的当前弹窗。独立 CLI 会话尚未完成验收，已在发起沟通前停止；可用 --dry-run 预览。');
  }
  const context = suppliedContext || await openContext({ headless });
  try {
    context.accessGuard.assertAllowed();
    const ledger = new ContactLedger();
    if (!dryRun && !message) ledger.assertNew(url);
    if (!dryRun && message && ledger.read(url)?.state !== 'confirmed') throw new Error('尚未确认该岗位已建立联系，未发送自定义消息');
    if (!(await hasLoginCookie(context))) throw new Error('未登录，无法打招呼。请先运行：boss login');
    const page = await getPage(context);
    logger.info((dryRun ? '检查沟通条件：' : '准备发起沟通：') + new URL(url).origin + new URL(url).pathname);
    if (page.url() !== url) await page.goto(url, { waitUntil: 'domcontentloaded' });
    try { await page.waitForSelector(SELECTORS.detailDesc.join(', '), { timeout: 20000 }); }
    catch (error) { await assertNoRiskControl(page); throw error; }
    await assertNoRiskControl(page);
    if (!(await isLoggedInOnPage(page))) throw new Error('页面未确认登录态，无法发起沟通');
    const info = await readDetail(page);
    if (message && !dryRun) {
      const receipt = await sendInOpenChat({ page, job: url, company: info.company, message });
      console.log(JSON.stringify(receipt, null, 2));
      return receipt;
    }
    const startBtn = await firstVisible(page, SELECTORS.startChat);
    if (!startBtn) throw new Error('未找到沟通按钮：岗位可能已停招或页面结构已变化');
    const action = (await startBtn.textContent()).trim();
    const alreadyContacted = (await startBtn.getAttribute('data-isfriend')) === 'true';
    if (dryRun) {
      const preview = {
        mode: 'dry_run', sent: false, url, ...info, action, alreadyContacted,
        ...(message ? { proposedMessage: message } : {}),
      };
      console.log(JSON.stringify(preview, null, 2));
      logger.ok('发送前检查完成：岗位和沟通按钮可读取，本次未发起沟通或发送消息');
      return preview;
    }
    if (alreadyContacted) {
      console.log(JSON.stringify({ status: 'already_contacted', url, sent: false }));
      logger.info('该岗位已经建立联系，本次未重复发起沟通');
      return true;
    }

    // 按真实详情页按钮声明的接口等待确认；只执行一次 UI 点击，不自行重放写请求。
    const actionUrl = contactActionUrl(await startBtn.getAttribute('data-url'), url);
    await context.accessGuard.beforeWrite(url, { signal: page.signal });
    ledger.begin(url);
    try {
      context.accessGuard.assertAllowed();
      const acknowledgement = page.waitForResponse((response) => {
        const request = response.request();
        return matchesContactRequest(actionUrl, request.url(), request.method(), request.postData());
      }, { timeout: 20000 });
      acknowledgement.catch(() => {});
      await humanClick(startBtn);
      const response = await acknowledgement;
      const status = response.status();
      if (!Number.isInteger(status) || status < 200 || status >= 300) throw new Error('沟通接口 HTTP 状态异常：' + status);
      const result = await response.json();
      if (result?.code !== 0) throw new Error('沟通接口未明确确认成功');
      ledger.finish(url, 'confirmed');
    } catch (error) {
      try { ledger.finish(url, 'unknown'); }
      catch (recordError) { logger.error('未能更新沟通结果，保留原有记录并禁止重试：' + recordError.message); }
      throw new Error('本次沟通结果未确认，已保留记录并禁止重复点击。请在 BOSS 人工核对：' + error.message);
    }
    console.log(JSON.stringify({ status: 'contact_established', url, messageDelivery: 'unverified' }));
    logger.ok('服务端已确认建立联系；默认招呼消息是否送达尚未单独验证');
    return true;
  } finally { if (!suppliedContext) await context.close(); }
}

module.exports = { greet, sendInOpenChat, ContactLedger, contactJobId, contactActionUrl, matchesContactRequest };
