'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { openContext, getPage } = require('./browser');
const { BASE_URL, SEARCH_URL, CITY_CODES, SELECTORS, ROOT_DIR } = require('./config');
const { logger, printTable, warnIfUncalibrated } = require('./util');
const { AccessGuard, classifyRisk, assertNoRiskControl } = require('./anticrawl');
const { hasLoginCookie, isLoggedInOnPage } = require('./auth');

class ReadCache {
  constructor(file = path.join(ROOT_DIR, 'read-cache.json')) { this.file = file; }
  read() {
    let saved;
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('无法读取岗位缓存：' + error.message); }
    if (saved?.version !== 1 || !saved.entries || typeof saved.entries !== 'object' || Array.isArray(saved.entries)) throw new Error('岗位缓存格式无效');
    for (const [key, entry] of Object.entries(saved.entries)) {
      if (!/^[a-f0-9]{64}$/.test(key) || !entry || !Number.isSafeInteger(entry.savedAt) || entry.savedAt < 0 || !Object.hasOwn(entry, 'data')) throw new Error('岗位缓存记录无效');
    }
    return saved.entries;
  }
  key(kind, value) { return createHash('sha256').update(JSON.stringify([kind, value])).digest('hex'); }
  get(kind, key, ttlMs) {
    const entry = this.read()[this.key(kind, key)];
    const age = entry ? Date.now() - entry.savedAt : Infinity;
    if (ttlMs <= 0 || age < 0 || age >= ttlMs) return null;
    logger.info('使用岗位缓存，读取时间：' + new Date(entry.savedAt).toISOString());
    return entry.data;
  }
  set(kind, key, data) {
    const entries = this.read();
    entries[this.key(kind, key)] = { savedAt: Date.now(), data };
    const keep = Object.fromEntries(Object.entries(entries).sort((a, b) => b[1].savedAt - a[1].savedAt).slice(0, 20));
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = this.file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, entries: keep }), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}

function resolveCity(city) {
  if (!city) return CITY_CODES['全国'];
  if (/^\d{9}$/.test(city)) return city;
  if (CITY_CODES[city]) return CITY_CODES[city];
  throw new Error('未知城市「' + city + '」，请使用支持的城市名或 9 位城市编码');
}

// 读取网页自身发起的请求，不自行生成签名或重放请求。
// 2026-09-05 实测：DOM 薪资为字体私用区字符，响应中的 salaryDesc 才是可读文本。
function parseJobList(payload) {
  if (!payload || payload.code !== 0) {
    throw new Error('岗位接口未成功：code=' + payload?.code + '，' + (payload?.message || '响应缺失'));
  }
  if (!Array.isArray(payload.zpData?.jobList)) throw new Error('岗位接口结构已变化：缺少 jobList');
  return payload.zpData.jobList.map((job) => {
    if (!job.jobName || !job.salaryDesc || !job.brandName || !job.encryptJobId) {
      throw new Error('岗位数据不完整：缺少名称、薪资、公司或岗位 ID');
    }
    return {
      name: job.jobName,
      salary: job.salaryDesc,
      area: [job.cityName, job.areaDistrict, job.businessDistrict].filter(Boolean).join('·'),
      company: job.brandName,
      tags: Array.isArray(job.jobLabels) ? job.jobLabels : [],
      url: normalizeJobUrl(job.encryptJobId),
    };
  });
}

function observeJobList(page, query, cityCode) {
  let lastError = '未收到岗位接口响应';
  let timer;
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const cleanup = () => { clearTimeout(timer); page.off('response', onResponse); page.off('terminated', onTerminated); };
  const onTerminated = (error) => { cleanup(); rejectResult(error); };
  const onResponse = async (response) => {
    if (new URL(response.url()).pathname !== '/wapi/zpgeek/search/joblist.json') return;
    const request = response.request();
    const parameters = request.method() === 'POST'
      ? new URLSearchParams(request.postData()) : new URL(request.url()).searchParams;
    if (parameters.get('query') !== query || parameters.get('city') !== cityCode) return;
    let payload;
    try { payload = await response.json(); } catch (e) {
      lastError = '岗位响应读取失败：' + e.message;
      cleanup();
      rejectResult(new Error(lastError));
      return;
    }
    if (payload?.code !== 0) {
      lastError = '岗位接口拒绝请求：code=' + payload?.code + '，' + (payload?.message || '未知原因');
      cleanup();
      const risk = classifyRisk({ url: response.url(), text: String(payload?.message || '') });
      try {
        if (risk) {
          page.context().accessGuard.recordRisk(risk, response.url());
          await page.context().freeze(risk);
        }
        rejectResult(risk || new Error(lastError));
      }
      catch (error) { rejectResult(error); }
      return;
    }
    cleanup();
    try { resolveResult(parseJobList(payload)); } catch (e) { rejectResult(e); }
  };
  page.on('response', onResponse);
  page.on('terminated', onTerminated);
  timer = setTimeout(() => { cleanup(); rejectResult(new Error('等待岗位数据超时：' + lastError)); }, 30000);
  return { result, cleanup };
}

function outputJobs(jobs, limit) {
  if (!Array.isArray(jobs) || jobs.some((job) => !job || !['name', 'salary', 'company', 'url'].every((key) => typeof job[key] === 'string' && job[key]))) throw new Error('岗位缓存数据不完整');
  const sliced = jobs.slice(0, limit);
  if (process.env.BOSS_JSON) console.log(JSON.stringify(sliced, null, 2));
  else if (sliced.length) {
    printTable(['#', '岗位', '薪资', '公司', '地区'], sliced.map((job, i) => [i + 1, job.name, job.salary, job.company, job.area]));
    console.log('');
    sliced.forEach((job, i) => console.log('  ' + (i + 1) + '. ' + job.url));
  } else console.log('没有找到符合条件的岗位');
  logger.ok('本页取得 ' + jobs.length + ' 个岗位，输出 ' + sliced.length + ' 个');
  return sliced;
}

async function search({ query, city, limit = 20, headless = false, fresh = false, context: suppliedContext }) {
  if (!query || !query.trim()) throw new Error('请提供搜索关键词，例如：boss search "后端工程师"');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('返回条数必须是 1–100 的整数');
  const cityCode = resolveCity(city);
  const url = new URL(SEARCH_URL);
  url.searchParams.set('query', query);
  url.searchParams.set('city', cityCode);
  warnIfUncalibrated('search');
  const guard = suppliedContext?.accessGuard || new AccessGuard();
  guard.assertAllowed();
  const cache = new ReadCache();
  const key = [query, cityCode];
  const cached = !fresh && cache.get('search', key, guard.policy.cacheTtlMs);
  if (cached) return outputJobs(cached, limit);
  const context = suppliedContext || await openContext({ headless });
  let observation;
  try {
    if (!(await hasLoginCookie(context))) throw new Error('未登录，已在导航前拦下。请先运行：boss login');
    const page = await getPage(context);
    logger.info('搜索：' + query + ' @ city=' + cityCode);
    observation = observeJobList(page, query, cityCode);
    let jobs;
    try {
      [, jobs] = await Promise.all([
        page.goto(url.toString(), { waitUntil: 'domcontentloaded' }),
        observation.result,
      ]);
    } catch (e) {
      await assertNoRiskControl(page);
      if (page.url().includes('/web/user/')) throw new Error('登录态已失效，请运行：boss login');
      throw e;
    }
    await assertNoRiskControl(page);
    const actualQuery = new URL(page.url()).searchParams.get('query');
    if (actualQuery !== query) throw new Error('页面跳转后搜索关键词丢失，结果未采用');
    cache.set('search', key, jobs);
    return outputJobs(jobs, limit);
  } finally {
    observation?.cleanup();
    if (!suppliedContext) await context.close();
  }
}

function normalizeJobUrl(idOrUrl) {
  if (!idOrUrl) throw new Error('请提供岗位 URL 或加密 id');
  if (/^https?:\/\//.test(idOrUrl)) {
    let u;
    try { u = new URL(idOrUrl); } catch (_) { throw new Error('非法 URL：' + idOrUrl); }
    const host = u.hostname.toLowerCase();
    if (host !== 'zhipin.com' && !host.endsWith('.zhipin.com')) {
      throw new Error('出于安全考虑，只允许 zhipin.com 域名的链接，拒绝：' + host);
    }
    if (!/^\/job_detail\/[A-Za-z0-9~_-]+\.html$/.test(u.pathname)) throw new Error('请提供具体的 job_detail 岗位链接');
    return u.toString();
  }
  const id = String(idOrUrl).replace(/\.html$/, '');
  if (!/^[A-Za-z0-9~_-]+$/.test(id)) throw new Error('非法岗位 id：' + idOrUrl);
  return BASE_URL + '/job_detail/' + id + '.html';
}

async function readDetail(page) {
  const info = await page.evaluate((S) => {
    const text = (selectors) => {
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el?.innerText.trim()) return el.innerText.trim();
      }
      return '';
    };
    return {
      name: text(S.detailName), salary: text(S.detailSalary),
      company: text(S.detailCompany), desc: text(S.detailDesc),
    };
  }, SELECTORS);
  if (!info.name || !info.company || !info.salary || !info.desc) {
    throw new Error('岗位详情不完整：页面未加载完成、岗位已失效或选择器已变化');
  }
  if (/[\uE000-\uF8FF]/.test(info.salary)) throw new Error('详情薪资包含不可读字体编码，未输出错误薪资');
  return info;
}

function outputDetail(url, info) {
  if (!info || !['name', 'company', 'salary', 'desc'].every((key) => typeof info[key] === 'string' && info[key]) || /[\uE000-\uF8FF]/.test(info.salary)) throw new Error('岗位详情缓存不完整或不可读');
  if (process.env.BOSS_JSON) console.log(JSON.stringify({ url, ...info }, null, 2));
  else console.log('\n岗位：' + info.name + '   ' + info.salary + '\n公司：' + info.company + '\n链接：' + url + '\n\n职位描述：\n' + info.desc + '\n');
  logger.ok('已读取岗位详情：' + info.name);
  return { url, ...info };
}

async function detail({ job, headless = false, fresh = false, context: suppliedContext }) {
  const url = normalizeJobUrl(job);
  const guard = suppliedContext?.accessGuard || new AccessGuard();
  guard.assertAllowed();
  const cache = new ReadCache();
  const key = new URL(url).origin + new URL(url).pathname;
  const cached = !fresh && cache.get('detail', key, guard.policy.cacheTtlMs);
  if (cached) return outputDetail(url, cached);
  const context = suppliedContext || await openContext({ headless });
  try {
    if (!(await hasLoginCookie(context))) throw new Error('未登录，已在导航前拦下。请先运行：boss login');
    const page = await getPage(context);
    logger.info('打开岗位详情：' + new URL(url).origin + new URL(url).pathname);
    if (fresh || page.url() !== url) await page.goto(url, { waitUntil: 'domcontentloaded' });
    try { await page.waitForSelector(SELECTORS.detailDesc.join(', '), { timeout: 20000 }); }
    catch (e) { await assertNoRiskControl(page); throw new Error('未等到岗位详情：' + e.message); }
    await assertNoRiskControl(page);
    if (!(await isLoggedInOnPage(page))) throw new Error('页面未确认登录态，请运行：boss whoami');
    const info = await readDetail(page);
    cache.set('detail', key, info);
    return outputDetail(url, info);
  } finally { if (!suppliedContext) await context.close(); }
}

module.exports = { search, detail, resolveCity, normalizeJobUrl, parseJobList, readDetail, ReadCache };
