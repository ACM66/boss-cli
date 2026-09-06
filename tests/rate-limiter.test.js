'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { RateLimiter } = require('../src/anticrawl');

const runFile = promisify(execFile);

function temporaryState(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-rate-limiter-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'nested', 'action-time.json');
}

test('首次动作创建真实状态文件，无需等待完整动作间隔', async (t) => {
  const stateFile = temporaryState(t);
  const limiter = new RateLimiter(1000, 1000, stateFile);
  const before = Date.now();
  await limiter.wait();
  const after = Date.now();

  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(state.last >= before && state.last <= after);
  assert.equal(state.last, limiter.last);
  assert.ok(after - before < 900, `首次动作耗时 ${after - before}ms`);
});

test('不同实例从同一个文件读取最近动作，实际间隔至少 100ms', async (t) => {
  const stateFile = temporaryState(t);
  const first = new RateLimiter(100, 100, stateFile);
  const second = new RateLimiter(100, 100, stateFile);
  await first.wait();
  await second.wait();

  assert.ok(second.last - first.last >= 100);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).last, second.last);
});

test('磁盘时间落后时仍保留同实例最近动作时间', async (t) => {
  const stateFile = temporaryState(t);
  const limiter = new RateLimiter(100, 100, stateFile);
  await limiter.wait();
  const first = limiter.last;
  fs.writeFileSync(stateFile, JSON.stringify({ last: 1 }));
  await limiter.wait();

  assert.ok(limiter.last - first >= 100);
});

test('两个独立 Node 进程实施至少 100ms 间隔', async (t) => {
  const stateFile = temporaryState(t);
  const sourceFile = require.resolve('../src/anticrawl');
  const child = `
    const { RateLimiter } = require(process.argv[1]);
    const limiter = new RateLimiter(100, 100, process.argv[2]);
    limiter.wait().then(() => console.log(JSON.stringify({last: limiter.last}))).catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    });
  `;
  const options = { env: { ...process.env, BOSS_DEBUG: '' } };
  const first = await runFile(process.execPath, ['-e', child, sourceFile, stateFile], options);
  const second = await runFile(process.execPath, ['-e', child, sourceFile, stateFile], options);
  const gap = JSON.parse(second.stdout).last - JSON.parse(first.stdout).last;

  assert.ok(gap >= 100, `独立进程间隔只有 ${gap}ms`);
});

test('损坏或无效状态明确失败，保留原始文件', async (t) => {
  const stateFile = temporaryState(t);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  for (const contents of ['{broken', '{}', 'null', '{"last":-1}', '{"last":"123"}']) {
    fs.writeFileSync(stateFile, contents);
    await assert.rejects(new RateLimiter(100, 100, stateFile).wait(), /无法读取限频状态/);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), contents);
  }
});

test('非 ENOENT 文件读取错误明确失败', async (t) => {
  const stateFile = temporaryState(t);
  fs.mkdirSync(stateFile, { recursive: true });

  await assert.rejects(new RateLimiter(100, 100, stateFile).wait(), /无法读取限频状态/);
});
