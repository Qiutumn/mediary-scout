# Fork 开发与 OrbStack 部署

上游为 fancydirty/mediary-scout，fork 为 Qiutumn/mediary-scout。开发分支 `feat/telegram-share-import`。

## 本机开发

需要 Node 22.13+、Python 3、OrbStack Docker。首次运行：

```sh
npm ci
npm run dev:setup
npm run dev:local
```

开发页 http://127.0.0.1:3001。开发 Compose 项目 `mediary-scout-dev`，独立数据库卷 `dev-pgdata`，Postgres 5433，PanSou 8089，均绑定本机。`.local/dev.env` 自动生成且权限 0600。worker 和 Telegram 默认关闭，避免开发实例重复处理生产网盘。

恢复原实例到空开发库（不会覆盖非空数据库）：

```sh
python3 scripts/dev-setup.py --restore /private/backup/path/database.dump
```

开发模式仍使用真实网盘认证的副本。显式开启 worker 前确认不会与生产处理同一目录。常规测试使用模拟网盘，不会修改真实文件。

## 本地备份

```sh
python3 scripts/backup-instance.py
```

默认保存至仓库外的 `../private-backups/mediary-scout/<时间>/`。完整保存 PostgreSQL（包括网盘/模型/账号认证）、容器 inspect、合并 Compose、`.env` 及本地覆盖文件。目录 0700，文件 0600；使用 PostgreSQL 校验归档可读性，并生成 SHA-256 清单。不向终端打印凭据。数据库备份是明文凭据容器，应自行保留受保护的离机副本。

备份目录、`.local`、`.env`、本机部署覆盖均排除 Git 和 Docker 构建上下文。

## 检查与发布

```sh
npm run build:workflow
npm test
npm run lint
npm run build:web
git add <要发布的源码文件>
git commit
git push -u origin feat/telegram-share-import
npm run deploy:orb
```

部署脚本要求已提交的源码；不自动拉取上游。它先完整备份、保留旧镜像 `mediary-scout-web:rollback`，构建当前 commit，再替换 web 容器，保留原数据库、端口和认证，最后验证 BUILD_COMMIT 与数据库健康接口。

回滚网页镜像（不回滚数据库）：

```sh
docker --context orbstack image tag mediary-scout-web:rollback mediary-scout-web:latest
docker --context orbstack compose up -d --no-deps --no-build --force-recreate web
```

本次新增任务字段保存在既有 JSON payload 中，无破坏性数据库迁移。旧版本不支持新增分享导入字段；有排队中的分享任务时，应先等待任务结束再回滚。

## Telegram Bot

按 [Telegram Bot API](https://core.telegram.org/bots/api#getupdates) 使用 long polling，无需公网入口。`.env` 加入：

```dotenv
TELEGRAM_ENABLED=1
TELEGRAM_BOT_TOKEN=<BotFather 提供的 token>
TELEGRAM_ALLOWED_USER_IDS=<数字用户 ID，逗号分隔>
```

`docker --context orbstack compose up -d web` 后生效。只接受白名单用户私聊；这些用户作为**实例站主**操作站主媒体库，不是自动映射为其他应用账号。群聊、频道及未授权消息不执行、不回复。单实例一个 poller，不与 webhook 同时使用；如该 Bot 已配置 webhook，应由操作者先确认后撤销。出站代理沿用项目 HTTP_PROXY / HTTPS_PROXY 配置。

命令：`/start`、`/help`、`/get 片名`、`/drives`、`/status [任务ID]`；直接粘贴分享链接，或 `/import 链接 | 片名 | movie:157336 | storage=cs_xxx`。剧集用 `tv:ID | s2`。歧义时 `/choose 序号`。完成后回复任务状态。

消息 offset、处理回执、候选和完成通知订阅保存在账号设置中，重启恢复；消息回复与完成通知是至少一次投递，极小的「发送成功但保存前崩溃」窗口可能重复通知，但相同分享不会重复入队。分享任务失败后可从网页活动页或 agent retry 接口重试。修改白名单后需重建 web 容器，已移除用户不再收到完成通知。

## Telegram 话题网关

已有 Telegram 话题网关时，给本应用单独注册 `virtual` 应用与话题。真实 Bot Token 留在网关，本服务仅持有该应用 token。网关不会自动执行本服务的用户白名单，入口仍验证真实 `from.id`，并拒绝匿名 `sender_chat`、未知话题、缺少身份和机器人消息。

```dotenv
TELEGRAM_ENABLED=1
TELEGRAM_MODE=gateway
TELEGRAM_API_ROOT=http://host.docker.internal:18765
TELEGRAM_BOT_TOKEN=<本应用的网关 token>
TELEGRAM_ALLOWED_USER_IDS=<允许的真实用户 ID>
TELEGRAM_ALLOWED_CHAT_IDS=<绑定返回的 app_chat_id，多个用逗号分隔>
```

Mac 原生进程使用 `http://127.0.0.1:18765`，OrbStack 容器使用经实际探测的 `host.docker.internal`。网关请求使用独立直连 dispatcher，绕过环境代理，读取超时为 95 秒。应用只运行一个 poller，保留积压；不要用诊断脚本额外调用 getUpdates。

在绑定话题中使用 `/help`、`/drives`、`/get`、`/import`、`/choose`、`/status`，直接发送分享链接也可。回复和完成通知返回原虚拟 chat_id；候选会话按话题和真实用户隔离。用户或话题从白名单移除后，不再发送该订阅的通知。当前仅处理新消息及文字说明，不支持按钮回调或编辑消息触发业务。

网关和原私聊 Bot 使用不同的持久状态命名空间；旧 offset、候选和通知订阅保留，切换后不会把原私聊记录发到群话题。旧 Bot 的 file_id、会话和未完成通知不自动迁移。回退时恢复原 `.env` 的私聊模式/token 并重建 web 容器。

若网关返回 `UPSTREAM_RESULT_UNKNOWN` 或发送请求的连接结果不明，保存 `deliveryUncertain` 和可用的 `gateway_request_id`，停止自动重发该条回复/通知；继续接收后续消息。应先在网关发送记录中按 request ID 核对，不能盲目重试。业务任务回执已持久化，用户可用 `/status` 获取最新结果。明确尚未发出的 `UPSTREAM_CONNECT_FAILED` 会保留请求编号，按原轮询机制稍后重试。网关内部命令可注册后用 `/gw_commands` 查看。

接入验证分为容器网络、应用凭据、鉴权/话题隔离测试和真实交互；前两项通过不能代替用户在话题发送命令后的实际回包验证。

## 分享导入 API / Skill

`.env` 设置随机 `MEDIA_TRACK_AGENT_TOKEN` 启用 API。连接文件 `{ "baseUrl": "http://127.0.0.1:3000", "token": "…" }` 可保存为 `~/.mediary-scout/agent.json`（0600）。Skill 位于 `skills/mediary-share-import`，可复制到 `~/.codex/skills/mediary-share-import`。

完整请求、错误码及命令见 [分享 Skill](../skills/mediary-share-import/SKILL.md) 和 [API](../skills/mediary-share-import/references/api.md)。支持 115、夸克、123、天翼同品牌分享；多作品或多季分享需要明确选择目标。光鸭没有分享转存能力，返回不支持。

导入仅使用用户指定分享，不替换为 PanSou 搜索结果。队列、网盘执行器、媒体目录、字幕和落盘验证复用原流程。仅分享导入增加视频规范命名和同名字幕同步，普通搜索获取继续保留原文件名。
