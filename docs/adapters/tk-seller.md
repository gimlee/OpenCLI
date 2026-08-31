# TikTok Shop Seller 草稿

`tk-seller` 从本机商品管道读取已经同步 UnoPIM 的商品，并填写 TikTok Shop Seller Center 商品创建页。

```bash
opencli tk-seller draft 999376601750 --region MY --accept-auto-translation true --save false --login-wait-seconds 600
opencli tk-seller draft 999376601750 --region MY --accept-auto-translation true --save true
```

- `--region`：店铺地区，当前验证目标为 `MY`，页面结构一致时可传 `TH` 等地区。
- `--accept-auto-translation true`：显式接受 TikTok Shop 自动翻译提示；需要翻译但未传时，命令会停止。
- `--save false`：只填写并停留在页面，默认值。
- `--save true`：点击“保存草稿”，仍不会发布。
- `--pim-url`：本机商品管道地址，默认 `http://127.0.0.1:8020`。
- `--pim-token`：本机回写令牌；也可设置 `PIM_OPENCLI_TOKEN`。
- `--login-wait-seconds`：登录或安全验证时暂停等待人工处理，默认 600 秒；登录状态会持久化。
- `--browser-executable-path`：普通 Chrome 可执行文件，默认系统 Chrome。
- `--user-data-dir`：TikTok 专用持久化配置，默认 `D:\tk-seller-playwright-profile`。
- `--artifacts-dir`：Playwright Trace 和失败截图目录。

命令先以普通参数启动专用持久化 Chrome，再由 Playwright 通过本机 CDP 连接控制，避免直接启动自动化浏览器反复触发风控；不依赖 OpenCLI Daemon、浏览器扩展、Agent 或 LLM。商品语言按 UnoPIM 的最新内容选择；没有当地语言时选择真实源语言，并校验 TikTok 已完成当地语言标题和详情翻译。

商品图片按 UnoPIM 主图、图库的顺序上传；TikTok 最多接收 9 张时取前 9 张，并逐个确认页面中的图片槽位。

商品管道会在上架前补齐能够可靠确定的 UnoPIM 上架属性与分类；无法可靠判断时停止并报告缺失项。每次运行会生成可回放的 Playwright Trace，失败时同时生成全页截图。

所有关键页面操作共用同一个 `PopupManager`：验证码和登录验证会在可见 Chrome 中等待人工完成；已识别的新手指引、公告和活动提示只会点击白名单关闭按钮；协议、授权及未知弹窗等待人工处理；“发布”“提交”“删除”等危险按钮始终禁止点击。弹窗处理结果会回写到本机商品管道的上架记录。被弹窗拦截的 Playwright 操作会在弹窗处理后自动重试。

正确类目被店铺主营类目限制禁用时，命令会停止，不会改选无关类目。

专用 Chrome 配置不能同时被另一个 Chrome/Playwright 进程占用。
