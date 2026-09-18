# HTTP API

所有调用需要 `Authorization: Bearer <MEDIA_TRACK_AGENT_TOKEN>`，权限为实例站主。网盘必须属于站主，接口不接受 accountId。无 token 配置时返回 404，错误 token 返回 401。

## POST /api/agent/import-share

```json
{"url":"https://pan.quark.cn/s/…","password":"可选提取码","query":"星际穿越","type":"movie","tmdbId":157336,"storageId":"可选 cs_…"}
```

只必填 `url`，支持含提取码的完整分享文本，一次一个链接。`query/type/tmdbId/season/storageId/password` 可选。指定 `tmdbId` 时 `type` 必填；剧集默认第 1 季，若分享文件名明确标记季则采用该季；检测到多季会要求指定。多作品合集必须先选作品。网盘必须与分享品牌一致；不支持跨品牌转存及光鸭分享。

202：`{status:"queued",workflowRunId,workflowStatus:"queued",title,storageId}`。

200：`{status:"existing",workflowRunId,workflowStatus,title,storageId}`，相同输入已存在，未重新转存。

409：`{error,candidates?:[{tmdbId,type,title,year}],storages?:[{id,provider,label}],seasons?:number[],titles?:string[]}`，未入队，需要选择或补充信息。另有当前作品正在运行的冲突。

400 输入错误；403 demo 只读；404 无匹配作品；422 无法读取分享；502 上游服务失败。

## GET /api/agent/import-share/{workflowRunId}

返回 `workflowRunId,status,title,storageId,progress,obtainedEpisodes,finishedAt,reports`。不返回原始分享密码、网盘凭据或模型密钥。入队后可能经历 `queued/running`，终态为 `succeeded/partial/failed/no_coverage`。`partial` 表示仍有缺集。

## POST /api/agent/import-share/{workflowRunId}/retry

仅重试站主名下已失败的分享导入任务，沿用原链接和重命名规则。其他状态返回 409，不会创建另一个任务。

## GET /api/agent/config

返回脱敏配置和 `storages` 列表，用来选择 storageId。不要把脱敏配置写回。

电影文件为 `片名 (年份).ext`；剧集为 `片名 (年份) - S01E01.ext`。使用原有媒体目录，匹配的外挂字幕同步改名。同名冲突必须先去重，未经实际网盘回读确认不会记为成功。
