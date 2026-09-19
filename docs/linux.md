# MoonCode Linux：MCP、浏览器、网页代理与 subagent

本版本新增三个可独立运行的入口：MCP 链接管理、浏览器/虚拟桌面 MCP、ChatGPT 网页代理。Cloudflare 已退出本版本的启动流程。

v0.3.0 的可调数量设置、Sub2API / CPA 账号导入和 API Key 接口见[服务器与账号配置](server.md)。

## 1. 下载与启动

Linux 打包产物为 `mooncode-linux-x64.tar.gz`，包含 Node.js、编译后的服务、Linux 原生依赖和 Chromium。支持 Ubuntu 22.04/24.04 x64。首次在精简系统使用浏览器时，仍需要操作系统共享库：

```bash
tar -xzf mooncode-linux-x64.tar.gz
cd mooncode-linux-x64
# 管理员只需安装一次浏览器共享库；浏览器本身以普通用户启动。
sudo ./bin/node node_modules/playwright/cli.js install-deps chromium
# 需要虚拟桌面时再安装：
sudo apt-get install -y xvfb xdotool imagemagick
bash start.sh serve --workspace /home/you/project --ttl 0
```

`mooncode-linux-bootstrap.tar.gz` 是体积较小的跨平台构建包，首次运行需要系统 Node.js 22.12+、npm、Python 3、make 和 C++ 编译工具。解压后执行 `bash setup.sh`，它在 Linux 本机安装原生依赖及 Chromium，再执行同样的启动命令。

源码构建：

```bash
pnpm install
pnpm build
pnpm --filter @mooncode/mcp-hub exec playwright install --with-deps chromium
node hub/cli.mjs serve --workspace /home/you/project
```

服务输出 `link.url`，例如 `http://127.0.0.1:48271/mcp/<43位密钥>`。默认只读，`Ctrl+C` 关闭服务并撤销全部链接。启动脚本按所在目录定位程序，工作区由 `--workspace` 指定。

## 2. 持续创建链接

保持服务运行，在另一个终端操作：

```bash
bash start.sh create --kind workspace --workspace /home/you/project --name reader-a
bash start.sh create --kind workspace --workspace /home/you/project --name writer-b --allow-write
bash start.sh create --kind browser --name browser-c
bash start.sh create --kind desktop --name desktop-d
bash start.sh list
bash start.sh config LINK_ID
bash start.sh revoke LINK_ID
```

链接生成没有累计次数配额。默认同时保留 16 个链接，通过 `serve --max-active 64` 调整，最高 1024。每个链接默认存活一小时；`--ttl 0` 持续到主动撤销或服务退出。每个地址具有独立随机密钥、权限、命令状态或浏览器环境。反复创建与撤销可以持续使用，实际并发受内存和 CPU 限制。

文件链接默认只读工作区。写入需要 `--allow-write`，终端执行需要再加 `--allow-exec`。终端执行使用当前 Linux 用户的系统权限；工作区限制不是容器隔离。浏览器/桌面链接本身支持网页交互，也能访问运行它的机器可达的网络。

管理 API 在另一个随机 loopback 端口，凭据保存于 `~/.local/state/mooncode-hub/admin.json`，Linux 权限为 0600；不同实例用不同 `--state-file`。异常强制终止留下的状态文件应在确认旧进程退出后由用户移走，再启动。公网网关不包含管理路由。

## 3. 接入反向代理

本机链接供本机 agent 使用。ChatGPT.com 连接需要一个外部可达的 HTTPS 域名与实际反向代理：

```bash
bash start.sh serve --workspace /home/you/project --public-origin https://mcp.example.com --ttl 0
```

参考包内 `nginx.conf.example` 将 `/mcp/` 代理至 `127.0.0.1:48271`。配置自己的 DNS 和 TLS 证书，关闭响应缓冲，保留完整 MCP 路径。`--public-origin` 只改变输出的链接地址，不自动创建域名、证书或网络通路。

只代理 MCP 网关。管理 API 和网页控制台维持 loopback 访问。MCP URL 中的密钥授予该链接的能力，日志模板已关闭访问日志；正常撤销或到期后该路径返回 404。服务重启后原链接全部失效，需要更新客户端配置。

## 4. 无头浏览器与电脑操作

`bash start-browser.sh --ttl 0` 可单独启动浏览器 MCP；也可以在已有 Hub 中 `create --kind browser`。

| 类型 | 工具 |
| --- | --- |
| workspace | 原有 15 个文件、搜索、补丁、命令和任务工具 |
| browser | `browser_navigate`、`browser_snapshot`、`browser_click`、`browser_fill`、`browser_press`、`browser_screenshot` |
| desktop | browser 的 6 个工具，加 `computer_screenshot`、`computer_click`、`computer_type`、`computer_key` |

`browser` 使用全新 Chromium，无用户常用浏览器 cookies。`desktop` 在 Linux 中给每个链接启动独立的 1280×800 Xvfb 桌面及可见 Chromium，通过 xdotool 点击、输入、按键；截图通过 ImageMagick 返回。它操作的是服务创建的虚拟桌面。桌面上没有另外安装的应用时，只能使用 Chromium 和当前会话中启动的应用。

独立 CLI 没有 IDE Extension Host，原有 `lsp` 和 `get_diagnostics` 返回 provider unavailable；文件和命令工具不依赖 IDE。

## 5. Subagent 连接

每个 subagent 分配一个链接。可直接使用 Streamable HTTP：

```json
{"mcpServers":{"worker":{"type":"http","url":"https://mcp.example.com/mcp/SECRET"}}}
```

只接受 stdio 的 agent 使用动态工具转发器，支持 workspace/browser/desktop 的不同工具集合：

```json
{
  "mcpServers": {
    "worker": {
      "command": "/opt/mooncode/bin/node",
      "args": ["/opt/mooncode/hub/cli.mjs", "relay"],
      "env": {"MOONCODE_MCP_URL": "https://mcp.example.com/mcp/SECRET"}
    }
  }
}
```

手动验收工具调用：

```bash
export MOONCODE_MCP_URL='http://127.0.0.1:48271/mcp/SECRET'
bash start.sh call
bash start.sh call --tool read_file --args '{"path":"README.md"}'
```

## 6. ChatGPT 网页代理

这是读取可见网页 DOM 的浏览器适配器，不使用 ChatGPT 的私有网络接口。首次在有显示环境的 Linux 上登录到专用浏览器 profile：

```bash
bash start-web.sh login
# 在打开的 Chromium 中登录 ChatGPT，完成后 Ctrl+C。
bash start-web.sh serve --workspace /home/you/project
```

控制台打印带访问 token 的本地网页地址，在本机浏览器打开即可发送任务。远程 Linux 可以用 SSH 转发 `48400` 端口：`ssh -L 48400:127.0.0.1:48400 user@host`。首次登录需要有可见浏览器的桌面/远程桌面；单纯 SSH 端口转发不提供登录 GUI。

登录态保存在专用 profile，默认 `~/.local/state/mooncode-hub/chatgpt-profile`。登录会话过期、登录挑战或网站验证需要用户在有界面模式处理。服务默认不启动公网隧道。

自动配置 MCP 地址需要可从外部访问的 HTTPS MCP origin，以及在 ChatGPT Apps 高级设置中启用 Developer mode。默认适配器按中英文表单标签查找“创建应用”、名称、MCP URL、无认证选项，提交后确认应用名称出现在设置中。它会在字段缺失时停止并报告具体阶段。

账号界面与默认标签不一致时，可提供连接 UI recipe：

```bash
bash start-web.sh serve --workspace /home/you/project \
  --public-origin https://mcp.example.com \
  --connect-config /path/to/my-chatgpt-connect.json
```

在本地控制台点击“配置 ChatGPT MCP 连接”。服务会创建链接，打开设置、填写地址、保存并检查完成状态。默认标签策略尚待你的真实账号验证。`docs/chatgpt-connect.example.json` 是 recipe 格式示例，里面的标签/选择器也需按真实界面替换；末项 `wait` 必须指向已连接的成功状态。仅点击保存不算配置成功。

网页请求通过 `#prompt-textarea` 和发送按钮提交；回答从可见 assistant DOM 读取并转成 SSE 增量。它是网页文本的增量采样，不是服务端 token 原生流。若页面 UI 更新，可通过 `--selectors FILE` 替换 `prompt`、`send`、`assistant`、`stop`、`upload` 选择器。多段 Markdown 渲染可能发出 `replace` 事件，客户端已处理。

ChatGPT 的外部 MCP 连接与本地字段协议是两个可独立使用的通道。没有公网域名时，字段协议仍能在网页 GPT 回答后由本地服务调用 MCP。

## 7. 自动读 skill 与创建子任务

发送每个请求时扫描项目根 `AGENTS.md` 和 `skills/`、`.agents/skills/`、`.codex/skills/` 内的 `SKILL.md`。最多 48 项，单文件 32 KiB，总量 256 KiB，扫描深度 4；忽略跳出项目的符号链接。先把技能清单交给主 agent，它可按需请求正文。

主 agent 的完整回答可包含一个专用字段块：

````text
```mooncode-action
{"id":"read-skill-1","type":"read_skill","path":"skills/review/SKILL.md"}
```
````

其他字段：

```json
{"id":"tools-1","type":"list_tools"}
{"id":"read-1","type":"tool_call","name":"read_files","arguments":{"files":[{"path":"README.md"}]}}
{"id":"worker-1","type":"spawn_agent","kind":"browser","task":"检查指定页面","skills":[]}
```

运行流程：用户请求 → 扫描 skills → 提交网页 GPT → SSE 返回可见文本 → 完整字段解析 → 执行 MCP 或为 subagent 新建对话页和独立链接 → 把结果送回对应网页对话 → 汇总返回。截图也会通过文件输入框附到后续网页消息；网站附件控件变化时需调整 `upload` 选择器。

子任务默认串行，每个子任务是独立 ChatGPT 对话页及 MCP 链接，不把一个 prompt 冒称为多个模型进程。默认每个请求最多 4 个子任务、嵌套深度 2、每个 agent 最多 12 回合、总动作最多 48 次。子任务继承配置的工作区写入/执行权限；浏览器和桌面各自隔离。重复 action id 会被阻止二次执行。任务结束或取消后关闭对话页并撤销临时链接。

## 验收范围

`pnpm test` 覆盖真实 MCP 连接、权限、隔离、撤销/到期、反复创建、浏览器表单/截图、skill 边界、subagent 字段调度及 SSE。网页连接和流式适配使用本地模拟页面；ChatGPT.com 真实账号登录、页面字段与连接成功状态需在你的账号上验收。

GitHub Actions 的 `Linux build and acceptance` 在 Ubuntu 22.04 执行相同测试，并额外验证 Linux PTY、Xvfb 点击/输入/截图。打包后换目录解压，再用包内 Node、原生依赖和 Chromium 运行验收。实际通过状态以对应提交的 Actions 结果为准。
