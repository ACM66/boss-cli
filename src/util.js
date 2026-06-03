'use strict';

const fs = require('fs');
const path = require('path');
const { LOG_DIR, ROOT_DIR, SELECTORS_CALIBRATED_AT } = require('./config');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// [min,max) 之间的随机整数，用于人类化抖动
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min)) + min;
}

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function color(c, s) {
  if (!process.stdout.isTTY) return s;
  return `${COLORS[c] || ''}${s}${COLORS.reset}`;
}

function ts() {
  // 不用本地时间格式化的繁琐逻辑，ISO 截到秒
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

let logDirReady = false;
function ensureLogDir() {
  if (logDirReady) return;
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  // 收紧权限：~/.boss-cli 下存的是登录态和日志，只允许本人读写，
  // 防止同机其他用户窥探 cookie / 搜索记录（分发到共享机器时尤其重要）
  try { fs.chmodSync(ROOT_DIR, 0o700); } catch (_) {}
  try { fs.chmodSync(LOG_DIR, 0o700); } catch (_) {}
  const logFile = path.join(LOG_DIR, 'boss.log');
  try {
    if (!fs.existsSync(logFile)) fs.writeFileSync(logFile, '', { mode: 0o600 });
    else fs.chmodSync(logFile, 0o600);
  } catch (_) {}
  logDirReady = true;
}

// 敏感字段脱敏（用于日志，避免昵称等明文落盘）：保留首字符，其余打码
function redact(s) {
  if (!s) return '';
  const str = String(s);
  if (str.length <= 1) return '*';
  return str[0] + '*'.repeat(Math.min(str.length - 1, 6));
}

// 过程日志：同时打到 stderr（带颜色）和 ~/.boss-cli/logs/boss.log（纯文本）
function log(level, msg) {
  ensureLogDir();
  const line = `[${ts()}] [${level.toUpperCase()}] ${msg}`;
  const colorMap = { info: 'cyan', warn: 'yellow', error: 'red', ok: 'green', debug: 'dim' };
  // 业务输出走 stdout，过程日志走 stderr，互不污染（便于管道处理）
  process.stderr.write(color(colorMap[level] || 'reset', line) + '\n');
  try {
    fs.appendFileSync(path.join(LOG_DIR, 'boss.log'), line + '\n');
  } catch (_) {
    /* 日志落盘失败不阻断主流程 */
  }
}

const logger = {
  info: (m) => log('info', m),
  warn: (m) => log('warn', m),
  error: (m) => log('error', m),
  ok: (m) => log('ok', m),
  debug: (m) => {
    if (process.env.BOSS_DEBUG) log('debug', m);
  },
};

// 极简表格输出（无第三方依赖）。rows: 字符串二维数组，第一行为表头
function printTable(headers, rows) {
  const all = [headers, ...rows];
  const widths = headers.map((_, i) =>
    Math.max(...all.map((r) => displayWidth(String(r[i] == null ? '' : r[i]))))
  );
  const sep = '  ';
  const fmtRow = (r) =>
    r.map((cell, i) => pad(String(cell == null ? '' : cell), widths[i])).join(sep);
  const out = [];
  out.push(color('dim', fmtRow(headers)));
  out.push(color('dim', widths.map((w) => '─'.repeat(w)).join(sep)));
  for (const r of rows) out.push(fmtRow(r));
  process.stdout.write(out.join('\n') + '\n');
}

// 中文占两个字符宽，做对齐
function displayWidth(s) {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 255 ? 2 : 1;
  return w;
}
function pad(s, width) {
  const diff = width - displayWidth(s);
  return s + ' '.repeat(Math.max(0, diff));
}

// 选择器未校准时，每个进程提示一次。提醒用户结果可能不准、且如何校准。
let calibWarned = false;
function warnIfUncalibrated() {
  if (calibWarned || SELECTORS_CALIBRATED_AT) return;
  calibWarned = true;
  logger.warn(
    '页面选择器尚未在真实登录态下校准，搜索/打招呼结果可能不准或失效。' +
      '首次使用请加 --show 跑一遍并对照浏览器校准（方法见 README「选择器校准」）。'
  );
}

module.exports = {
  sleep,
  randInt,
  color,
  logger,
  printTable,
  displayWidth,
  redact,
  warnIfUncalibrated,
};
