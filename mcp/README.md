# mcp/ — 给 Codex 用的 WorkBuddy 派活通道

`wb-mcp.mjs` 是一个零依赖的 stdio MCP 服务器，把本机 WorkBuddy（桌面端自带的
CodeBuddy CLI）暴露成三个工具。定位与 `@whaletalk/dsh-codex-collab` 的
`dsh-mcp.mjs` 完全相同：那边派活给 DeepSeek Harness，这边派活给 WorkBuddy。

| 工具 | 作用 |
|---|---|
| `workbuddy_task(instruction, cwd, permission_mode?, model?, json_schema?, timeout_ms?)` | headless 跑一次性任务（`codebuddy -p ... --output-format json`），读取 CLI 的 JSON 事件数组，只回最后一个 `result` 事件 |
| `workbuddy_models()` | 列本机网关 `/v1/models` 的模型 id（key 从 `~/.codebuddy/settings.json` 读，绝不回显） |
| `workbuddy_health()` | CLI 文件在不在 + 网关 `/health` 通不通 |

## 接进 Codex

`~/.codex/config.toml`：

```toml
[mcp_servers.workbuddy]
command = 'node'
args = ['D:\workapi\mcp\wb-mcp.mjs']
startup_timeout_sec = 120
tool_timeout_sec = 960          # 硬上限：调用方 timeout_ms 必须 < 960000
```

单引号是 TOML literal string，Windows 反斜杠不会被当转义符——换成双引号就会。

## 前置：CLI 得先指向本网关

「智能体配置」页一键配置 **CodeBuddy CLI (WorkBuddy)** 会写
`~/.codebuddy/settings.json`：

```json
{ "model": "deepseek-v4.1-flash",
  "env": { "CODEBUDDY_BASE_URL": "http://127.0.0.1:8788",
           "CODEBUDDY_API_KEY": "<网关 key>" } }
```

`CODEBUDDY_BASE_URL` 必须是**裸根**：CLI 自己会往后面拼 `/chat/completions`。

## 四个坑（都实测踩过）

1. **无交互跑 Codex 时要放行 MCP 审批。** `codex exec` 默认 `approval_policy=never`
   会把 MCP 调用直接判死，报 `MCP tool call requires approval, but approval
   policy is never`。加 `--approve-for-me`（把审批请求交给自动审查）即可；桌面端
   交互使用时会正常弹审批卡片。
2. **要让工人自己跑测试，`permission_mode` 不能只给 `acceptEdits`。** 它只自动接受
   文件编辑，Bash / PowerShell 仍会被拒。需要工人自测时传
   `bypassPermissions`（或 CLI 的 `auto`）。
3. **沙箱里的 shell 可能没有 `python` / 被挡在用户目录外。** Codex 自己的受沙箱
   shell 就连 `C:\Users\...\python.exe` 都报 `Access is denied`，要靠审批放行；
   派活时把解释器**绝对路径**写进指令，能让工人少踩一次。
4. **`--output-format json` 回的是事件数组，不是一个对象。** 回答只在最后一个
   `type:"result"` 元素里；整包回灌会瞬间吃爆上下文（首条 user 事件实测约 24.5k
   token，那是 CLI 自己的 memory/plan 提示）。

## 测试

```bash
node tests/_test_wb_mcp.js              # 52 项，假 CLI 替身，不碰网络与额度
WB_MCP_LIVE=1 node tests/_test_wb_mcp.js # 再加 2 项真机联调（花一次极小额度）
```
