#!/usr/bin/env node
'use strict';

const { Command } = require('commander');
const pkg = require('../package.json');
const { logger } = require('../src/util');

const program = new Command();

program
  .name('boss')
  .description('BOSS 直聘命令行工具：扫码登录、查询岗位、与 HR 打招呼（基于真实浏览器，抗反爬）')
  .version(pkg.version);

program
  .command('login')
  .description('微信扫码登录：渲染二维码到 qr.png(VSCode标签)+qr.html(浏览器)，扫码后登录态本地持久化复用')
  .option('-t, --timeout <seconds>', '等待扫码的最长秒数', '600')
  .action(async (opts) => {
    const { login } = require('../src/auth');
    const ok = await login({ timeoutMs: parseInt(opts.timeout, 10) * 1000 });
    process.exit(ok ? 0 : 1);
  });

program
  .command('whoami')
  .description('检查当前登录态是否有效（不弹窗）')
  .action(async () => {
    const { whoami } = require('../src/auth');
    const ok = await whoami();
    process.exit(ok ? 0 : 1);
  });

program
  .command('logout')
  .description('清除本地登录态')
  .action(async () => {
    const { logout } = require('../src/auth');
    await logout();
    process.exit(0);
  });

program
  .command('search <keyword>')
  .description('按关键词搜索岗位')
  .option('-c, --city <city>', '城市名或城市编码（默认全国）')
  .option('-n, --limit <n>', '返回条数', '20')
  .option('--show', '弹出可见浏览器窗口（默认无头）')
  .action(async (keyword, opts) => {
    const { search } = require('../src/jobs');
    try {
      await search({
        query: keyword,
        city: opts.city,
        limit: parseInt(opts.limit, 10),
        headless: !opts.show,
      });
      process.exit(0);
    } catch (e) {
      logger.error(`搜索失败：${e && e.message ? e.message : String(e)}`);
      process.exit(1);
    }
  });

program
  .command('show <jobIdOrUrl>')
  .description('查看岗位详情（传 job_detail URL 或加密 id）')
  .option('--show', '弹出可见浏览器窗口（默认无头）')
  .action(async (job, opts) => {
    const { detail } = require('../src/jobs');
    try {
      await detail({ job, headless: !opts.show });
      process.exit(0);
    } catch (e) {
      logger.error(e.message);
      process.exit(1);
    }
  });

program
  .command('greet <jobIdOrUrl>')
  .description('与该岗位的 HR 打招呼（发起沟通，可附自定义开场白）')
  .option('-m, --message <text>', '自定义开场白（不填则用 BOSS 默认招呼语）')
  .option('--headless', '无头运行（默认弹窗，便于观察/人工接管验证）')
  .action(async (job, opts) => {
    const { greet } = require('../src/chat');
    try {
      const ok = await greet({ job, message: opts.message, headless: !!opts.headless });
      process.exit(ok ? 0 : 1);
    } catch (e) {
      logger.error(`打招呼失败：${e && e.message ? e.message : String(e)}`);
      process.exit(1);
    }
  });

// 顶层异常兜底：fail loud，不吞错
process.on('unhandledRejection', (err) => {
  logger.error(`未处理异常：${err && err.stack ? err.stack : err}`);
  process.exit(1);
});

program.parseAsync(process.argv).catch((e) => {
  logger.error(e.message);
  process.exit(1);
});
