# Profile 用量与余额查询

用量查询设置保存在各自 profile 中。在详情页启用查询后，可手动刷新。官方 ChatGPT 账号使用该 profile 的 `auth.json` 登录令牌查询 Codex 使用窗口；第三方/API profile 可配置查询 URL、GET/POST、请求头、POST 请求体和响应 JSON 字段路径。

请求头和请求体支持 `{{apiKey}}`、`{{credential}}`、`{{baseUrl}}` 占位符。`apiKey` / `credential` 默认使用该 profile 保存的 provider API Key；也可在“查询凭据”中输入独立 token。独立 token 和 API Key 一样保存在本地加密存储中，URL、请求头模板和 JSON 路径保存在 profile 配置中。避免直接把 token 写入请求头模板。

JSON 路径使用点号，例如 `data.balance`、`quota.remaining`。填入余额、总额、已用值中的至少一个路径。查询只发送一次只读 HTTP 请求，超时为 15 秒；目前不会后台自动轮询。结果只显示在对应 profile 详情页。

## Codex 账号订阅

账号登录 profile 使用 `https://chatgpt.com/backend-api/wham/usage`，读取该 profile 自己的 access token 和 account ID，并显示主、次用量窗口及重置时间。此 Codex 使用接口不是公开稳定的计费 API；接口或响应字段变化时，查询可能失败，需要更新适配。令牌缺失或过期时，请在对应 profile 的 Codex 窗口重新登录。

## 第三方渠道

不同渠道返回格式各异，因此没有假设其通用余额端点。请从服务商文档获取查询地址和响应结构，例如：

```text
URL: https://provider.example/api/user/self
Method: GET
Headers: {"Authorization":"Bearer {{apiKey}}"}
Remaining path: data.balance
Total path: data.total
Used path: data.used
Unit: USD
```

检查服务商条款和权限，使用只读的余额/用量接口；查询接口可能计入服务商请求频率。
