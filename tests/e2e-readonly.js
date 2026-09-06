'use strict';

// 显式运行才访问 BOSS；整条业务链路共用一个浏览器和页面，发送只做预览。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openContext } = require('../src/browser');
const { whoami } = require('../src/auth');
const { search, detail } = require('../src/jobs');
const { greet } = require('../src/chat');

const output = path.join(__dirname, '..', 'log', 'e2e-shared');
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const summary = { startedAt: new Date().toISOString(), status: 'running', steps: [], sent: false };
function save() {
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
}

async function run(name, action) {
  const step = { name, status: 'running' };
  summary.steps.push(step);
  save();
  try {
    const result = await action();
    fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
    step.status = 'passed';
    return result;
  } catch (error) { step.status = 'failed'; throw error; }
  finally { save(); }
}

async function main() {
  save();
  let context;
  try {
    context = await openContext();
    await run('whoami', async () => {
      if (!(await whoami({ context }))) throw new Error('未找到有效登录态，请先运行 boss login；本次停止在登录核验，未执行后续搜索或发送。');
      return { loggedIn: true };
    });
    const jobs = await run('search', async () => {
      const result = await search({ query: process.argv[2] || '后端工程师', city: process.argv[3] || '北京', limit: 3, context, fresh: true });
      assert.ok(result.length > 0 && result.length <= 3, '需要至少一个真实岗位验证后续链路');
      return result;
    });
    const job = jobs[0];
    await run('detail', async () => {
      const result = await detail({ job: job.url, context, fresh: true });
      for (const key of ['url', 'name', 'company', 'salary']) assert.equal(result[key], job[key], key + ' 在列表与详情中不一致');
      assert.ok(result.desc.trim().length > 0);
      assert.ok(!/[\uE000-\uF8FF]/.test(result.salary));
      return result;
    });
    await run('greet-check', async () => {
      const result = await greet({ job: job.url, context, dryRun: true });
      assert.equal(result.mode, 'dry_run');
      assert.equal(result.sent, false);
      assert.equal(result.url, job.url);
      assert.equal(result.name, job.name);
      return result;
    });
    summary.job = { name: job.name, company: job.company, salary: job.salary, url: job.url };
    summary.status = 'passed';
  } catch (error) {
    summary.status = 'failed';
    summary.error = error.message;
    process.exitCode = 1;
  } finally {
    try { if (context) await context.close(); }
    catch (error) { summary.status = 'failed'; summary.error = error.message; process.exitCode = 1; }
    summary.finishedAt = new Date().toISOString();
    save();
    console.log(JSON.stringify(summary, null, 2));
  }
}

void main();
