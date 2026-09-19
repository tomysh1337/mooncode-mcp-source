# 正义开源付费项目

MoonCode MCP Bridge 源码与 Linux 运行工具。新增链接管理、无头浏览器、Linux 虚拟桌面、项目 skills 扫描、subagent 字段调度和 ChatGPT 网页适配器。

v0.3.0 增加网页数量设置、Sub2API / CPA 账号 JSON 导入、账号启停和通过 CPA 提供的 OpenAI 兼容 API。详见[服务器与账号配置](docs/server.md)。配置与账号凭据保存在运行目录，不随源码分发。

**Linux 使用与验收：[完整教程](docs/linux.md)。** Linux 入口是 `hub/cli.mjs`，网页代理入口是 `hub/web.mjs`；运行包通过 GitHub Actions 构建，源码仓库不包含二进制产物或 Source Map。

Linux Hub 支持持续创建/撤销链接，默认 16 个并发链接，取消了自动 Cloudflare 流程，可接自己的 HTTPS 反向代理。下面的原始 Bridge 教程保留了原 runtime 的隧道参数，和新增 Hub 是不同入口。

## 目录结构

| 目录 | 作用 |
| --- | --- |
| `contracts` | MCP 工具定义、参数类型、运行时公共协议 |
| `tool-gateway` | 工作区文件、补丁、搜索和 PTY 命令实现 |
| `runtime` | MCP stdio、HTTP Bridge、认证、会话、隧道与 CLI |
| `extension` | VS Code/MoonCode 扩展侧 Bridge 控制与 IDE 适配器 |
| `event-store` | JSONL 事件存储 |
| `model-fake` | 测试模型适配器 |
| `model-openai` | OpenAI 模型适配器 |

## 环境要求

- Node.js 20 或更高版本
- pnpm 10 或更高版本
- Windows、macOS 或 Linux
- 使用命令执行工具时，需要可用的本地 PTY 环境

## 安装与构建

```powershell
git clone https://github.com/tomysh1337/mooncode-mcp-source.git
cd mooncode-mcp-source
pnpm install
pnpm build
```

构建结果分别位于各包的 `dist` 目录，扩展构建结果位于 `extension/out`。若只想重新构建，可运行 `pnpm build`；清理 TypeScript 构建缓存可运行 `pnpm clean`。

## 本地只读 Bridge

先生成一个 32 字节 base64url 密钥：

```powershell
$secret = node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
$secret
```

启动仅监听本机、关闭公网隧道、只允许读取当前工作区的 Bridge：

```powershell
pnpm start -- --workspace D:\PROJECT --port 48271 --secret $secret --no-tunnel --auth-mode capability_url --access-scope workspace
```

服务就绪后会输出一行 `bridge.ready` JSON。本地 MCP 地址为：

```text
http://127.0.0.1:48271/mcp/<secret>
```

密钥本身就是 capability 凭据，不要提交到 Git 或粘贴到公开日志。更换密钥并重启服务即可撤销旧地址。

## MCP 客户端配置

支持 Streamable HTTP 的客户端可使用下面的通用配置。把 `SECRET` 替换为启动时使用的密钥：

```json
{
  "mcpServers": {
    "mooncode": {
      "type": "http",
      "url": "http://127.0.0.1:48271/mcp/SECRET"
    }
  }
}
```

如果客户端只支持 stdio，可用内置 relay 将 stdio 转发到 HTTP Bridge。先保持 Bridge 正在运行，再配置：

```json
{
  "mcpServers": {
    "mooncode": {
      "command": "node",
      "args": ["D:/PATH/mooncode-mcp-source/runtime/dist/cli.js", "--mcp-relay"],
      "env": {
        "MOONCODE_MCP_URL": "http://127.0.0.1:48271/mcp/SECRET"
      }
    }
  }
}
```

也可以直接在 PowerShell 中测试 relay：

```powershell
$env:MOONCODE_MCP_URL = 'http://127.0.0.1:48271/mcp/SECRET'
node runtime/dist/cli.js --mcp-relay
```

## 写入和命令权限

Bridge 默认处于 `read_only`，因此读取、搜索和查询类工具可用，文件修改和命令执行会被拒绝。

允许写文件和应用补丁：

```powershell
pnpm start -- --workspace D:\PROJECT --port 48271 --secret $secret --no-tunnel --allow-write --access-scope workspace
```

允许执行命令时，必须同时使用 `--allow-write` 和 `--access-scope computer`：

```powershell
pnpm start -- --workspace D:\PROJECT --port 48271 --secret $secret --no-tunnel --allow-write --access-scope computer
```

`--access-scope workspace` 将文件访问限制在指定工作区；`computer` 是终端命令的必要条件。开启 `computer` 前应确认连接到该 MCP 地址的客户端可信。

## 公网隧道

公网模式仍然使用同一套 MCP 路径与权限模型。`cloudflared` 或 `ngrok` 需要提前安装，并可通过 `--tunnel-executable` 指定可执行文件路径。

### Cloudflare Quick Tunnel

```powershell
pnpm start -- --workspace D:\PROJECT --secret $secret --tunnel-provider cloudflare-quick --auth-mode capability_url
```

服务启动后会在隧道状态输出中给出临时公网地址。完整 MCP 地址仍是公开 origin 加 `/mcp/<secret>`。Quick Tunnel 地址会变化，重启后应更新客户端配置。

### Cloudflare Named Tunnel

```powershell
$env:MOONCODE_CLOUDFLARE_TUNNEL_TOKEN = 'CLOUDFLARE_TUNNEL_TOKEN'
pnpm start -- --workspace D:\PROJECT --port 48271 --secret $secret --tunnel-provider cloudflare-named --tunnel-public-url https://bridge.example.com --auth-mode capability_url
```

Named Tunnel 需要令牌和与隧道路由一致的 `--tunnel-public-url`。可选参数包括 `--tunnel-proxy-url`、`--tunnel-startup-timeout-ms` 和 `--tunnel-max-attempts`。

### ngrok

```powershell
$env:MOONCODE_NGROK_AUTHTOKEN = 'NGROK_AUTHTOKEN'
pnpm start -- --workspace D:\PROJECT --port 48271 --secret $secret --tunnel-provider ngrok --tunnel-public-url https://bridge.example.ngrok.app --auth-mode capability_url
```

ngrok 模式要求 authtoken 和稳定的公网 URL。HTTP 代理可通过 `--tunnel-proxy-url` 传给隧道进程。

## OAuth 模式

OAuth 模式使用 JWT/JWKS 校验，并将权限分为 `bridge.read`、`bridge.write` 和 `bridge.exec`。启动示例：

```powershell
pnpm start -- `
  --workspace D:\PROJECT `
  --port 48271 `
  --secret $secret `
  --no-tunnel `
  --auth-mode oauth `
  --oauth-issuer https://auth.example.com `
  --oauth-jwks-uri https://auth.example.com/.well-known/jwks.json `
  --oauth-resource-id mooncode-device-01 `
  --oauth-endpoint-generation 1 `
  --oauth-resource "http://127.0.0.1:48271/mcp/$secret"
```

`--oauth-resource` 的路径必须与同一次启动的 `/mcp/<secret>` 完全一致。公网生产部署还应提供对应的完整 HTTPS resource URL，使用 Named Tunnel 或 ngrok，并设置 `--mode production`。Quick Tunnel 不用于 production OAuth 部署。受保护资源元数据地址会随 `bridge.ready` 输出返回。

## 可用工具与权限

共 15 个公开 MCP 工具：

| 工具 | 功能 | OAuth scope | 本地要求 |
| --- | --- | --- | --- |
| `list_directory` | 分页列出目录 | `bridge.read` | 默认可用 |
| `find_files` | 按 glob 查找文件 | `bridge.read` | 默认可用 |
| `read_files` | 批量读取文件及 SHA-256 版本 | `bridge.read` | 默认可用 |
| `search_files` | 文本或正则搜索 | `bridge.read` | 默认可用 |
| `lsp` | 符号、定义、引用、实现、悬停 | `bridge.read` | 需要扩展 IDE 适配器 |
| `get_diagnostics` | 获取实时诊断 | `bridge.read` | 需要扩展 IDE 适配器 |
| `get_command_output` | 增量读取命令输出 | `bridge.read` | 命令必须属于当前会话 |
| `wait` | 等待命令输出或结束 | `bridge.read` | 命令必须属于当前会话 |
| `read_file` | 单文件读取兼容别名 | `bridge.read` | 默认可用 |
| `set_todos` | 替换当前会话 todo 快照 | `bridge.read` | 默认可用 |
| `report_progress` | 追加进度事件 | `bridge.read` | 默认可用 |
| `apply_patch` | 带版本校验地应用多文件补丁 | `bridge.write` | `--allow-write` |
| `write_file` | 创建或覆盖 UTF-8 文件 | `bridge.write` | `--allow-write` |
| `run_command` | 在持久 PTY 中运行命令 | `bridge.exec` | `--allow-write --access-scope computer` |
| `send_command_input` | 向运行中的 PTY 发送输入 | `bridge.exec` | `--allow-write --access-scope computer` |

## 常用 CLI 参数

| 参数或环境变量 | 说明 |
| --- | --- |
| `--workspace PATH` | Bridge 工作区根目录，默认是当前目录 |
| `--port PORT` | 本地 HTTP 端口，默认 `48271` |
| `--secret SECRET` | capability URL 密钥 |
| `--no-tunnel` | 禁用公网隧道 |
| `--tunnel-provider` | `cloudflare-quick`、`cloudflare-named`、`ngrok` 或 `none` |
| `--tunnel-public-url URL` | Named/ngrok 的稳定 HTTPS origin |
| `--tunnel-executable PATH` | 隧道程序路径 |
| `--auth-mode` | `capability_url` 或 `oauth` |
| `--allow-write` | 将本地权限模式切换为 `auto` |
| `--access-scope` | `workspace` 或 `computer` |
| `--browser-origin-mode` | `universal_https`、`known` 或 `custom` |
| `--browser-origins-json JSON` | `custom` 模式的 HTTPS origin 数组 |
| `MOONCODE_MCP_URL` | stdio relay 的远端 MCP 完整 URL |
| `MOONCODE_CLOUDFLARE_TUNNEL_TOKEN` | Cloudflare Named Tunnel 令牌 |
| `MOONCODE_NGROK_AUTHTOKEN` | ngrok 令牌 |
| `MOONCODE_ENV` | `local`、`development` 或 `production` |

## 源码入口

- `runtime/cli.ts`：CLI 模式选择
- `runtime/bridge-http.ts`：HTTP MCP Bridge、工具路由与参数解析
- `runtime/bridge-auth.ts`：capability URL 与 OAuth 校验
- `runtime/bridge-session.ts`：本地权限、会话和命令租约
- `runtime/mcp-relay.ts`：stdio 到 Streamable HTTP 的转发器
- `contracts/index.ts`：15 个公开工具定义
- `tool-gateway/workspace-files.ts`：文件读取、搜索和路径边界
- `tool-gateway/workspace-patch.ts`：事务补丁
- `tool-gateway/command-manager.ts`：PTY 命令生命周期

## 说明

原 TypeScript Bridge 实现位于 `runtime`、`contracts`、`tool-gateway` 等目录；新增 Linux、浏览器和网页代理源码位于 `hub`、`linux`、`scripts`，使用教程位于 `docs`。仓库中没有 Source Map 文件。
