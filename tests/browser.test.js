'use strict';

// 生命周期的失败路径只使用临时目录和真实 PID 检查，不连接或启动浏览器。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { AccessGuard, RiskControlError } = require('../src/anticrawl');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-browser-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requireSource = createRequire(path.join(__dirname, '../src/browser.js'));
  const localProcess = {
    pid: process.pid, platform: process.platform,
    env: { ...process.env, BOSS_CHROME_PATH: path.join(root, 'no-chrome') },
    kill: process.kill.bind(process), once: process.once.bind(process),
    removeListener: process.removeListener.bind(process), exit: () => assert.fail('测试期间不应退出进程'),
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/browser.js'), 'utf8'), {
    module, process: localProcess, URL, AbortSignal,
    fetch: () => assert.fail('失败路径不应连接浏览器'),
    require(id) {
      if (id === './config') return { ROOT_DIR: root, USER_DATA_DIR: path.join(root, 'userdata') };
      if (id === 'child_process') return { ...requireSource(id), spawn: () => assert.fail('失败路径不应启动浏览器') };
      return requireSource(id);
    },
  }, { filename: 'browser.js' });
  return { ...module.exports, root, lock: path.join(root, 'browser.lock.json'), state: path.join(root, 'browser.json') };
}

test('Chrome 路径无效时释放本命令锁和信号监听器', async (t) => {
  const f = fixture(t);
  const signals = ['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal));
  await assert.rejects(f.openContext(), /未找到 Google Chrome/);
  assert.equal(fs.existsSync(f.lock), false);
  assert.deepEqual(['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal)), signals);
});

test('存活命令持有的锁被保留，第二个命令明确失败', async (t) => {
  const f = fixture(t);
  const lock = JSON.stringify({ pid: process.pid, token: 'another-command' });
  fs.writeFileSync(f.lock, lock);
  await assert.rejects(f.openContext(), /另一个 boss 命令/);
  assert.equal(fs.readFileSync(f.lock, 'utf8'), lock);
});

test('死进程遗留锁可以回收，随后启动失败也不会留下新锁', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.lock, JSON.stringify({ pid: 2147483647, token: 'dead-command' }));
  await assert.rejects(f.openContext(), /未找到 Google Chrome/);
  assert.equal(fs.existsSync(f.lock), false);
});

test('状态中的存活 PID 并非专用 Chrome 时拒绝连接，保留原记录', async (t) => {
  const f = fixture(t);
  const state = JSON.stringify({ version: 1, pid: process.pid, port: 60059, userDataDir: path.join(f.root, 'userdata') });
  fs.writeFileSync(f.state, state);
  await assert.rejects(f.openContext(), /与 boss 专用浏览器配置不匹配/);
  assert.equal(fs.readFileSync(f.state, 'utf8'), state);
  assert.equal(fs.existsSync(f.lock), false);
});

test('未登记的 Chrome profile 锁不被删除或强行接管', async (t) => {
  const f = fixture(t);
  const profile = path.join(f.root, 'userdata');
  fs.mkdirSync(profile);
  const singleton = path.join(profile, 'SingletonLock');
  fs.writeFileSync(singleton, 'owned-by-browser');
  await assert.rejects(f.openContext(), /profile 已被占用/);
  assert.equal(fs.readFileSync(singleton, 'utf8'), 'owned-by-browser');
  assert.equal(fs.existsSync(f.lock), false);
});

test('共享冷却记录在加锁、启动 Chrome 或连接端口前拒绝访问', async (t) => {
  const f = fixture(t);
  const guard = new AccessGuard({ rootDir: f.root });
  guard.recordRisk(new RiskControlError('本地浏览器门禁测试', 'wall'), 'https://www.zhipin.com/');
  await assert.rejects(f.openContext(), /本地浏览器门禁测试/);
  assert.equal(fs.existsSync(f.lock), false);
  assert.equal(fs.existsSync(f.state), false);
});

test('访问状态损坏也在启动浏览器前明确停止', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'access-state.json'), '{broken');
  await assert.rejects(f.openContext(), /无法读取访问记录/);
  assert.equal(fs.existsSync(f.lock), false);
  assert.equal(fs.existsSync(f.state), false);
});

test('offline 本地清理可越过冷却，但仍保留冷却与浏览器归属检查', async (t) => {
  const f = fixture(t);
  const guard = new AccessGuard({ rootDir: f.root });
  guard.recordRisk(new RiskControlError('离线清理门禁测试', 'wall'), 'https://www.zhipin.com/');
  const saved = fs.readFileSync(guard.stateFile, 'utf8');
  await assert.rejects(f.openContext({ offline: true }), /未找到 Google Chrome/);
  assert.equal(fs.readFileSync(guard.stateFile, 'utf8'), saved);
  assert.equal(fs.existsSync(f.lock), false);
});
