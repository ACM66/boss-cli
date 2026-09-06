'use strict';

// 仅验证会话候选判定的离线规则；cookie 候选通过不代表服务端已确认登录。
// 本文件不读取用户 cookie，不启动、连接或模拟浏览器。
const test = require('node:test');
const assert = require('node:assert/strict');
const { isSessionCookie } = require('../src/auth');
const now = 1788616800;

// 固定非敏感值只用于纯函数的边界输入，不是捕获或伪造的登录凭证。
const candidate = (overrides = {}) => ({ name: 'wt2', value: 'unit-test-noncredential', expires: now + 60, ...overrides });

test('wt2/zp_at 的非空未过期和会话 cookie 可作为会话候选', () => {
  for (const name of ['wt2', 'zp_at']) {
    assert.equal(isSessionCookie(candidate({ name }), now), true);
    assert.equal(isSessionCookie(candidate({ name, expires: -1 }), now), true);
  }
});

test('签名、设备和含 token/geek 的其他 cookie 不作为登录会话候选', () => {
  for (const name of ['__zp_stoken__', 'zp_sseed', 'geek', 'token', 'other_token', 'WT2', '']) {
    assert.equal(isSessionCookie(candidate({ name }), now), false, name);
  }
});

test('到期边界和过期 cookie 不作为会话候选', () => {
  for (const name of ['wt2', 'zp_at']) {
    for (const expires of [now, now - 1, 0, -2, undefined, NaN]) {
      assert.equal(isSessionCookie(candidate({ name, expires }), now), false, `${name}: expires=${expires}`);
    }
  }
});

test('会话名称正确但值为空、缺失或不是字符串时不作为会话候选', () => {
  for (const name of ['wt2', 'zp_at']) {
    for (const value of ['', undefined, null, 123, false]) {
      assert.equal(isSessionCookie(candidate({ name, value }), now), false, `${name}: value=${value}`);
    }
  }
});
