'use strict';

// 离线回归：解析真实网页响应中已脱敏的公开岗位字段；不启动、连接或模拟浏览器。
// search/detail 仅使用必定在 openContext 之前被拒绝的非法输入，不作为真实 E2E 证据。
const test = require('node:test');
const assert = require('node:assert/strict');
const recorded = require('./fixtures/search-recorded.json');
const { parseJobList, resolveCity, normalizeJobUrl, search, detail } = require('../src/jobs');

const copyRecorded = () => structuredClone(recorded);

test('真实响应保留可读薪资、岗位 URL、公司、地区和标签', () => {
  const input = copyRecorded();
  assert.deepEqual(parseJobList(input), [
    {
      name: '后端工程师（实习）', salary: '800-1200元/天',
      company: '北京泽青科创技术...', area: '北京·海淀区·学院路',
      tags: ['4天/周', '3个月', '本科'],
      url: 'https://www.zhipin.com/job_detail/b90ee1064f5364600nN60tW5EVtU.html',
    },
    {
      name: '后端工程师（Java）CRM方向', salary: '18-25K·13薪',
      company: '润泽园教育', area: '北京', tags: ['5-10年', '学历不限'],
      url: 'https://www.zhipin.com/job_detail/cf67d42f51ec44060nF93N2_FVJW.html',
    },
  ]);
  assert.deepEqual(input, recorded, '解析不能改写捕获的原始响应');
  assert.ok(parseJobList(input).every((job) => !/[\uE000-\uF8FF]/.test(job.salary)));
});

test('非成功响应或响应缺失必须报错', () => {
  for (const payload of [undefined, null, {}, { code: 1, message: '拒绝请求' }, { code: '0', zpData: { jobList: [] } }]) {
    assert.throws(() => parseJobList(payload), /岗位接口未成功/);
  }
});

test('缺失或无效 jobList 必须报错，明确空列表返回 []', () => {
  for (const payload of [{ code: 0 }, { code: 0, zpData: {} }, { code: 0, zpData: { jobList: null } }, { code: 0, zpData: { jobList: {} } }]) {
    assert.throws(() => parseJobList(payload), /缺少 jobList/);
  }
  assert.deepEqual(parseJobList({ code: 0, zpData: { jobList: [] } }), []);
});

test('任一岗位缺少必填字段时拒绝输出部分成功结果', () => {
  for (const field of ['jobName', 'salaryDesc', 'brandName', 'encryptJobId']) {
    for (const missingValue of [undefined, '', null]) {
      const payload = copyRecorded();
      payload.zpData.jobList[1][field] = missingValue;
      assert.throws(() => parseJobList(payload), /岗位数据不完整/, `${field}=${missingValue}`);
    }
  }
  const malformedId = copyRecorded();
  malformedId.zpData.jobList[0].encryptJobId = '../unexpected';
  assert.throws(() => parseJobList(malformedId), /非法岗位 id/);
});

test('城市名和 9 位城市编码正常解析，未知城市不默默回退', () => {
  assert.equal(resolveCity(), '100010000');
  assert.equal(resolveCity('北京'), '101010100');
  assert.equal(resolveCity('上海'), '101020100');
  assert.equal(resolveCity('101010100'), '101010100');
  for (const city of ['不支持的城市', '10101010', '1010101000', '10101A100']) {
    assert.throws(() => resolveCity(city), /未知城市/);
  }
});

test('岗位 ID 和真实岗位链接规范化，拒绝外域或非详情链接', () => {
  const id = recorded.zpData.jobList[0].encryptJobId;
  const expected = `https://www.zhipin.com/job_detail/${id}.html`;
  assert.equal(normalizeJobUrl(id), expected);
  assert.equal(normalizeJobUrl(id + '.html'), expected);
  assert.equal(normalizeJobUrl(expected), expected);
  assert.equal(normalizeJobUrl(expected + '?ka=search_list'), expected + '?ka=search_list');
  for (const value of [
    undefined, '', '../unexpected', 'file:///tmp/job', 'https://',
    'https://example.com/job_detail/abc.html',
    'https://www.zhipin.com.example.com/job_detail/abc.html',
    'https://www.zhipin.com@example.com/job_detail/abc.html',
    'https://www.zhipin.com/web/geek/jobs',
    'https://www.zhipin.com/job_detail/',
  ]) {
    assert.throws(() => normalizeJobUrl(value));
  }
});

test('搜索非法关键词、条数、城市在导航前被拒绝', async () => {
  for (const query of [undefined, '', '  \n\t']) {
    await assert.rejects(search({ query, city: '北京', limit: 2 }), /请提供搜索关键词/);
  }
  for (const limit of [0, -1, 101, 1.5, NaN, Infinity, '2', null]) {
    await assert.rejects(search({ query: '后端工程师', city: '北京', limit }), /返回条数必须是/);
  }
  await assert.rejects(search({ query: '后端工程师', city: '不支持的城市', limit: 2 }), /未知城市/);
});

test('详情非法 URL 在导航前被拒绝', async () => {
  for (const job of [undefined, '', '../unexpected', 'https://example.com/job_detail/abc.html', 'https://www.zhipin.com/web/geek/jobs']) {
    await assert.rejects(detail({ job }), /请提供岗位|非法岗位|只允许 zhipin.com|具体的 job_detail/);
  }
});
