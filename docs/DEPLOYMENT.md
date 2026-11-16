# 部署 API 与 Console

同一 Git 仓库关联两个 Workers Builds：先部署 API，再部署 Console。Console 使用 Service Binding 调用 API。配置区分为构建环境、运行时变量、运行时 Secrets 和资源绑定；不需要把运行时变量再填写到 Build Variables。

## 配置归属

| 配置项 | 归属 | 配置位置 |
| --- | --- | --- |
| `NODE_VERSION=22` | Builder | 两个 Worker 的 Settings → Builds → Variables and secrets |
| `PNPM_VERSION=12.19.0` | Builder | 同上；与根目录 `packageManager` 保持一致 |
| `CLOUDFLARE_API_TOKEN` | Builder 部署凭据 | Workers Builds 选择的 API token；手工 CI 才需要自行注入该环境变量 |
| `CLOUDFLARE_ACCOUNT_ID` | Builder 目标账户 | 必要时配置到构建环境，Worker 代码不读取 |
| `PUBLIC_BASE_URL` | API Runtime 普通变量 | 部署时从 API 绑定域名自动生成；多个域名时在 API Runtime 选择 |
| `MAX_UPLOAD_BYTES` | API Runtime 普通变量 | `apps/api/wrangler.jsonc` → `vars`，默认 `104857600`，即 100 MiB |
| `ACCESS_TEAM_DOMAIN` | API Runtime 普通变量 | API Worker → Settings → Variables and Secrets，类型 Text |
| `ACCESS_AUD` | API Runtime 普通变量 | 同上 |
| `API_BEARER_TOKEN` | API Runtime Secret | API Worker → Settings → Variables and Secrets，类型 Secret |
| `SHARE_SIGNING_KEY` | API Runtime Secret | 同上 |
| `DB`、`FILES`、`CLIPBOARD` | Runtime 资源绑定 | `apps/api/wrangler.jsonc` 的 D1、R2、Durable Object 配置 |
| `API`、`ASSETS` | Console Runtime 资源绑定 | `apps/console/wrangler.jsonc` 的 Service Binding 和 Static Assets |

`PUBLIC_BASE_URL`、Access 标识和上传限制属于运行时配置，不从构建进程的同名环境变量读取。生成脚本省略仓库里的占位 URL 和空 Access 值；部署脚本从 Cloudflare API 读取 API Worker 绑定的域名，自动生成分享地址，并通过 `keep_vars` 保留 Dashboard 中的其他线上变量。域名只写入临时配置和 Runtime，避免在开源仓库写入部署标识。D1 / R2 的名称也是资源声明，不是环境变量。没有必填的 `D1_DATABASE_ID` 或 `R2_BUCKET_NAME` Build Variable。

若在 Wrangler 的 `vars` 中填写真实值，它会覆盖 Dashboard 同名普通变量；默认声明的 `MAX_UPLOAD_BYTES` 也遵循该规则。模板的 `PUBLIC_BASE_URL=https://api.invalid` 和空 Access 值不会进入生产配置。密钥不写入 `vars` 或仓库。Secrets 会在普通部署中保留。[Wrangler 配置来源规则](https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth)

## 两个 Workers Builds

在 Cloudflare **Workers & Pages → Create application → Import a repository** 中，分别关联同一仓库：

| 设置 | API | Console |
| --- | --- | --- |
| Worker 名称 | `share-serverless-api` | `share-serverless-console` |
| Production branch | `main`，或实际生产分支 | 与 API 相同 |
| Root directory | 留空，使用仓库根目录 | `apps/console` |
| Build command | `pnpm cf:render && pnpm --filter @share/api typecheck` | `pnpm build` |
| Deploy command | `pnpm cf:deploy` | `pnpm exec wrangler deploy --env=""` |
| Build variable `NODE_VERSION` | `22` | `22` |
| Build variable `PNPM_VERSION` | `12.19.0` | `12.19.0` |

使用最新的 Node 22.x。Wrangler / Vite 构建至少需要 22.12，完整运行本仓库测试至少需要 22.22.2。Cloudflare 自动安装依赖，Build command 无需重复安装。[构建镜像](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)

Build Token 用于构建容器部署资源，本服务运行时不需要 Cloudflare API Token。API 的令牌需要 Worker 部署、D1 写入和 R2 管理权限。可先使用 Cloudflare 生成的 Build Token；权限不足时在 **Settings → Builds → API token** 选择补齐权限的令牌。[Workers Builds 设置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)

先关闭非生产分支自动构建；当前生产配置只有一套资源，线上预览需要独立配置。Console 的 `--env=""` 使用顶层生产配置，`env.e2e` 仅供本地测试。

## 资源在 Wrangler 声明并自动创建

资源名已经写在 `apps/api/wrangler.jsonc`，无需先执行手工创建命令：

| 声明 | 资源 / 绑定 | 部署行为 |
| --- | --- | --- |
| `d1_databases` | `share-serverless` / `DB` | 按声明的名称查找；不存在时由部署脚本创建，随后迁移 |
| `r2_buckets` | `share-serverless-files` / `FILES` | Wrangler 部署时检查并自动创建 |
| `durable_objects` + `migrations` | `ClipboardHub` / `CLIPBOARD` | 首次部署自动创建 SQLite DO namespace |
| `triggers.crons` | `43 3 * * *` | API 部署时配置每日 UTC Cron |

当前 Wrangler 支持 D1 / R2 自动 provisioning。由于本项目要在新代码上线前执行 D1 migrations，部署脚本提前根据声明创建 D1；R2 直接交给 `wrangler deploy` 自动处理。[自动创建资源](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)

部署脚本只把查到或新建的 D1 ID 写入临时 `wrangler.generated.jsonc`，不修改仓库配置，也不需要从 Build Variables 传入 ID。以后构建继续按名称复用同一数据库。若要绑定特定的已有数据库，也可以直接在 D1 声明中填写真实 `database_id`。

R2 保持私有，无需公开 bucket 或配置 S3 凭据，账户中需要启用 R2。若更名，直接修改 Wrangler 声明。Console 的 `API` Service Binding 和 `./dist` 静态资源目录也已声明，无需在 Dashboard 重复添加或另填 Build output directory。

## 填写 API Runtime 普通变量

在 API Worker 的 **Settings → Variables and Secrets** 中添加以下两个 **Text** 变量：

```json
{
  "ACCESS_TEAM_DOMAIN": "https://your-team.cloudflareaccess.com",
  "ACCESS_AUD": "your-console-application-aud"
}
```

上传限制在 `apps/api/wrangler.jsonc` 的 `vars.MAX_UPLOAD_BYTES` 中设置，默认 `104857600`。这些都无需添加到 Build Variables。如果愿意公开部署标识，也可以在 Wrangler 的 `vars` 中填写真实 URL 和 Access 值；它们会覆盖 Dashboard 的同名值。

分享链接使用的 `PUBLIC_BASE_URL` 自动适配 API Worker 的 Custom Domain；首次尚未绑定域名时使用 `workers.dev` 地址。绑定或更换域名后重新部署即可更新，无需把域名写入 Git。多个 API Custom Domain 时，在 Runtime 的 `PUBLIC_BASE_URL` 中指定其中一个；只有一个域名时优先使用该域名。通过普通 Worker Route 发布的 API 可以在 Runtime 保留明确的地址。Wrangler 中显式填写的 `PUBLIC_BASE_URL` 优先级最高，必须是 API 的公开 HTTPS origin，不能填 Console 地址或带路径。

自动发现使用 Builder 已有的 Wrangler 部署凭据访问 Cloudflare 管理 API，不向 Worker 注入 Cloudflare API Token。Console 经 Service Binding 转发时保留 Console 请求 URL，因此公开分享使用部署时确定的 API 地址，不依赖浏览器请求的 Host。

Access 两项可以先同时不设置，此时仅支持 Bearer / 设备认证；启用 Console 前一起填写真实值。

本地 `pnpm dev` 用 CLI 覆盖 `PUBLIC_BASE_URL` 为本地 API 地址，不修改生产 `vars`。D1 的 `preview_database_id` 仅保留已有本地存储的标识，生成生产配置时移除，不是需要填写的生产 ID。

## API Runtime Secrets 与首次初始化

长期保留的 Secrets 只有两项：

| Runtime Secret | 用途 |
| --- | --- |
| `API_BEARER_TOKEN` | 管理员 API 令牌，建议随机 32 字节 |
| `SHARE_SIGNING_KEY` | 分享链接 HMAC，必须是 base64 编码的 32 字节密钥 |

可以直接在 API Worker 的 **Settings → Variables and Secrets** 创建，或交互式执行：

```bash
pnpm --filter @share/api exec wrangler secret put API_BEARER_TOKEN
pnpm --filter @share/api exec wrangler secret put SHARE_SIGNING_KEY
```

如果首次 Git Build 时 Worker 还没有 Runtime Secrets，在 **Builds → Variables and secrets** 添加以下两项 **Secret**，分别传入 `openssl rand -base64 32` 生成的两个值：

| 仅首次使用的 Builder Secret | 创建的 Runtime Secret |
| --- | --- |
| `RUNTIME_API_BEARER_TOKEN` | `API_BEARER_TOKEN` |
| `RUNTIME_SHARE_SIGNING_KEY` | `SHARE_SIGNING_KEY` |

`RUNTIME_*` 是初始化时的传输入口，不是 Worker 的运行时变量名。两项必须同时提供。生成脚本写入独立的 `0600` 临时 Secrets 文件，部署时通过 `--secrets-file` 设置真正的 Runtime Secrets，日志和 Wrangler 配置不包含密钥值。

首次成功后，删除 **Builds** 中的两项 `RUNTIME_*`，保留 **Worker Settings → Variables and Secrets** 中的两项 Runtime Secrets，重新构建确认。普通部署不再从构建环境获取密钥，也不会覆盖已有 Secrets；`secrets.required` 检查它们是否存在。[Secrets 随代码部署](https://developers.cloudflare.com/workers/configuration/secrets/#upload-secrets-alongside-code)

后续轮换直接修改 Runtime Secrets。更换 `SHARE_SIGNING_KEY` 会使所有旧分享 URL 失效；撤销某台设备使用设备撤销接口。

## Console 域名与 Access

建议两个入口：

- `https://share.example.com`：Console，通过 Access 登录。
- `https://share-api.example.com`：API，供设备和公开分享访问。

也可以先使用对应的 `workers.dev` 地址。在 **Zero Trust → Access → Applications** 创建 **Self-hosted** 应用，保护整个 Console 域名，Allow 策略填写自己的邮箱。把该应用的 Team Domain 和 **Application Audience (AUD) Tag** 配置为 API Worker 的 Runtime Text 变量，部署设置后生效。

使用按域名保护的 Access。Cloudflare 当前的 Worker 级 Access 不支持 WebSocket，升级请求返回 403，因此 Console 不使用 “Protect this Worker behind Access”。保留的 Console `workers.dev` 地址和其他入口也加入同一个域名应用。[官方限制](https://developers.cloudflare.com/workers/configuration/cloudflare-access/#protect-one-worker)

API 域名保持可达，避免 Access 登录拦截 `/s/*` 分享接收者和设备客户端。私有 `/api/v1/*` 仍由 API 校验签名 Access JWT 或 Bearer / 设备令牌。如果账户开启了 Protect all Workers，为 API 配置公开例外，并确认 Console 的域名应用优先生效。

Console 不需要 Runtime Secrets、D1、R2 或管理员令牌。它保留请求中的 Access JWT，通过 Service Binding 转发给 API 验证。生产环境不使用本地 `.dev.vars`、`.env.local` 或 `LOCAL_API_BEARER_TOKEN`。

## 实际部署顺序与验证

1. 确认 Wrangler 中的资源声明；在 API Worker 的 Runtime 设置中填写 Access 值。首次 Worker 尚不存在时可在首次部署成功后填写。自定义域名在 Dashboard 绑定后重新部署，分享地址自动识别。
2. 配置 API Builds 的工具版本、部署权限，以及需要时的首次初始化 Secrets。
3. API Build 生成临时配置并执行类型检查。
4. API Deploy 解析 / 创建 D1 → 自动确定 API 的公开域名 → 执行远程 migrations → 部署 API，由 Wrangler 创建 R2 / DO、配置 Cron。
5. 部署脚本成功或失败后清理临时配置与 Secrets 文件。类型检查失败时部署脚本尚未执行，临时文件随构建容器销毁。
6. 首次成功后删除 `RUNTIME_*` Build Secrets，再构建确认。
7. 部署 Console，绑定域名，验证 Access 登录。

上线后检查：API `/api/health` 成功、未认证 `/api/v1/items` 返回 401；Console 登录后能读取条目；WebSocket `/api/v1/clipboards/default/events` 升级成功；上传、下载、公开分享、分享撤销和设备撤销正常。

本地 `pnpm check` 包括类型检查、集成测试和部署 dry-run，不修改云端资源。`pnpm test:deploy` 用临时目录与模拟命令验证变量边界、资源创建 / 复用、迁移顺序和失败清理，不运行真实 Wrangler。
