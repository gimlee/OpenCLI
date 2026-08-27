# TikTok Shop Seller 草稿

`tk-seller` 从本机商品管道读取已经同步 UnoPIM 的商品，并填写 TikTok Shop Seller Center 商品创建页。

```bash
OPENCLI_BROWSER_COMMAND_TIMEOUT=180 opencli tk-seller draft 999376601750 --region MY --accept-auto-translation true --save false
OPENCLI_BROWSER_COMMAND_TIMEOUT=180 opencli tk-seller draft 999376601750 --region MY --accept-auto-translation true --save true
```

- `--region`：店铺地区，当前验证目标为 `MY`，页面结构一致时可传 `TH` 等地区。
- `--accept-auto-translation true`：显式接受 TikTok Shop 自动翻译提示；需要翻译但未传时，命令会停止。
- `--save false`：只填写并停留在页面，默认值。
- `--save true`：点击“保存草稿”，仍不会发布。
- `--pim-url`：本机商品管道地址，默认 `http://127.0.0.1:8020`。
- `--pim-token`：本机回写令牌；也可设置 `PIM_OPENCLI_TOKEN`。

命令需要 OpenCLI 的持久 TikTok Seller 浏览器会话已登录。商品语言按 UnoPIM 的最新内容选择；没有当地语言时选择真实源语言，并校验 TikTok 已完成当地语言标题和详情翻译。命令不会把中文内容伪装成英语内容，也不调用 Agent 或 LLM。

商品管道会在上架前补齐能够可靠确定的 UnoPIM 上架属性与分类；无法可靠判断时停止并报告缺失项。图片和视频上传通常超过一分钟，建议将 `OPENCLI_BROWSER_COMMAND_TIMEOUT` 设为 `180` 秒。

执行前运行 `opencli doctor`，确认 Daemon 与 Chrome Browser Bridge 均已连接。
