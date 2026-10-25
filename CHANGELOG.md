# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 文档

- 安装说明改为**仅 GitHub 安装**：npm 包尚未发布，原先的 `dsh plugin --profile web add dsh-convo-tally` 会 404。
- 删除「已知限制」段落（中英两版 README 与 CHANGELOG 中的对应小节）。
- 安装说明补充「锁定版本」与「离线安装」；已发布 tag `v0.1.0` 与对应 GitHub Release（附 tgz）。

## [0.1.0] - 2026-10-25

首个公开版本。

### 功能

- 侧栏显示**当前对话**的今日花费与累计花费，金额统一两位小数。
- 峰谷角标：显示当前是高峰价还是谷价，并给出下次切换的倒计时。
- 人民币 / 美元切换：两种货币各用 DeepSeek 官方价目表，不做汇率折算。
- 重置按钮：只清零「累计」的显示，按会话区分，上限 50 条基线。

### 计价

- 覆盖 `deepseek-flash` 与 `deepseek-v4-pro` 两族，含历史档位（2026-09-10 之前的 Flash、2026-08-16 之前的平价）。
- 峰谷按**每次调用的发起时刻**判定；周末与中国法定节假日全天按空闲价。
- `inputTokens`（未命中）与 `cacheReadTokens`（命中）按互斥桶分别计价。
- `reasoning` token 官方不计费，不计入。

### 准确性

- 折叠语义对齐宿主官方 `tokenUsage` 投影：同 turn/step 替换、重放幂等、`llm/retry-started` 开新槽位、跳过 fork 继承前缀。
- 90 个真实会话日志与宿主 `tokenUsage` 投影逐字段比对，输入 / 输出 / 缓存命中全部逐 token 相同。
- 与官方中文页、英文页的单价逐项核对一致。
