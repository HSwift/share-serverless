# Console

React + Vite 的独立 Cloudflare Worker，通过 Service Binding 访问 API。桌面为左侧条目列表、右侧内容预览；窄屏在列表与详情间切换。界面采用 Geist 字体、橙色 `#f6821f` 与中性色。

## 使用

新建弹窗中的 `curl` 标签直接展示发送文本和文件的单行命令，不提供复制按钮，不依赖 jq。打开标签时才向 API 读取当前域名与系统 API token，实际 token 直接渲染在 `Authorization` 参数中，不进入静态构建或浏览器持久存储。API 域名沿用部署流程的自动发现结果。修改示例文本或文件名和路径后运行，一次请求即可更新 `default` 剪贴板。文件上传成功后才创建条目并移动当前指针。

`pnpm dev` 同时启动 API 与 Console，打开 `http://127.0.0.1:5173`。可按 `/` 聚焦搜索；点击添加、在非输入区域粘贴内容或拖入文件，会打开较大的新建弹窗，确认保存后才上传。桌面弹窗最大 920 × 760px，输入区随弹窗伸展，手机上适配可用屏幕。新条目会设为 `default` 云剪贴板的当前条目；历史条目可在更多菜单中重新设为当前。复制到系统剪贴板始终需要用户点击。

刷新按钮位于搜索框旁。主界面保留搜索、条目和预览；类型、时间与排序收在搜索框旁的筛选菜单，源码、详情与语言设置收在条目的更多菜单。列表支持文本/文件名搜索和分页，筛选由 API 执行。移动端先准备好内容与渲染器再进入预览，慢请求在条目旁显示加载标记；最近打开的结果短时缓存，避免返回重开时重复清空画面。WebSocket 只接收剪贴板元数据通知，断线重连并辅以窗口聚焦/30 秒刷新；浏览器不会自动读取或覆盖系统剪贴板。上传支持任意文件类型，单文件上限由 API 返回。

预览包括纯文本、Markdown、只读 CodeMirror、常见光栅图片、受支持音视频，以及清洗后的 HTML。代码语言按 MIME/扩展名推断，也可手动切换。CodeMirror 与语法模块按需加载。文本文件最多预览前 256 KB，图片超过 20 MB 提示下载；不支持的格式保留下载入口。

分享窗口可设置有效期、复制新链接并撤销；目前公开地址返回条目 JSON，不含公开展示页面。Console 不包含设备令牌管理或历史分享管理页面。

## 预览边界

- React 将纯文本和代码作为文本节点处理，CodeMirror 禁用编辑。
- Markdown 使用 `react-markdown` + GFM，`skipHtml` 禁用原始 HTML。链接仅允许明确的 HTTP、HTTPS、mailto 和页内锚点，外链使用 `noopener noreferrer`；图片仅允许明确 HTTP(S) 地址，并需点击后加载，禁用 data/blob/相对地址。
- HTML 经 DOMPurify 的 HTML profile 清洗，进一步去除脚本、样式、嵌套页面、表单、SVG/MathML、资源 URL、事件属性与 DOM 命名属性，放入无权限的 `sandbox=""` iframe。iframe 内 CSP 禁止脚本、网络资源和表单提交，仅允许内置样式。
- 用户 SVG 显示源码，PDF 和其他活动文档提供下载，不直接嵌入页面。文件响应保留 `attachment`、`nosniff` 和隔离 CSP。
- Console Worker 为页面添加 CSP，脚本限同源，不允许对象嵌入或被其他页面 framing。所有字体本地打包；本地代理令牌不进入 JS、HTML 或构建变量。

这些措施需要与依赖更新和实际浏览器回归一起维护；上传文件本身仍可能是不可信内容，下载后由打开它的应用处理。

## 验证

```bash
pnpm check
pnpm --filter @share/console exec playwright install chromium
pnpm --filter @share/console test:e2e
```

浏览器测试使用 `15173` / `18787` / `18788` 端口、独立 `.wrangler/e2e` 本地存储和 `-e2e` Worker 名称，避免与正在运行的预览服务串用绑定。覆盖新建、搜索、筛选、复制、上传下载、分享撤销、320/390px 窄屏、HTML/Markdown XSS 样例，以及生产静态资源的 CSP / Service Binding / WebSocket。普通 API 开发仍使用 `8787` 端口和原来的本地存储。
