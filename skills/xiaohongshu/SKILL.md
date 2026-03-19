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

## 发帖配图：先用生图 skill 生成卡片图（推荐）

如果要发图文笔记并需要“封面/分工卡/指令卡/输出示意/why/CTA”等配图，先用 **Gemini Nano Banana Pro** 生图，再上传到小红书草稿。

- 生图 skill：`skills/gemini-nano-banana/`
- 默认模型：`nano-banana-pro-preview`

生成 6 张 3:4 卡片图（落盘到 `/tmp/xhs_nano_banana/`）：

```bash
cd /Users/geyunfei/dev/openclaw/workspace-writer
node skills/gemini-nano-banana/scripts/generate_xhs_cards.mjs /tmp/xhs_nano_banana
```

然后在小红书创作中心草稿编辑页上传这些图片（建议先存草稿，再人工检查后发布）。

## 图文草稿上传图片（关键：避免“看似上传成功但实际没进草稿”）

> 经验结论：`browser.upload` **只能上传**位于 OpenClaw 临时 uploads 目录下的文件。
> 直接拿 `/tmp/...` 或其它路径会被拒绝，从而出现“我以为上传了，但草稿里没有图”的情况。

### 1) 先把图片拷贝到 uploads 目录

```bash
UPLOAD_DIR="/var/folders/zp/8m3zqqgj2fb0_njgh6scd8qm0000gn/T/openclaw-501/uploads"
mkdir -p "$UPLOAD_DIR/xhs"
cp /tmp/xhs_nano_banana/*.png "$UPLOAD_DIR/xhs/"
```

### 2) 在草稿编辑页触发上传，并用 browser.upload 选择文件

- 进入：创作中心 → 草稿箱 → 图文笔记 → 找到目标草稿点“编辑”
- 在编辑页，找到“选择文件/上传图片”的入口（一般是左侧缩略图区域）
- 触发文件选择后，调用：

```json
{
  "action": "upload",
  "profile": "openclaw",
  "targetId": "<当前小红书tab targetId>",
  "paths": [
    ".../uploads/xhs/01_01-封面.png",
    ".../uploads/xhs/02_02-岗位分工卡.png",
    ".../uploads/xhs/03_03-三句话怎么@（指令示例）.png",
    ".../uploads/xhs/04_04-输出示意（简报样式）.png",
    ".../uploads/xhs/05_05-为什么更稳.png",
    ".../uploads/xhs/06_06-结尾-CTA（暗号）.png"
  ]
}
```

### 3) 上传后必须做“是否真的进草稿”的验证

- 等待 3-8 秒让缩略图渲染
- 看页面左上角计数是否从 **1/18** 变成 **7/18**（或至少 >1）
- 或者截图确认左侧缩略图出现多张

验证通过后，再点 **“暂存离开”**。

## 备注

- 这套方法与发 X（x.com）一致：隔离浏览器 profile 保持自己的登录态。
