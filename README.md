# dsh-convo-tally

**DSH 侧栏会话记账。** 两行数字，回答一个问题：*这个对话花了多少钱？*

[![CI](https://github.com/Fireawa/dsh-convo-tally/actions/workflows/ci.yml/badge.svg)](https://github.com/Fireawa/dsh-convo-tally/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/Fireawa/dsh-convo-tally)](https://github.com/Fireawa/dsh-convo-tally/releases)

```
[重置] [¥]
本对话 · 今日   ¥3.82
本对话 · 累计   ¥12.34
● 周末谷价 · 1天9小时后进入高峰
```

[English](README.en.md) · [更新日志](CHANGELOG.md) · [许可](#许可)

---

## 功能

- **本对话今日花费 / 累计花费** —— 只算当前这个对话，不是全局账。
- **峰谷角标** —— 现在按高峰价还是谷价计费，还有多久切换。
- **人民币 / 美元切换** —— 两种货币各用官方自己那张价目表，**不做汇率折算**。
- **一键重置累计** —— 只清「累计」的显示，「今日」保持真实值；只影响这个对话。
- **金额统一两位小数**。
- 不联网、不发遥测、不读凭据。

## 安装

要求：**Node.js 20+**（见 `package.json` 的 `engines`），且已装好 DSH。

目前**只支持从 GitHub 安装**（npm 包尚未发布）。

安装最新版：

```bash
dsh plugin --profile web add github:Fireawa/dsh-convo-tally
```

锁定到某个版本（推荐，避免以后主分支变动影响你）：

```bash
dsh plugin --profile web add github:Fireawa/dsh-convo-tally#v0.1.0
```

离线安装：从 [Releases](https://github.com/Fireawa/dsh-convo-tally/releases) 下载 `dsh-convo-tally-0.1.0.tgz`，把下面路径换成实际文件位置：

```bash
dsh plugin --profile web add ./dsh-convo-tally-0.1.0.tgz
```

本地开发（改完立即生效）：

```bash
git clone https://github.com/Fireawa/dsh-convo-tally.git
cd dsh-convo-tally
npm install
dsh plugin --profile web add link:$PWD
```

装完**硬刷新页面**（Ctrl/Cmd+F5）。宿主侧若有改动则需重启 `dsh web`。

卸载：

```bash
dsh plugin --profile web remove dsh-convo-tally
```

## 计价规则

### 单价（每百万 tokens，￥ / $）

| 模型 | 档位 | 缓存命中 | 缓存未命中 | 输出 |
| --- | --- | --- | --- | --- |
| deepseek-flash | 空闲 | 0.02 / 0.003 | 1 / 0.15 | 4 / 0.6 |
| deepseek-flash | 高峰 | 0.04 / 0.006 | 2 / 0.3 | 8 / 1.2 |
| deepseek-v4-pro | 空闲 | 0.15 / 0.022 | 4.5 / 0.66 | 13.5 / 1.98 |
| deepseek-v4-pro | 高峰 | 0.3 / 0.044 | 9 / 1.32 | 27 / 3.96 |

价格取自官方中文页与英文页（2026-10 核对）。历史档位（2026-09-10 12:00 北京时间之前的 Flash、2026-08-16 16:00 UTC 之前的平价）也内置，用于给旧会话计价。

### 公式

```
花费 = (未命中输入 × 未命中价
      + 缓存命中   × 命中价
      + 缓存写入   × 命中价
      + 输出       × 输出价) / 1_000_000
```

- 宿主的 `inputTokens` 是**已扣除缓存命中**的部分，和 `cacheReadTokens` 互斥——两个桶不能相加再套一个价。
- `reasoning` token 官方单独上报且**不计费**，不进入公式。
- 官方表未单列「缓存写入」，按命中价计；实测 19000+ 条用量记录中该桶恒为 0。

### 峰谷

- 高峰：**北京时间周一至周五 9:00–12:00、14:00–18:00**。
- 其余时段、**周末**与**中国法定节假日**全天为空闲；空闲价 = 高峰价的一半。
- **按每次调用的「发起时刻」定档**，不是按现在，也不是按流结束时刻。

## 设计要点

### 为什么用「不可见探针」

`sidebar.footer.action` 是 **root 作用域**插槽，框架只传 `{ wide }`——侧栏自己拿不到当前会话，也就拿不到 `useProjection`。

所以本插件在**会话作用域**的 `conversation.composer.dock` 放一个不渲染任何内容的探针，它拿得到框架按当前会话绑定的投影值，写进同一 bundle 的模块级变量，侧栏读它。切换对话时探针重渲染，侧栏随即跟上。

**不能用"最近活动会话"这种启发式**：那样能显示出数字，但切到别的对话时不会变——那是本项目修过的 bug。

### 为什么两张价目表

官方中文页与英文页的单价**不是**按统一汇率对齐的：flash 的内嵌比值是 6.667，pro 是 6.818。用一张表乘汇率，换成另一种货币必然有一边偏。所以两种货币各算各的，切换只是换显示。

### 折叠语义

数字算错通常不是公式错，而是事件折叠错。这里照搬宿主官方 `tokenUsage` 投影的语义：

| 规则 | 为什么 |
| --- | --- |
| 同 turn/step 的新结算**替换**旧值 | 流式多次回报用量，累加会翻倍 |
| 同 turn/step 且分桶相同**短路** | 重放日志必须幂等 |
| 只有 `llm/retry-started` 才开新槽位 | 重试是真实的第二次请求 |
| 跳过 fork 继承前缀 | 父会话已付过，不能重复计 |
| 模型取自 `request/header` | `assistant/message` 只带 usage，不带模型 |

## 自测

```bash
npm test        # 三套离线测试：计价折叠 / 客户端渲染 / 两份时刻表一致性
npm run check   # 语法检查 + npm test
```

离线测试不需要 DSH。CI 在 Node 20 / 22 上跑同一套。

## 目录

```
lib/index.js       宿主侧：注册 convoCost 会话投影（折叠 + 双币计价）
lib/pricing.js     官方价目表、峰谷判定、花费计算（纯函数）
lib/client.js      浏览器侧：探针 + 侧栏渲染 + 两个按钮
test/              selftest / client-selftest / consistency
```

## 反馈

- 遇到问题、发现金额对不上，或想提建议：**[开 issue](https://github.com/Fireawa/dsh-convo-tally/issues)**。
- 报问题时请尽量带上：
  - DSH 版本与插件版本（Release 版本号，或 `npm ls dsh-convo-tally`）；
  - 侧栏显示金额与官方账单的对比（涉及计价偏差时）；
  - 复现步骤：什么时候开始的、切过币种或重置过没有。
- 以 issue 为主，PR 不保证合并。

## 许可

[MIT](LICENSE)
