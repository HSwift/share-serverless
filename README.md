# Share Serverless

个人自托管的共享剪贴板与文件分享服务，运行在 Cloudflare。API 与 Console 分别部署为 Worker，Console 通过 Service Binding 调用 API，鉴权由 Cloudflare Access 承担。

```text
apps/api/
  src/              Hono API、剪贴板 Durable Object
  migrations/       D1 migrations
  test/             在 workerd 中运行的集成测试
apps/console/
  src/              React 两栏界面、安全预览、Worker 转发
  test/             渲染安全与 Worker 边界测试
  e2e/              真实本地 API 的浏览器验收
shared/             API 与 Console 共用的协议类型
scripts/            本地 Secrets、部署配置生成与部署
docs/               API 与客户端同步协议
```

内容条目不可变，以规范化内容的 SHA-256 为 ID；剪贴板是指向条目的可变指针。文本、HTML、图片等 MIME 表示可以属于同一条目。文件流式上传到私有 R2，D1 保存条目、文件、设备与分享元数据，SQLite Durable Object 负责剪贴板版本排序和可选 WebSocket 通知。

本地开发推荐最新的 Node.js 22.x（至少 22.22.2，含测试依赖要求）和项目指定的 pnpm：

```bash
pnpm install --frozen-lockfile
pnpm secrets:local
pnpm db:migrate:local
pnpm dev
```

打开 Console：`http://127.0.0.1:5173`；API 位于 `http://127.0.0.1:8787`，健康检查为 `/api/health`。初始化脚本写入 API 的 `.dev.vars` 和 Console 的 `.env.local`，保留已有文件。本地 Vite 代理在服务器端注入令牌；前端构建不包含令牌。设备应使用单独注册的设备令牌。

```bash
pnpm check       # 类型检查、集成测试、部署 dry-run
pnpm test:deploy # 构建变量、首次 Secrets 初始化和部署失败处理，不访问云端
pnpm cf:typegen  # 修改 Wrangler bindings 后重新生成类型
pnpm --filter @share/console exec playwright install chromium
pnpm --filter @share/console test:e2e  # 隔离的本地存储与端口，不访问云端
```

- [API 接口与调用示例](docs/API.md)
- [剪贴板同步协议与设备适配](docs/CLIPBOARD.md)
- [Console 界面与预览安全](docs/CONSOLE.md)
- [部署说明](docs/DEPLOYMENT.md)
