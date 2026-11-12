# API

私有 API 前缀为 `/api/v1`。除 `/api/health` 和 `/s/*` 之外，所有接口要求 `Authorization: Bearer <token>`，或验证通过的 Cloudflare Access JWT。

管理员令牌存放在运行时 Secret `API_BEARER_TOKEN`。管理员可注册设备，获得一次性返回的 `dev_...` 设备令牌；D1 仅存设备令牌哈希。设备令牌可使用全部内容、文件、分享和同步接口，但不能管理设备。`capabilities` 是客户端能力声明，不是授权范围。

Console 通过 Service Binding 转发原始 Request，由 API 再校验 `Cf-Access-Jwt-Assertion` 的签名、issuer、audience 与有效期。只保护 Console 域名；不要把公开分享路径放在要求登录的 Access 应用后面。

## 接口

| 方法   | 路径                                            | 行为                                     |
| ------ | ----------------------------------------------- | ---------------------------------------- |
| GET    | `/api/health`                                   | 公开健康检查                             |
| GET    | `/api/v1/me`                                    | 当前认证方式与设备身份                   |
| POST   | `/api/v1/devices`                               | 管理员注册设备，返回设备令牌             |
| GET    | `/api/v1/devices`                               | 管理员列出设备，最多 200 条              |
| DELETE | `/api/v1/devices/:id`                           | 管理员撤销设备，并关闭它的现有 WebSocket |
| POST   | `/api/v1/files?name=...&size=...`               | 原始二进制流上传；返回不可变文件 ID      |
| GET    | `/api/v1/files`                                 | 文件列表                                 |
| GET    | `/api/v1/files/:id`                             | 文件元数据                               |
| GET    | `/api/v1/files/:id/content`                     | 附件下载，支持单个 HTTP Range            |
| DELETE | `/api/v1/files/:id`                             | 删除文件，立即阻止后续下载               |
| POST   | `/api/v1/items`                                 | 创建或复用不可变内容条目                 |
| GET    | `/api/v1/items`                                 | 条目摘要列表                             |
| GET    | `/api/v1/items/:id`                             | 固定条目的完整内容和 MIME 表示           |
| GET    | `/api/v1/items/:id/content?mimeType=text/plain` | 读取该条目指定格式的原始数据             |
| GET    | `/api/v1/clipboards/:channel`                   | 当前指针，支持 ETag / If-None-Match      |
| PUT    | `/api/v1/clipboards/:channel`                   | 把指针设为指定条目，或设为 null          |
| POST   | `/api/v1/clipboards/:channel`                   | 一次请求创建内容条目并更新指针           |
| GET    | `/api/v1/clipboards/:channel/text`              | 读取当前条目的纯文本；空指针返回 204     |
| GET    | `/api/v1/clipboards/:channel/history`           | 最近 200 次指针变更中的历史              |
| GET    | `/api/v1/clipboards/:channel/changes?after=0`   | 按版本升序补取变更                       |
| GET    | `/api/v1/clipboards/:channel/events?after=0`    | 可选 WebSocket 升级，订阅指针变更        |
| POST   | `/api/v1/shares`                                | 为固定条目创建分享链接                   |
| GET    | `/api/v1/shares`                                | 分享列表，包括可以再次复制的 URL         |
| DELETE | `/api/v1/shares/:id`                            | 撤销分享                                 |
| GET    | `/s/:token`                                     | 公开读取分享快照与该分享的文件下载地址   |
| GET    | `/s/:token/text`                                | 公开读取分享快照的纯文本                 |
| GET    | `/s/:token/files/:id`                           | 只能下载该分享包含的文件                 |

文件、条目、分享列表支持 `limit=1..100` 和响应返回的 `nextCursor`，后续请求以 `cursor` 传入。历史接口使用 `limit=1..100` 和 `before=<revision>`；变更接口使用 `limit=1..200`，`hasMore=true` 时从本页最后一个 revision 继续。

`GET /api/v1/items` 还支持 `q`（最多 200 字符，按字面量匹配文本和附件文件名）、`type=all|text|image|files`、`sort=newest|oldest`、`since=<ISO 时间>`。筛选可组合，翻页时应保留同一组参数。图片条目也属于文件筛选；含文本和附件的条目可同时匹配对应筛选。返回 `total` 是全部匹配数量；条目包含 `title`、`preview`、`kind`、`size`、`fileDetails` 供列表展示。删除的文件描述为 `available:false`，不改变条目 ID。`GET /api/v1/items/:id` 返回 `{ item, files }`。

`GET /api/v1/config` 需要认证，返回 Console 使用的 `maxUploadBytes`、`maxInlineBytes` 和 `maxFiles`。查询目前使用 D1 JSON/字符串扫描，适合个人库；数据量增大后可迁移为专用全文索引。

## 内容结构

最简单的输入是 `{"text":"hello"}`，服务端将它规范化为：

```json
{
	"representations": [{ "mimeType": "text/plain", "text": "hello" }],
	"files": []
}
```

更丰富的内容可以同时包含不同格式和附件：

```json
{
	"representations": [
		{ "mimeType": "text/plain", "text": "hello" },
		{ "mimeType": "text/html", "text": "<b>hello</b>" },
		{ "mimeType": "image/png", "fileId": "上传返回的 UUID" }
	],
	"files": ["上传返回的 UUID"]
}
```

每种 MIME 只能出现一次，每个表示必须在 `text` 和 `fileId` 中二选一。最多 16 种表示、20 个附件，规范化后的行内内容最多 64 KiB；较大内容通过文件引用传递。MIME 表示顺序会被规范化，附件顺序保留。空字符串是有效内容，空剪贴板使用指针 `itemId: null` 表示。

条目 ID 是规范化 JSON 的 SHA-256，采用 base64url 编码。重复创建相同内容返回同一条目；没有修改条目或覆盖文件的接口。二进制表示中的 `fileId` 与附件列表均引用预先完成上传的不可变文件。

## 上传与分享

以下示例中的 `API_BEARER_TOKEN` 来自你自己的本地或生产配置：

```bash
curl -X POST 'http://localhost:8787/api/v1/files?name=photo.png' \
  -H "Authorization: Bearer $API_BEARER_TOKEN" \
  -H 'Content-Type: image/png' \
  --data-binary @photo.png
```

`size` 和 `Content-Length` 至少提供一个；两者同时提供时必须一致。未知长度的流可用 `size` 声明总字节数。默认上限为 100 MiB，由 `MAX_UPLOAD_BYTES` 配置，并受 Cloudflare 账户的请求体限制约束。服务端使用固定长度流校验实际长度，不把整个文件读进内存。

任意文件类型都可以上传，服务端不进行转码或格式嗅探。下载始终使用附件响应，并禁用内容嗅探。文件先记为 pending，R2 完成后才发布；每日任务清理超过 24 小时的未完成上传，并重试删除文件。

创建分享时三种来源选一种：

```json
{ "itemId": "不可变条目 ID", "expiresIn": 604800 }
```

```json
{ "content": { "text": "要分享的文字" }, "expiresIn": 3600 }
```

```json
{ "clipboard": { "channel": "default", "revision": 12 }, "expiresIn": 604800 }
```

`clipboard.revision` 可省略，表示取创建分享时的当前指针。分享固定引用当时的条目，不跟随后续指针移动。默认 7 天有效，可设为 60 秒到 30 天；`expiresIn: null` 表示长期有效，仍可撤销。

返回的 `share.url` 是携带 HMAC 签名的公开地址。知道地址的人可以读取该条目及其包含的文件，不能下载其他文件。目前该地址返回 JSON；Console 可创建和撤销分享，公开分享展示页尚未实现。删除文件会使引用它的条目或分享中的文件下载失效，但不会重写条目内容。

## 剪贴板写入

两步写入适合复用已有内容：

```http
POST /api/v1/items
Authorization: Bearer <device-token>
Content-Type: application/json

{"content":{"text":"hello"}}
```

```http
PUT /api/v1/clipboards/default
Authorization: Bearer <device-token>
Content-Type: application/json

{"itemId":"返回的条目 ID","mutationId":"客户端生成的唯一 UUID","baseRevision":0}
```

受限客户端也可一次请求创建并设为当前内容：

```http
POST /api/v1/clipboards/default
Authorization: Bearer <device-token>
Content-Type: application/json

{"content":{"text":"hello from iOS"},"mutationId":"客户端生成的唯一 UUID"}
```

响应：

```json
{
	"state": {
		"channel": "default",
		"revision": 1,
		"itemId": "条目 ID",
		"sourceDeviceId": "设备 UUID",
		"updatedAt": "2026-11-12T00:00:00.000Z",
		"mutationId": "客户端生成的唯一 UUID"
	},
	"changed": true,
	"replayed": false
}
```

`baseRevision` 提供时执行 compare-and-set，冲突返回 409 和 `error.details.current`。省略时按服务端提交顺序更新指针。每次新的写入意图使用新的 `mutationId`，超时重试保持同一 ID 和相同请求参数。

相同当前条目是 no-op，不增加版本。清空指针使用 `PUT` 和 `itemId: null`，它也产生单调递增的版本，不删除旧条目。单次创建并更新时，即使指针因版本冲突未改变，已创建的不可变条目仍会保留。

## 错误与边界

错误格式为 `{"error":{"code":"...","message":"...","details":{}}}`。HTTP 层还返回 `X-Request-Id`。

| 状态      | 常见 code                           | 处理方式                                         |
| --------- | ----------------------------------- | ------------------------------------------------ |
| 400       | `INVALID_INPUT`, `INVALID_CONTENT`  | 修正参数                                         |
| 401 / 403 | `UNAUTHORIZED`, `FORBIDDEN`         | 检查凭证与管理员权限                             |
| 406       | `FORMAT_UNAVAILABLE`                | 选择条目实际具备的 MIME 类型                     |
| 409       | `REVISION_CONFLICT`                 | 拉取当前指针，保留本地待同步项并决定冲突处理     |
| 409       | `MUTATION_REUSED`                   | 不要把同一幂等键用于不同请求                     |
| 409       | `CURSOR_EXPIRED`, `CURSOR_AHEAD`    | 重新读取当前状态                                 |
| 410       | `MUTATION_EXPIRED`                  | 原请求已执行但结果超出历史窗口，重新读取当前状态 |
| 410       | `SHARE_EXPIRED`, `FILE_UNAVAILABLE` | 分享或文件已不可用                               |
| 411 / 413 | `SIZE_REQUIRED`, `FILE_TOO_LARGE`   | 提供长度或减小上传                               |
| 400       | `UPLOAD_INCOMPLETE`                 | 上传中断或实际字节数与声明不符，重新上传         |
| 416       | `INVALID_RANGE`                     | 调整下载范围                                     |

幂等键按设备和 channel 隔离，保留至少 7 天；结果仅在最近 200 个版本仍存在时可重放。文件和条目不会随着 200 条指针历史的裁剪而自动删除。当前不包含端到端加密、客户端 daemon 或 iOS 快捷指令成品。
