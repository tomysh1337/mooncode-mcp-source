# 服务器、数量设置与账号导入

## 数量设置

控制台「运行设置」可调整 MCP 活动链接数（1–1024）、每次请求子任务总数（0–256）、嵌套层数（0–16）、每任务回合（1–256）及总动作（1–10000）。0 个子任务表示只运行主任务。设置在 `--data-dir/settings.json` 中持久化，保存后用于下一次请求；运行中的任务结束后再修改。降低链接上限前应先撤销超出的链接。子任务目前串行执行。

链接数量是资源容量，不是累计生成配额。2 GB 服务器建议从 4 个活动链接、2 个子任务、1 层嵌套开始，浏览器按需启动。

## 账号格式

控制台可同时选择多个 JSON 文件，每个文件上限 8 MiB，每个导入文档最多 1000 个账号。支持 CPA 单账号、账号数组，以及 Sub2API `accounts` / `data.accounts` 导出封装。导入逐项报告成功和错误，相同提供商及账号身份会更新原记录；列表只返回名称、提供商、启停和到期时间。

CPA 示例（占位内容，替换为自己的导出文件）：

```json
{"type":"codex","email":"account@example.com","account_id":"ACCOUNT_ID","access_token":"ACCESS_TOKEN","refresh_token":"REFRESH_TOKEN","id_token":"ID_TOKEN","expired":"2027-01-01T00:00:00Z"}
```

Sub2API 示例：

```json
{"type":"sub2api-data","version":1,"proxies":[],"accounts":[{"name":"my-account","platform":"openai","type":"oauth","credentials":{"access_token":"ACCESS_TOKEN","refresh_token":"REFRESH_TOKEN","chatgpt_account_id":"ACCOUNT_ID"},"concurrency":1,"priority":1}]}
```

Sub2API 当前转换 OpenAI → CPA `codex`、Anthropic/Claude → CPA `claude` 的 OAuth / setup-token 账号。其他平台使用 CPA 原生 auth JSON。Sub2API 中引用外部代理的账号会报告错误，请先导出带实际 `proxy_url` 的 CPA 文件。原生 CPA 文件的其他提供商是否可用取决于所部署 CPA 版本、凭据有效性和提供商支持。

导入目录应与 CPA 的 `auth-dir` 指向同一个私有目录；服务写入 `mooncode-<id>.json`，Linux 权限 0600，CPA 监视目录并加载账号。通过 UI 停用会设置 CPA 的 `disabled` 字段。到期时间为账号文件的报告值，实际刷新由 CPA 处理；“已启用”仅表示参与调度，不等于已通过远程登录校验。

格式依据：[Sub2API DataAccount](https://github.com/Wei-Shaw/sub2api/blob/1a9d49e16f7a22c432b428fce4af8d731f1fa364/backend/internal/handler/admin/account_data.go)、[CPA CodexTokenStorage](https://github.com/router-for-me/CLIProxyAPI/blob/c93978c4ea2e908255a2a06c37599fda3651554a/internal/auth/codex/token.go)。

## 接入账号服务

单独安装 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI/releases)，配置监听 `127.0.0.1:8318`、私有 `auth-dir` 和随机 `api-keys`。把相同 key 通过环境变量注入 MoonCode；不要放入命令行参数、仓库或公开日志。

```bash
export MOONCODE_CPA_API_KEY='YOUR_API_KEY'
bash start-web.sh serve --workspace /path/to/project \
  --data-dir /var/lib/mooncode-hub/state \
  --provider cpa --cpa-url http://127.0.0.1:8318/v1 \
  --cpa-auth-dir /var/lib/mooncode-hub/accounts
```

打开控制台 → 导入账号 → 读取可用模型 → 选择模型并保存 → 发送任务。账号模式流式响应也接入原有 skills、MCP 和子任务调度。ChatGPT 网页模式继续使用独立浏览器 profile；导入 Codex OAuth 文件不会生成 ChatGPT 网页 cookies。网页模式的首次登录仍需可见桌面。

控制台一时间处理一个任务；设置、导入及手动链接变更会在任务运行中返回繁忙。外部 API 的并发和账号轮换由 CPA 管理，控制台的子任务总数不改变 CPA 账号额度或提供商限制。

## HTTPS 与 API Key

用 `--web-origin https://console.example.com` 指定控制台公网来源，用 `--public-origin https://console.example.com` 指定 MCP 公网来源；反向代理 `/mcp/*` 到 MCP 网关，其余路径到网页服务。默认仅监听本地，可通过 `--host`、`--mcp-host` 指定反向代理可达的专用内网地址。管理 API 始终是独立 loopback 端口。

```caddyfile
console.example.com {
    handle /mcp/* {
        reverse_proxy 127.0.0.1:48271 {
            flush_interval -1
        }
    }
    handle {
        reverse_proxy 127.0.0.1:48400 {
            flush_interval -1
        }
    }
}
```

外部 API Base URL 为 `https://console.example.com/v1`，支持 `GET /v1/models`、`POST /v1/chat/completions` 和 `POST /v1/responses`。API Key 为 CPA 配置中的 key，以 `Authorization: Bearer YOUR_API_KEY` 发送；API 与控制台访问密钥彼此独立。

```bash
curl https://console.example.com/v1/models \
  -H "Authorization: Bearer $MOONCODE_CPA_API_KEY"
```

外部 `/v1` 接口直接转发模型请求；项目 skills 和 MCP 自动编排在控制台任务入口运行。API 输出可以流式返回。没有有效账号时模型列表为空、推理请求返回账号服务错误，导入有效账号后再进行真实模型调用验收。

## 持久化与运维

建议使用单独的非 root 系统用户运行 MoonCode 和 CPA，账号和状态目录权限 0700。通过 systemd 的 `EnvironmentFile` 注入 API key。`--access-file /private/access.json` 把控制台专用链接写到 0600 文件，同时避免在服务日志打印访问密钥。状态目录保留时，服务重启后控制台访问密钥及数量设置不变；MCP 链接则需要重新创建。

保留旧版本目录以便切换回滚；更新服务前先结束正在执行的任务。Linux 浏览器工具需要 Chromium 系统共享库，桌面工具另需 Xvfb、xdotool、ImageMagick。虚拟桌面不是宿主机当前登录桌面。工作区保持只读，除非启动时显式添加 `--allow-write`；命令执行再添加 `--allow-exec`。
