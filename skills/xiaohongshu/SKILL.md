# 小红书（Xiaohongshu）打开/登录态检查（OpenClaw browser profile=openclaw）

> 目的：用 OpenClaw 的隔离浏览器 `profile=openclaw` 打开小红书，并确认是否处于登录态。

## 适用场景

- 需要在 OpenClaw 的 browser 里访问小红书网页/创作中心
- 不依赖“接管你本机 Chrome（profile=user）”的登录态

## 关键结论

- 优先使用：`profile=openclaw`（隔离浏览器用户目录，cookie/localStorage 会持久化）
- 如果首次进入要求登录：在 `profile=openclaw` 里手动登录一次（扫码/短信/验证码），之后会复用登录态。

## 打开与登录态判断

### 1) 创作中心（推荐）

- URL：`https://creator.xiaohongshu.com/creator/home`

**登录态判断：**

- 能看到「笔记数据总览」「草稿箱中有未发布的作品」等后台模块 → 已登录
- 如果跳转到登录/验证码页 → 未登录，需要在该 profile 手动登录

### 2) 首页（仅验证可访问性）

- URL：`https://www.xiaohongshu.com/`

## OpenClaw browser 操作模板

1. `browser start (profile=openclaw)`
2. `browser open` / `browser navigate` 到上述 URL
3. `browser snapshot` 检查是否已登录

## 备注

- 这套方法与发 X（x.com）一致：隔离浏览器 profile 保持自己的登录态。
