# boss-cli

BOSS 直聘命令行工具：**扫码登录、查询岗位、与 HR 打招呼**。

> 为什么用浏览器而不是纯 HTTP？BOSS 直聘反爬很硬（`__zp_stoken__` 请求签名由混淆 JS 实时生成、TLS 指纹校验、设备指纹、风控验证页）。纯逆向签名的方案会持续失效。本工具走**真实 Chrome + 持久化登录态**这条最抗反爬的路：让站点自己的 JS 生成签名、用真人节奏操作、撞到验证页就停下等人工。

## 安装

```bash
git clone <仓库地址> boss-cli && cd boss-cli
npm install            # 安装 playwright + commander（项目本地，约 17MB）
npm link               # 可选：注册全局 boss 命令（无权限时用 sudo 或改用 npx）
```

- 依赖系统已安装的 **Google Chrome**（`channel: 'chrome'`，真实指纹最抗反爬）。没装 Chrome 会自动回退到 Playwright 内置 Chromium —— 此时需先 `npx playwright install chromium`，否则启动会报错（错误信息里会给出这条命令）。
- 不想全局安装可直接 `node bin/boss.js <命令>` 运行。
- **平台**：在 macOS 上开发验证。Windows / Linux 理论可用（Playwright 跨平台），但需本机装有 Chrome；首次请按下面「选择器校准」核对。
- **npm 发布提示**：`boss-cli` 这个名字在 npm 上可能已被占用。若要 `npm publish`，请改用带命名空间的名字（如 `@你的名字/boss-cli`）；`boss` 命令名不受影响。

## 使用

```bash
boss login                          # 渲染二维码，用「微信」扫码登录（登录态持久化，后续免扫码）
boss whoami                         # 检查登录态是否有效
boss search "后端工程师" -c 北京 -n 15  # 搜岗位
boss show <job_detail-URL 或 id>     # 看岗位详情
boss greet <job-URL> -m "您好，我对这个岗位很感兴趣"   # 和 HR 打招呼
boss logout                         # 清除登录态
```

常用选项：
- `search` / `show` 默认**无头**运行；加 `--show` 弹窗观察。
- `greet` 默认**弹窗**（写操作，便于观察和人工接管验证）；加 `--headless` 无头。
- 环境变量 `BOSS_JSON=1` 让 `search`/`show` 输出 JSON；`BOSS_DEBUG=1` 打开调试日志。

## 反爬设计

| 措施 | 说明 |
|------|------|
| 持久化 profile | `~/.boss-cli/userdata`，登录一次，cookie/指纹老化复用 —— 最强对策 |
| 真实 Chrome | `channel: 'chrome'`，真实 UA / TLS / 字体指纹 |
| stealth 注入 | 抹掉 `navigator.webdriver`、补 `window.chrome`、WebGL 厂商伪装等 |
| 不碰签名 | 查询走「渲染真实页面再读 DOM」，`__zp_stoken__` 由站点 JS 自己加 |
| 人类化节奏 | 动作间随机间隔（搜索 3–7s、打招呼 5–12s）、逐字打字、分段滚动、hover 再点 |
| 风控即停 | 命中验证页/验证文案立即停下报错，绝不在风控页反复重试 |

## 已知约束（含实测结论）

- **查询岗位必须先登录**（2026-06-03 实测）：未登录访问 `/web/geek/job` 会被跳转到 `/web/passport/zp/403.html` 访问受限页（「您的 IP 存在异常行为，请登录后使用」）。所以正确用法是先 `boss login` 扫码，再 `search`。`whoami`/`search`/`show`/`greet` 都会在导航前**离线读 profile cookie 判定登录态**：未登录时直接给出明确提示并 fail-fast，**根本不发起导航**，因此不会撞墙、不会白白触发 IP 频控（`whoami` 也据此干净区分「未登录」与「已登录但被频控」两种状态）。
- **BOSS 反爬是实时生效的**：实测中 logged-out 的几次导航就触发了**临时 IP 频控**（约 1 小时后自动解除）。务必控制频率：工具已内置随机间隔（搜索 3–7s、打招呼 5–12s），不要写循环高频调用。
- **登录是「微信扫码」，不是 BOSS App**（2026-06-03 实证）：BOSS 登录页默认「微信扫码 安全登录」，二维码是 `img.mini-qrcode`（200×200）。`boss login` 无头抓取该二维码，落地为 `~/.boss-cli/qr.png`（用 VSCode 打开成图片标签，随文件刷新自动重载）+ `~/.boss-cli/qr.html`（默认浏览器打开，每 3 秒自刷新），用**微信**扫码即可。这比「弹出浏览器窗口让用户找」可靠得多——窗口常跑到别的桌面/被挡住看不到。前提是 BOSS 账号已绑定微信；未绑定可改用页面上的「验证码登录/注册」（手机验证码）。
- **不要反复重启 `boss login` / 高频导航**（2026-06-03 血泪实测）：BOSS 反爬实时生效，短时间内反复访问登录页/首页会把 IP 刷进 `/web/passport/zp/403.html?code=31` 访问受限墙（首页、登录页一并 302 过去），需冷却（约几十分钟至 1 小时）才恢复。一次 `boss login` 没扫上就**耐心等当前二维码刷新**，别反复重启进程。
- **一个 profile 同一时刻只能一个进程**：共用 `~/.boss-cli/userdata`，并发两个 Chrome 会抢 profile → 页面卡在 about:blank。停止某个 run 要**连 node 一起停**（不能只杀 Chrome 留下 node 空跑）。`openContext` 每次启动会自清会话恢复状态、`getPage` 新开干净页，规避 about:blank 竞态。
- **DOM 选择器需首次校准**：登录态下的选择器是预设值，见上「选择器校准」。未校准时工具会主动提示。

## 选择器校准（首次使用务必做）

BOSS 是单页应用（SPA），前端 DOM 会随版本变化。**登录态下的搜索结果、岗位详情、打招呼按钮、聊天输入框这些选择器是按经验预设的，尚未在真实登录态下校准过**。没校准时运行会看到一条 ⚠️ 提示，且可能解析为空或失败。

首次校准步骤：

1. `boss login` 扫码登录。
2. `boss search "任意关键词" --show`：弹出的窗口里如果能看到岗位、但终端解析为空（或提示「选择器漂移」），按下面改选择器。
3. 在弹出的 Chrome 里按 `F12` → Console，用 `document.querySelectorAll('候选选择器')` 试，找到能命中岗位卡片 / 字段 / 按钮的选择器。
4. 把正确选择器填到 [`src/config.js`](src/config.js) 的 `SELECTORS`（每项是「候选数组」，把对的放最前面即可）。
5. `greet`、`show` 同理用 `--show` 核对 `startChat`、`chatInput`、岗位详情字段。
6. 全部跑通后，把 `src/config.js` 顶部的 `SELECTORS_CALIBRATED_AT` 改成当天日期（如 `'2026-06-10'`），⚠️ 提示即消失。

> 维护点单一：所有选择器只在 `SELECTORS` 一处，漂移了只改这里。

## 安全与隐私

把工具给别人用前，请让对方了解：

- **登录态存在本地**：`~/.boss-cli/userdata` 是一个持久化 Chrome profile，包含你**求职账号的登录 cookie 和浏览器指纹**。任何能读到这个目录的人 = 能用你的账号。工具已把 `~/.boss-cli` 权限收紧为仅本人可读（`0700`），但仍**不要把这个目录拷给别人、不要提交到 git、不要跨设备复制**（异地同指纹登录可能触发风控封号）。
- **日志在本地明文**：`~/.boss-cli/logs/boss.log` 会记录你的搜索关键词、打开过的岗位 URL 等（昵称已脱敏、自定义开场白只记字数不记内容）。文件权限 `0600`。介意可随时删除。
- **共享机器要登出**：用完（尤其在公用/借用的机器上）务必 `boss logout` —— 它会清除 cookie + localStorage + sessionStorage，避免登录态泄露给下一个使用者。
- **只会访问 zhipin.com**：`show` / `greet` 接收的 URL 会做域名白名单校验，非 `zhipin.com` 的链接一律拒绝，不会把你的登录态带去别的站点。
- 本工具仅供**个人**求职自动化，请遵守平台规则、控制频率，**勿用于批量打招呼 / 骚扰**。

## 目录结构

```
src/config.js     路径/常量/城市码/选择器/风控特征（集中维护）
src/browser.js    持久化上下文 + stealth 注入
src/anticrawl.js  限频 / 人类化行为 / 风控检测
src/auth.js       登录 / 登录态探测 / 登出
src/jobs.js       搜索 / 详情
src/chat.js       与 HR 打招呼
bin/boss.js       CLI 入口（commander）
```
