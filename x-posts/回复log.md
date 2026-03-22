# X 回复记录

## 2026-03-22

1. 回复了 @HiTw93 的帖子（浏览 36.5万，Learn Claude Code 教程推荐）：
   - 内容：分享跑完教程的体感——核心循环简单但 tool 设计和 error recovery 才是差距所在；context window 管理是第一个撞墙点，建议补 context pruning 章节

2. 回复了 @dotey 的帖子（浏览 5.1万，Anthropic 推出 Code Review）：
   - 内容：补充个人用户替代方案（开源 GitHub Action），分享 200+ PR/周项目两个月使用数据，从成本角度分析 15-25 刀/次的合理性

3. 回复了 @chenchengpro 的帖子（浏览 4.1万，git worktree + pnpm 多 agent 并行开发）：
   - 内容：补充 .env 配置冲突踩坑经验和 worktree 自动清理 cron 方案

## 2026-03-21

1. 回复了 @runes_leo 的帖子（浏览 2.6万，Claude Code TG Channel 远程控制）：
   - 内容：指出 /clear 断 MCP 连接的痛点，提出常驻 agent daemon 的替代方案，Telegram 只作为消息通道，不依赖终端进程
   - 链接：https://x.com/geyunfei/status/2035175300951417100

2. 回复了 @UnslothAI 的帖子（浏览 22.6万，Qwen3.5 本地跑 Claude Code）：
   - 内容：分享 KV cache invalidation fix 的实用价值，提出 always-on agent 场景下本地模型的成本优势——便宜模型跑日常任务，前沿模型专攻推理
   - 链接：https://x.com/geyunfei/status/2035175676408655901

3. 回复了 @Zai_org 的帖子（浏览 102.6万，GLM-5-Turbo for agent environments）：
   - 内容：分享用 GLM-5 via OpenRouter 做 batch 任务的实测体验，指出 agent 模型的真实考验是连续 50+ tool calls 不跑偏
   - 链接：https://x.com/geyunfei/status/2035175823809159537
