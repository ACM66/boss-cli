'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { greet, ContactLedger, contactJobId, contactActionUrl, matchesContactRequest } = require('../src/chat');

const jobId = 'cf67d42f51ec44060nF93N2_FVJW';
const jobUrl = 'https://www.zhipin.com/job_detail/' + jobId + '.html';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-contact-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new ContactLedger(path.join(directory, 'contacts'));
}

test('未经回执验收的自定义消息在打开浏览器和联系 HR 前被拒绝', async () => {
  await assert.rejects(greet({ job: 'cf67d42f51ec44060nF93N2_FVJW', message: '发送回执边界验证' }),
    /已在发起沟通前停止/);
});

test('同一岗位不同跟踪参数、片段和裸 ID 使用相同防重复键', () => {
  assert.equal(contactJobId(jobId), jobId);
  assert.equal(contactJobId(jobUrl + '?securityId=local-test-only&from=search#detail'), jobId);
  assert.throws(() => contactJobId('../other-file'), /非法岗位/);
});

test('只读检查不创建状态目录；点击意图只保存公开岗位 ID、状态和时间', (t) => {
  const ledger = fixture(t);
  assert.equal(ledger.read(jobId), null);
  ledger.assertNew(jobId);
  assert.equal(fs.existsSync(ledger.directory), false);
  ledger.begin(jobUrl + '?securityId=not-for-persistence#tracking');
  const record = ledger.read(jobId);
  assert.equal(record.state, 'intent');
  assert.equal(record.jobId, jobId);
  assert.deepEqual(Object.keys(record).sort(), ['createdAt', 'jobId', 'state', 'updatedAt', 'version']);
  assert.equal(fs.statSync(ledger.filename(jobId)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(ledger.directory).mode & 0o777, 0o700);
  assert.doesNotMatch(fs.readFileSync(ledger.filename(jobId), 'utf8'), /securityId|not-for-persistence|tracking/);
});

test('确认和结果未知都会阻止再次联系，并保留原始意图时间', (t) => {
  const ledger = fixture(t);
  for (const state of ['unknown', 'confirmed']) {
    const id = jobId + '-' + state;
    const initial = ledger.begin(id);
    ledger.finish(id, state);
    const reopened = new ContactLedger(ledger.directory);
    assert.equal(reopened.read(id).state, state);
    assert.equal(reopened.read(id).createdAt, initial.createdAt);
    assert.throws(() => reopened.begin(id), /不会重复点击/);
    assert.throws(() => reopened.finish(id, 'unknown'), /不处于本次待确认状态/);
    assert.equal(reopened.read(id).state, state);
  }
});

test('意图落盘后进程被终止，新进程仍拒绝同岗位的不同 URL', (t) => {
  const ledger = fixture(t);
  const modulePath = path.resolve(__dirname, '../src/chat.js');
  const first = spawnSync(process.execPath, ['-e', `
    const { ContactLedger } = require(${JSON.stringify(modulePath)});
    new ContactLedger(process.argv[1]).begin(process.argv[2]);
    process.kill(process.pid, 'SIGKILL');
  `, ledger.directory, jobId], { encoding: 'utf8' });
  assert.equal(first.signal, 'SIGKILL', first.stderr);
  const second = spawnSync(process.execPath, ['-e', `
    const { ContactLedger } = require(${JSON.stringify(modulePath)});
    try { new ContactLedger(process.argv[1]).begin(process.argv[2]); process.exit(1); }
    catch (error) { if (!error.message.includes('不会重复点击')) throw error; }
  `, ledger.directory, jobUrl + '?from=another-process'], { encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(ledger.read(jobId).state, 'intent');
});

test('损坏、截断和岗位 ID 不匹配的记录均阻止操作，不覆盖旧文件', (t) => {
  const ledger = fixture(t);
  fs.mkdirSync(ledger.directory);
  const invalidRecords = [
    '', '{"version":1,', 'null',
    JSON.stringify({ version: 1, jobId: 'another-job', state: 'intent', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
    JSON.stringify({ version: 1, jobId, state: 'retryable', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
  ];
  for (const text of invalidRecords) {
    fs.writeFileSync(ledger.filename(jobId), text, { mode: 0o600 });
    assert.throws(() => ledger.begin(jobId), /沟通记录无法可靠读取/);
    assert.equal(fs.readFileSync(ledger.filename(jobId), 'utf8'), text);
  }
});

test('本地目标参数匹配拒绝其他岗位、其他来源和歧义参数', () => {
  // 这里只验证参数匹配规则，不构造或宣称真实 BOSS 成功响应。
  const action = contactActionUrl('/wapi/zpgeek/friend/add.json?jobId=local-job&securityId=local-token', jobUrl);
  assert.equal(matchesContactRequest(action, action.href, 'GET'), true);
  assert.equal(matchesContactRequest(action, action.origin + action.pathname, 'POST', 'jobId=local-job&securityId=local-token'), true);
  assert.equal(matchesContactRequest(action, action.href.replace('local-job', 'other-job'), 'GET'), false);
  assert.equal(matchesContactRequest(action, action.href.replace('local-token', 'different-token'), 'GET'), false);
  assert.equal(matchesContactRequest(action, action.href.replace('www.zhipin.com', 'example.com'), 'GET'), false);
  assert.equal(matchesContactRequest(action, action.href + '&jobId=local-job', 'GET'), false);
  assert.equal(matchesContactRequest(action, action.href, 'DELETE'), false);
  assert.equal(matchesContactRequest(action, undefined, 'GET'), false);
});

test('按钮没有唯一目标岗位或指向外部站点时不能建立回执监听', () => {
  assert.throws(() => contactActionUrl('/wapi/zpgeek/friend/add.json', jobUrl), /目标岗位契约已变化/);
  assert.throws(() => contactActionUrl('/wapi/zpgeek/friend/add.json?jobId=a&jobId=b', jobUrl), /目标岗位契约已变化/);
  assert.throws(() => contactActionUrl('https://example.com/wapi/zpgeek/friend/add.json?jobId=a', jobUrl), /目标岗位契约已变化/);
});
