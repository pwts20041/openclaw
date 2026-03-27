# OpenClaw 发布后部署与验收手册

本手册与批处理脚本统一放在 `deploy-post-release` 目录下，作为发布后操作的唯一入口。

## 1. 目录内容

- `00_post_release_menu.bat`：发布后总入口菜单（推荐）
- `01_publish_only.bat`：只发布
- `02_restart_only.bat`：只重启
- `03_publish_restart_verify.bat`：发布 + 重启 + 验证（推荐）
- `04_quick_regression.bat`：快速回归（self-check + verify）
- `05_capture_snapshot.bat`：环境快照采集
- `verify_post_release.ps1`：自动验收脚本
- `capture_snapshot.ps1`：快照采集脚本（输出 JSON 到 `logs/`）

## 2. 推荐流程

```powershell
Set-Location "D:\OpenClaw\Develop\openclaw\deploy-post-release"
.\00_post_release_menu.bat
```

菜单中优先选择：`3`（Publish + Restart + Verify）。

无交互命令：

```powershell
Set-Location "D:\OpenClaw\Develop\openclaw\deploy-post-release"
.\03_publish_restart_verify.bat
```

也可直接使用总入口的参数模式：

```powershell
Set-Location "D:\OpenClaw\Develop\openclaw\deploy-post-release"
.\00_post_release_menu.bat release-verify
.\00_post_release_menu.bat verify
.\00_post_release_menu.bat quick-regression
.\00_post_release_menu.bat snapshot
```

也可直接执行快速回归脚本：

```powershell
Set-Location "D:\OpenClaw\Develop\openclaw\deploy-post-release"
.\04_quick_regression.bat
.\05_capture_snapshot.bat
```

参数映射：

- `publish` 或 `1`
- `restart` 或 `2`
- `release-verify` 或 `3`
- `verify` 或 `4`
- `logs` 或 `5`
- `self-check` 或 `6`
- `quick-regression` 或 `7`
- `snapshot` 或 `8`
- `docs`

## 3. 验证项说明

`verify_post_release.ps1` 会检查：

- 网关健康状态（默认 `http://127.0.0.1:18789`）
- `config.runtime.json` 的插件配置与 `plugins.allow`
- Feishu 通道策略：
  - `enabled=true`
  - `connectionMode=websocket`
  - `dmPolicy=open`
  - `requireMention=false`
  - `allowFrom` 包含 `*`
- 关键 skills 是否存在
- `gateway.log` 是否出现关键错误模式（axios 缺失、插件加载失败等）

## 4. 常见问题

### 4.1 飞书能发测试消息但不回复

优先检查 Feishu 策略与 pairing 状态，再重跑：

```powershell
.\03_publish_restart_verify.bat
```

### 4.2 发布后插件报 axios 缺失

说明运行时依赖未恢复完整，直接执行推荐闭环流程即可。

### 4.3 批处理中断或卡住

先终止当前挂起窗口，再从 `00_post_release_menu.bat` 重新执行。

### 4.4 发布时报 `Access is denied` / `Permission denied`（runtime-next\package\dist）

现象：

- 发布阶段卡在 `Replace runtime directory` 或 `Extract package to runtime directory`
- 日志出现 `Permission denied` 或 `拒绝访问`

处理（管理员 PowerShell）：

```powershell
icacls "D:\OpenClaw\deploy\openclaw-runtime-next" /grant *S-1-1-0:(OI)(CI)F /T /C
icacls "D:\OpenClaw\deploy\openclaw-runtime-next\package\dist" /grant *S-1-1-0:(OI)(CI)F /T /C
attrib -R "D:\OpenClaw\deploy\openclaw-runtime-next\package\dist\*" /S /D
```

然后重新执行：

```powershell
Set-Location "D:\OpenClaw\Develop\openclaw\deploy-post-release"
.\03_publish_restart_verify.bat
```

## 5. 与主菜单关系

- 项目根目录 `deploy_menu.bat` 提供全量部署能力。
- `deploy-post-release` 目录专注发布后动作，便于运维与归档。
- 建议发布后固定使用本目录脚本，减少遗漏。
- 若部署目录不在默认路径，可通过环境变量 `OPENCLAW_DEPLOY_DIR` 自定义：

```powershell
$env:OPENCLAW_DEPLOY_DIR = "E:\MyDeploy"
.\00_post_release_menu.bat release-verify
```

- PowerShell 脚本也支持参数传入自定义路径：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\verify_post_release.ps1 -ProjectDir "C:\MyProject\openclaw" -DeployDir "E:\MyDeploy" -Port 18789
```

## 6. 稳定性增强说明

本目录脚本已补充 fail-fast 前置检查：

- 缺失关键脚本时立即报错并退出，不再静默继续。
- `01/02` 会检查 `deploy_menu.bat` 是否存在，并校验项目目录可进入。
- `03` 会校验 `01/02/verify` 三个依赖脚本存在后再执行。
- `00` 新增 `self-check` 与 `quick-regression`，可作为发布后快速健康闸门。
- 可随时执行 `snapshot` 采集运行环境快照，便于回溯问题。

快照输出目录：

```text
deploy-post-release\logs\snapshot-YYYYMMDD-HHMMSS.json
```
