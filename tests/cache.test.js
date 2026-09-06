'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ReadCache, parseJobList } = require('../src/jobs');
const recorded = require('./fixtures/search-recorded.json');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-cache-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new ReadCache(path.join(directory, 'read-cache.json'));
}

test('真实岗位记录缓存跨实例读取，关键词/城市/操作分别区分', (t) => {
  const cache = fixture(t);
  const jobs = parseJobList(recorded.payload || recorded);
  const key = ['后端工程师', '101010100'];
  cache.set('search', key, jobs);
  const next = new ReadCache(cache.file);
  assert.deepEqual(next.get('search', key, 60000), jobs);
  assert.equal(next.get('search', ['后端工程师', '101020100'], 60000), null);
  assert.equal(next.get('detail', key, 60000), null);
  assert.equal(next.get('search', key, 0), null);
  if (process.platform !== 'win32') assert.equal(fs.statSync(cache.file).mode & 0o777, 0o600);
});

test('缓存真实过期后不再复用，明确空结果可以缓存', async (t) => {
  const cache = fixture(t);
  cache.set('search', ['空结果解析记录'], []);
  assert.deepEqual(cache.get('search', ['空结果解析记录'], 60000), []);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(cache.get('search', ['空结果解析记录'], 20), null);
});

test('损坏缓存明确失败，不覆盖损坏数据', (t) => {
  const cache = fixture(t);
  for (const contents of ['{broken', 'null', '{"version":1,"entries":[]}', '{"version":1,"entries":{"bad":{}}}']) {
    fs.writeFileSync(cache.file, contents);
    assert.throws(() => cache.get('search', [], 60000), /缓存/);
    assert.throws(() => cache.set('search', [], []), /缓存/);
    assert.equal(fs.readFileSync(cache.file, 'utf8'), contents);
  }
});
