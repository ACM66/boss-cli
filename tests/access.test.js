'use strict';

// 仅使用真实临时文件、计时器与独立进程；不访问 BOSS 或启动浏览器。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {
  AccessGuard, RiskControlError, classifyRisk, parseRecoveryTime, isBossUrl,
} = require('../src/anticrawl');

const runFile = promisify(execFile);
const jobUrl = 'https://www.zhipin.com/job_detail/example.html';

function fixture(t, policy = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-access-test-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const options = { rootDir, policy: { navigationIntervalMs: 0, writeIntervalMs: 0, recoveryBufferMs: 0, ...policy } };
  return { options, guard: new AccessGuard(options) };
}

test('仅识别 BOSS 根域及子域，忽略假域与非 HTTP URL', () => {
  for (const url of ['https://zhipin.com/', 'https://www.zhipin.com/', 'https://m.zhipin.com/']) {
    assert.equal(isBossUrl(url), true, url);
    assert.equal(classifyRisk({ url, text: '访问受限' }).kind, 'wall');
  }
  for (const url of ['https://zhipin.com.evil.example/', 'https://fakezhipin.com/', 'https://zhipin.com@evil.example/', 'file://zhipin.com/test', 'about:blank', 'not a url']) {
    assert.equal(isBossUrl(url), false, url);
    assert.equal(classifyRisk({ url, text: '访问受限', status: 429 }), null);
  }
});

test('真实风险文案按 UTC+8 提取恢复时间，非法日期不自动进位', () => {
  const now = Date.parse('2026-09-05T16:10:00Z'); // 北京已是 9 月 6 日。
  assert.equal(parseRecoveryTime('访问受限，将于2026-09-05 23:47恢复正常', now), Date.parse('2026-09-05T15:47:00Z'));
  assert.equal(parseRecoveryTime('将于 01:20 恢复正常', now), Date.parse('2026-09-05T17:20:00Z'));
  assert.equal(parseRecoveryTime('将于2024-02-29 00:00:01恢复正常', now), Date.parse('2024-02-28T16:00:01Z'));
  for (const value of ['2026-02-29 23:47', '2026-04-31 23:47', '2026-13-01 23:47', '2026-00-01 23:47', '2026-09-00 23:47', '2026-09-05 24:00', '2026-09-05 23:60', '2026-09-05 23:47:60']) {
    assert.equal(parseRecoveryTime(`将于${value}恢复正常`, now), 0, value);
  }
  assert.equal(parseRecoveryTime('访问受限，恢复时间未提供', now), 0);
});

test('访问墙、HTTP 403/429、Retry-After 和 security.html 均可识别', () => {
  const now = Date.parse('2026-09-05T12:00:00Z');
  const wall = classifyRisk({ url: jobUrl, text: '访问受限，将于2026-09-05 23:47恢复正常' }, now);
  assert.equal(wall.kind, 'wall');
  assert.equal(wall.retryAt, Date.parse('2026-09-05T15:47:00Z'));
  for (const status of [403, 429]) {
    assert.equal(classifyRisk({ url: jobUrl, status }).kind, 'http_limit');
    assert.equal(classifyRisk({ url: jobUrl, status, headers: { 'Retry-After': '120' } }, now).retryAt, now + 120000);
  }
  assert.equal(classifyRisk({ url: jobUrl, status: 429, headers: { 'retry-after': 'Sat, 05 Sep 2026 15:47:00 GMT' } }, now).retryAt, Date.parse('2026-09-05T15:47:00Z'));
  assert.equal(classifyRisk({ url: jobUrl, status: 429, headers: { 'retry-after': 'invalid' } }, now).retryAt, 0);
  assert.equal(classifyRisk({ url: 'https://www.zhipin.com/web/passport/zp/security.html' }).kind, 'captcha');
  assert.equal(classifyRisk({ url: jobUrl, status: 200, text: '职位详情' }), null);
});

test('登录接口名包含 captcha 不等于验证码页面，真实错误状态和正文仍拦截', (t) => {
  const { guard } = fixture(t);
  const url = 'https://www.zhipin.com/wapi/zppassport/captcha/randkey';
  assert.equal(classifyRisk({ url, status: 200 }), null);
  assert.equal(guard.inspectResponse({ url, status: 200 }), null);
  assert.equal(guard.status().paused, false);
  assert.equal(guard.readState().apiResponses.length, 1);
  for (const status of [403, 429]) assert.equal(classifyRisk({ url, status }).kind, 'http_limit');
  assert.equal(classifyRisk({ url, text: '请完成以下验证' }).kind, 'captcha');
  assert.equal(classifyRisk({ url: 'https://www.zhipin.com/web/passport/zp/security.html' }).kind, 'captcha');
});

test('独立 Node 进程写入冷却，另一进程拒绝导航且不增加预算', async (t) => {
  const { options, guard } = fixture(t);
  const sourceFile = require.resolve('../src/anticrawl');
  const first = `
    const { AccessGuard, RiskControlError } = require(process.argv[1]);
    const guard = new AccessGuard(JSON.parse(process.argv[2]));
    guard.recordRisk(new RiskControlError('跨进程本地测试', 'wall'), 'https://www.zhipin.com/');
  `;
  const second = `
    const { AccessGuard } = require(process.argv[1]);
    const guard = new AccessGuard(JSON.parse(process.argv[2]));
    guard.beforeNavigation('https://www.zhipin.com/').then(() => {
      process.exitCode = 1;
    }, error => {
      console.log(JSON.stringify({ kind: error.kind, retryAt: error.retryAt }));
    });
  `;
  await runFile(process.execPath, ['-e', first, sourceFile, JSON.stringify(options)]);
  const saved = fs.readFileSync(guard.stateFile, 'utf8');
  const result = await runFile(process.execPath, ['-e', second, sourceFile, JSON.stringify(options)]);
  const rejected = JSON.parse(result.stdout);
  assert.equal(rejected.kind, 'wall');
  assert.equal(rejected.retryAt, guard.readState().cooldown.until);
  assert.equal(fs.readFileSync(guard.stateFile, 'utf8'), saved);
  assert.equal(guard.status().usage.navigationsLast24Hours, 0);
});

test('导航预算跨实例保留，超限拒绝不会记录额外动作', async (t) => {
  const { options, guard } = fixture(t, { maxNavigationsPerHour: 1 });
  await guard.beforeNavigation(jobUrl);
  const saved = fs.readFileSync(guard.stateFile, 'utf8');
  await assert.rejects(new AccessGuard(options).beforeNavigation(jobUrl), (error) => error.kind === 'budget');
  assert.equal(fs.readFileSync(guard.stateFile, 'utf8'), saved);
  assert.equal(new AccessGuard(options).status().usage.navigationsLastHour, 1);
});

test('日导航与写入预算独立计数，拒绝不占用任何新额度', async (t) => {
  const { options, guard } = fixture(t, { maxNavigationsPerDay: 1, maxWritesPerDay: 1 });
  await guard.beforeNavigation(jobUrl);
  await guard.beforeWrite(jobUrl);
  const saved = fs.readFileSync(guard.stateFile, 'utf8');
  for (const method of ['beforeNavigation', 'beforeWrite']) {
    await assert.rejects(new AccessGuard(options)[method](jobUrl), (error) => error.kind === 'budget');
    assert.equal(fs.readFileSync(guard.stateFile, 'utf8'), saved);
  }
  assert.deepEqual(guard.status().usage, { navigationsLastHour: 1, navigationsLast24Hours: 1, writesLast24Hours: 1 });
});

test('导航和写入共用最近动作时间，并实际遵守各自间隔', async (t) => {
  const { options, guard } = fixture(t, { navigationIntervalMs: 40, writeIntervalMs: 60 });
  await guard.beforeNavigation(jobUrl);
  const first = guard.readState().lastNavigation;
  await new AccessGuard(options).beforeWrite(jobUrl);
  const second = guard.readState().lastWrite;
  await new AccessGuard(options).beforeNavigation(jobUrl);
  const third = guard.readState().lastNavigation;
  assert.ok(second - first >= 60, `导航到写入实际间隔 ${second - first}ms`);
  assert.ok(third - second >= 40, `写入到导航实际间隔 ${third - second}ms`);
});

test('等待中另一实例记录风险会中断动作，且不新增 quota', async (t) => {
  const { options, guard } = fixture(t, { navigationIntervalMs: 120 });
  await guard.beforeNavigation(jobUrl);
  const before = guard.readState();
  const rejection = assert.rejects(guard.beforeNavigation(jobUrl), (error) => error.kind === 'wall');
  const timer = setTimeout(() => {
    new AccessGuard(options).recordRisk(new RiskControlError('等待中风险测试', 'wall'), jobUrl);
  }, 20);
  t.after(() => clearTimeout(timer));
  await rejection;
  const after = guard.readState();
  assert.deepEqual(after.navigations, before.navigations);
  assert.equal(after.lastNavigation, before.lastNavigation);
  assert.equal(after.writes.length, 0);
  assert.ok(after.cooldown.until > Date.now());
});

test('损坏访问记录及未来动作时间明确拒绝，保留原文件', async (t) => {
  const { guard } = fixture(t);
  const valid = guard.readState();
  const invalid = ['{broken', 'null', '{}', JSON.stringify({ ...valid, version: 2 }), JSON.stringify({ ...valid, navigations: [NaN] }), JSON.stringify({ ...valid, lastWrite: -1 }), JSON.stringify({ ...valid, cooldown: { until: 1, kind: 'wall' } }), JSON.stringify({ ...valid, lastNavigation: Date.now() + 60000 })];
  for (const contents of invalid) {
    fs.writeFileSync(guard.stateFile, contents);
    await assert.rejects(guard.beforeNavigation(jobUrl), /已停止操作/);
    assert.equal(fs.readFileSync(guard.stateFile, 'utf8'), contents);
  }
});

test('损坏、未知字段及无效策略 fail closed，保留用户策略', async (t) => {
  const { options, guard } = fixture(t);
  for (const contents of ['{broken', 'null', '[]', '{"unknown":1}', '{"navigationIntervalMs":-1}', '{"writeIntervalMs":1.5}', '{"maxWritesPerDay":0}', '{"cooldownMs":0}', '{"maxNavigationsPerHour":"10"}']) {
    fs.writeFileSync(guard.policyFile, contents);
    assert.throws(() => new AccessGuard(options), /访问策略/);
    assert.equal(fs.readFileSync(guard.policyFile, 'utf8'), contents);
    assert.equal(fs.existsSync(guard.stateFile), false);
  }
  fs.unlinkSync(guard.policyFile);
  assert.throws(() => new AccessGuard({ ...options, policy: { unknown: 1 } }), /无效访问策略/);
});

test('冷却保留公开路径，不落盘 URL 查询参数、fragment 或凭证', (t) => {
  const { guard } = fixture(t);
  guard.recordRisk(new RiskControlError('仅本地冷却记录测试', 'wall'), 'https://someone:secret@www.zhipin.com/job_detail/example.html?securityId=private-token&query=private-query#private-fragment');
  const contents = fs.readFileSync(guard.stateFile, 'utf8');
  assert.equal(guard.readState().cooldown.url, jobUrl);
  for (const secret of ['someone', 'secret', 'private-token', 'securityId', 'private-query', 'private-fragment']) assert.equal(contents.includes(secret), false, secret);
});

test('后续风险不能缩短已有冷却，较晚恢复时间会延长冷却并加缓冲', (t) => {
  const { guard } = fixture(t, { cooldownMs: 100, recoveryBufferMs: 50 });
  const longRetry = Date.now() + 60000;
  guard.recordRisk(new RiskControlError('较晚恢复时间测试', 'wall', longRetry), jobUrl);
  assert.equal(guard.readState().cooldown.until, longRetry + 50);
  guard.recordRisk(new RiskControlError('较早恢复时间测试', 'captcha', Date.now() + 1000), jobUrl);
  assert.equal(guard.readState().cooldown.until, longRetry + 50);
  guard.recordRisk(new RiskControlError('再延长恢复时间测试', 'http_limit', longRetry + 60000), jobUrl);
  assert.equal(guard.readState().cooldown.until, longRetry + 60050);
});

test('导航循环超过事件预算即持久暂停，后续观察停止记数', (t) => {
  const { options, guard } = fixture(t, { maxNavigationEventsPerMinute: 2 });
  assert.equal(guard.inspectNavigation(jobUrl), null);
  assert.equal(guard.inspectNavigation(jobUrl), null);
  const error = guard.inspectNavigation(jobUrl);
  assert.equal(error.kind, 'navigation_loop');
  assert.equal(guard.readState().navEvents.length, 3);
  const saved = fs.readFileSync(guard.stateFile, 'utf8');
  assert.throws(() => new AccessGuard(options).inspectNavigation(jobUrl), (failure) => failure.kind === 'navigation_loop');
  assert.equal(fs.readFileSync(guard.stateFile, 'utf8'), saved);
});

test('业务 API 响应风暴会暂停，静态资源和外站不计入业务预算', (t) => {
  const { guard } = fixture(t, { maxApiResponsesPerMinute: 2 });
  for (const url of ['https://www.zhipin.com/static/app.js', 'https://zhipin.com.evil.example/wapi/user']) {
    assert.equal(guard.inspectResponse({ url, status: 200 }), null);
  }
  assert.equal(guard.readState().apiResponses.length, 0);
  const response = { url: 'https://www.zhipin.com/wapi/zpuser/wap/getUserInfo.json', status: 200 };
  assert.equal(guard.inspectResponse(response), null);
  assert.equal(guard.inspectResponse(response), null);
  assert.equal(guard.inspectResponse(response).kind, 'request_volume');
  const saved = fs.readFileSync(guard.stateFile, 'utf8');
  assert.throws(() => guard.inspectResponse(response), (error) => error.kind === 'request_volume');
  assert.equal(fs.readFileSync(guard.stateFile, 'utf8'), saved);
});

test('security.html 导航和 HTTP 限流响应都会持久暂停后续操作', async (t) => {
  const first = fixture(t);
  assert.equal(first.guard.inspectNavigation('https://www.zhipin.com/web/passport/zp/security.html').kind, 'captcha');
  await assert.rejects(new AccessGuard(first.options).beforeWrite(jobUrl), (error) => error.kind === 'captcha');
  const second = fixture(t);
  assert.equal(second.guard.inspectResponse({ url: jobUrl, status: 429, headers: { 'Retry-After': '3600' } }).kind, 'http_limit');
  assert.ok(second.guard.readState().cooldown.until >= Date.now() + 3599000);
  await assert.rejects(new AccessGuard(second.options).beforeNavigation(jobUrl), (error) => error.kind === 'http_limit');
});
