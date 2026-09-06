#!/usr/bin/env node
'use strict';

const { Command } = require('commander');
const pkg = require('../package.json');
const { logger } = require('../src/util');

const program = new Command();

program
  .name('boss')
  .description('BOSS 直聘命令行工具：扫码登录、查询岗位、与 HR 打招呼（专用 Chrome）')
  .version(pkg.version);

program
  .command('status')
  .description('离线查看访问冷却、额度和本地策略，不打开浏览器')
  .action(() => {
    const { AccessGuard } = require('../src/anticrawl');
    console.log(JSON.stringify(new AccessGuard().status(), null, 2));
  });

program
  .command('open')
  .description('打开已登录的专用 Chrome，优先复用当前网页；不使用侧边浏览器')
  .allowExcessArguments(false)
  .option('--existing-only', '只展示已有 BOSS 页面，不发起新的业务导航')
  .action(async (opts) => {
    const { openWebsite } = require('../src/auth');
    await openWebsite({ existingOnly: !!opts.existingOnly });
  });

program
  .command('login')
  .description('微信扫码登录：渲染二维码到 qr.png(VSCode标签)+qr.html(浏览器)，扫码后登录态本地持久化复用')
  .option('-t, --timeout <seconds>', '等待扫码的最长秒数', '600')
  .action(async (opts) => {
    const { login } = require('../src/auth');
    const seconds = Number(opts.timeout);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 1800) throw new Error('扫码等待时间必须是 1–1800 秒的整数');
    const ok = await login({ timeoutMs: seconds * 1000 });
    process.exit(ok ? 0 : 1);
  });

program
  .command('whoami')
  .description('检查当前登录态是否有效（复用专用浏览器）')
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
  .option('--show', '显示专用浏览器窗口（默认）')
  .option('--headless', '无头运行（站点可能要求可见窗口验证）')
  .option('--fresh', '刷新岗位缓存（仍遵守访问额度和冷却）')
  .action(async (keyword, opts) => {
    const { search } = require('../src/jobs');
    try {
      await search({
        query: keyword,
        city: opts.city,
        limit: Number(opts.limit),
        headless: !!opts.headless,
        fresh: !!opts.fresh,
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
  .option('--show', '显示专用浏览器窗口（默认）')
  .option('--headless', '无头运行（站点可能要求可见窗口验证）')
  .option('--fresh', '刷新岗位缓存（仍遵守访问额度和冷却）')
  .action(async (job, opts) => {
    const { detail } = require('../src/jobs');
    try {
      await detail({ job, headless: !!opts.headless, fresh: !!opts.fresh });
      process.exit(0);
    } catch (e) {
      logger.error(e.message);
      process.exit(1);
    }
  });

program
  .command('greet <jobIdOrUrl>')
  .description('与该岗位的 HR 建立联系（真实写操作；--dry-run 仅检查）')
  .option('-m, --message <text>', '预览自定义开场白（配合 --dry-run；实际发送尚未开放）')
  .option('--headless', '无头运行（默认弹窗，便于观察/人工接管验证）')
  .option('--dry-run', '检查岗位和沟通按钮，不发起沟通、不发送消息')
  .action(async (job, opts) => {
    const { greet } = require('../src/chat');
    try {
      const ok = await greet({ job, message: opts.message, headless: !!opts.headless, dryRun: !!opts.dryRun });
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
