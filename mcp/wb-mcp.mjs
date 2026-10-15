#!/usr/bin/env node
// wb-mcp: Codex / ChatGPT MCP 服务器，把本机 WorkBuddy（CodeBuddy CLI）暴露为 MCP 工具。
// 定位与 dsh-mcp.mjs 相同：Codex 用 `dsh_task` 派活给 DeepSeek Harness，这里用
// `workbuddy_task` 派活给 WorkBuddy 的 headless CLI，两条腿互不干扰。
//
// 传输只有 stdio：每行一个 JSON-RPC 2.0 消息，日志一律走 stderr —— stdout 是
// 协议通道，混进一行普通文本就会让 Codex 的 JSON-RPC 解析器当场报错。
//
// 这里**不碰** C:\Users\徐\.codebuddy\settings.json：CLI 自己会读它拿到
// CODEBUDDY_BASE_URL / CODEBUDDY_API_KEY，我们只继承环境变量。只有
// workbuddy_models 需要 key，才去那个文件里取，且绝不回显。
import { spawn } from 'node:child_process'
import { existsSync, statSync, readFileSync } from 'node:fs'
import path from 'node:path'

const SERVER_NAME = 'wb-mcp'
const SERVER_VERSION = '0.1.0'
const PROTOCOL_VERSION = '2024-11-05'
const MAX_TIMEOUT_MS = 1800000

// 默认值全部可以用环境变量顶掉：测试要拿假 CLI 替身跑全链路，而且不能碰真机配置。
const CLI_PATH =
  process.env.WB_MCP_CLI ||
  'D:\\workapi\\WorkBuddyAI\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy'
const CLI_RUNTIME = process.env.WB_MCP_NODE || process.execPath
const SETTINGS_PATH =
  process.env.WB_MCP_SETTINGS || 'C:\\Users\\徐\\.codebuddy\\settings.json'
const DEFAULT_CWD = process.env.WB_MCP_CWD || 'D:\\dirtywork'
// 读环境变量的时机放在调用里而不是模块顶层：测试要在同一进程内切换网关地址。
const gateway = () => (process.env.WB_MCP_GATEWAY || 'http://127.0.0.1:8788').replace(/\/+$/, '')

const log = (...args) => console.error('[wb-mcp]', ...args)

// ---- 脱敏 ----
// key 会顺着 CLI 的报错信息（401/鉴权失败常见）漏回 MCP 结果里，所以每个要返回的
// 字符串都过一遍这里。key 只在进程内存里待着，不进日志、不进返回值。
let SECRETS = []
function loadSecrets() {
  const found = new Set()
  const fromEnv = process.env.WB_MCP_API_KEY
  if (fromEnv) found.add(fromEnv)
  try {
    const cfg = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
    const key = cfg && cfg.env && cfg.env.CODEBUDDY_API_KEY
    if (typeof key === 'string' && key.length >= 8) found.add(key)
  } catch {
    // 配置缺失或不是 JSON 都无所谓：模型列表会退化成"拿不到 key"的明确错误。
  }
  SECRETS = [...found].filter((s) => s.length >= 8)
}
function redact(value) {
  let text = typeof value === 'string' ? value : String(value)
  for (const s of SECRETS) if (text.includes(s)) text = text.split(s).join('***REDACTED***')
  return text
}
function gatewayKey() {
  loadSecrets()
  return SECRETS[0] || ''
}

const tools = [
  {
    name: 'workbuddy_task',
    description:
      '把一次性编码任务交给本机 WorkBuddy（CodeBuddy CLI，headless 无会话）执行，用 WorkBuddy 的账号额度跑，与 dsh_task 的 DeepSeek Harness 是两套独立通道。' +
      'CLI 在 cwd 里自己读代码、改文件、跑命令，直到给出最终答复，然后把答复原样返回。' +
      '参数: instruction(必填,完整中文指令:目标/产出文件/验收标准/约束), cwd(必填,已存在的工作目录绝对路径,不存在直接报错不自动创建), ' +
      'permission_mode(default|acceptEdits(默认)|bypassPermissions|plan|dontAsk|auto; plan=只读只出方案), model(可选,默认用 settings.json 里的模型), ' +
      'json_schema(可选,传了则进程内强制结构化输出,结果同时出现在 result 与 structured_output), timeout_ms(默认 600000,到点杀整棵进程树)。' +
      '返回 {ok, exit_code, duration_ms, cwd, result}；CLI 没吐出合法 JSON 时额外带 raw_json 与 error。',
    inputSchema: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: '完整中文指令（目标、产出文件、验收标准、约束）。' },
        cwd: { type: 'string', description: '工作目录（已存在的绝对路径）。不存在时直接报错，不会自动创建。' },
        permission_mode: {
          type: 'string',
          enum: ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'],
          description: '权限模式，默认 acceptEdits（自动接受文件编辑）。plan 只读，只产出方案不改文件。',
        },
        model: { type: 'string', description: '模型 id（可选）。省略时用 CLI 自己的配置，通常是 deepseek-v4.1-flash。' },
        json_schema: { type: 'string', description: 'JSON Schema 字符串（可选）：让 CLI 按该结构输出，结构化结果在 structured_output 里。' },
        timeout_ms: { type: 'number', description: '最长等待毫秒数（默认 600000，上限 1800000）；超时会杀掉整棵子进程树。' },
      },
      required: ['instruction', 'cwd'],
    },
  },
  {
    name: 'workbuddy_models',
    description:
      '只读查询本机网关（默认 http://127.0.0.1:8788）可用的模型 id 列表，用于给 workbuddy_task 的 model 参数挑值。' +
      '不需要参数；key 由服务器自己从 CLI 配置里读，不会出现在返回内容里。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'workbuddy_health',
    description:
      '体检：CodeBuddy CLI 可执行文件在不在、本机网关 /health 通不通。派任务失败时先跑它定位是 CLI 问题还是网关问题。不需要参数。',
    inputSchema: { type: 'object', properties: {} },
  },
]

// ---- workbuddy_task ----

// 超时必须连子孙一起收掉：CLI 自己会 spawn 子进程（工具调用、shell），只 kill
// 直接子进程会留下孤儿进程继续烧额度、占住 cwd 里的文件锁。
// Windows 上没有进程组信号，只能 taskkill /T；POSIX 走负 pid（detached 建的进程组）。
function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return
  try {
    if (process.platform === 'win32') {
      const t = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      t.on('error', () => {})
      t.unref()
    } else {
      try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }
  } catch (e) {
    log('killTree failed:', redact(e && e.message))
  }
}

function buildArgs(args) {
  const argv = [
    CLI_PATH,
    '-p', String(args.instruction),
    '--output-format', 'json',
    '--no-session-persistence',
    '--permission-mode', typeof args.permission_mode === 'string' && args.permission_mode ? args.permission_mode : 'acceptEdits',
    '--add-dir', args.cwd,
  ]
  if (typeof args.model === 'string' && args.model) argv.push('--model', args.model)
  if (typeof args.json_schema === 'string' && args.json_schema.trim()) argv.push('--json-schema', args.json_schema)
  return argv
}

// 真实信封（2026-10-15 用 `node <cli> -p "只回复两个字：收到" --output-format json
// --no-session-persistence --permission-mode plan` 实测）**不是**单个对象，而是
// 全部事件的 JSON 数组，最后一个元素才是收尾事件：
//   [ {type:"message",role:"user",content:[{type:"input_text",text:"...system-reminder..."}]},
//     {type:"message",role:"assistant",status:"completed",
//      content:[{type:"output_text",text:"收到"}], providerData:{model:"deepseek-v4.1-flash"}},
//     {type:"result", subtype:"success", is_error:false, result:"收到",
//      session_id:"01a13ea2-...", duration_ms:3720, num_turns:2, total_cost_usd:0,
//      usage:{input_tokens:24530, output_tokens:2}, permission_denials:[]} ]
// 带 --json-schema 时 result 事件上多一个 structured_output:{name:"dirtywork"}。
// 所以取回答只认 type==="result" 那条，绝不把整个数组回灌给模型：第一条 user 消息
// 里塞着 CLI 自己的 memory / plan-mode 系统提示，实测 2.4 万 token 起步。
function parseEnvelope(stdout) {
  const text = stdout.trim()
  if (!text) return { error: 'CLI printed nothing on stdout' }
  let data
  try {
    data = JSON.parse(text)
  } catch {
    // CLI 在崩溃时会打纯文本栈，此时只能把原文交回去，让调用方自己看。
    return { error: 'CLI stdout is not JSON', raw: text }
  }
  const events = Array.isArray(data) ? data : [data]
  const resultEvent = [...events].reverse().find((e) => e && e.type === 'result')
  if (!resultEvent) return { events, error: 'JSON has no {type:"result"} event' }
  return { events, resultEvent }
}

function runCli(argv, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now()
    let child
    try {
      child = spawn(CLI_RUNTIME, argv, {
        cwd,
        // stdin 必须是 ignore：留成 pipe 会让 CLI 以为有交互输入而在非 TTY 下挂等。
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      })
    } catch (e) {
      resolve({ spawn_error: redact(e && e.message), duration_ms: Date.now() - started })
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ spawn_error: redact(e && e.message), duration_ms: Date.now() - started })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, exit_code: code, signal, timed_out: timedOut, duration_ms: Date.now() - started })
    })
  })
}

async function workbuddyTask(args) {
  const instruction = typeof args.instruction === 'string' ? args.instruction.trim() : ''
  if (!instruction) return { ok: false, error: 'instruction is required' }

  const cwd = args.cwd ? path.resolve(String(args.cwd)) : DEFAULT_CWD
  // 目录不存在就报错，不替用户 mkdir：写错一个字就在别的盘创建出一个空工作区，
  // 比直接失败难查得多。
  if (!existsSync(cwd)) return { ok: false, cwd, error: 'cwd does not exist: ' + cwd }
  try {
    if (!statSync(cwd).isDirectory()) return { ok: false, cwd, error: 'cwd is not a directory: ' + cwd }
  } catch (e) {
    return { ok: false, cwd, error: redact('cwd is not readable: ' + (e && e.message)) }
  }

  // 非数字的 timeout_ms 会让 setTimeout(NaN) 立刻触发（等于没有超时保护），
  // 所以先判有限再钳制，而不是直接 Math.max。
  const requested = Number(args.timeout_ms)
  const timeoutMs = Math.min(Math.max(Number.isFinite(requested) && requested > 0 ? requested : 600000, 1000), MAX_TIMEOUT_MS)
  const run = await runCli(buildArgs({ ...args, instruction, cwd }), cwd, timeoutMs)

  if (run.spawn_error) {
    return { ok: false, cwd, duration_ms: run.duration_ms, error: 'failed to spawn CLI: ' + run.spawn_error }
  }
  if (run.timed_out) {
    // 不带 exit_code：这颗进程是被我们 taskkill 掉的，它的退出码由 taskkill 决定，
    // 报出去只会被当成 CLI 自己的结果。
    return {
      ok: false, cwd, duration_ms: run.duration_ms, timed_out: true,
      error: 'timeout after ' + timeoutMs + 'ms; process tree killed',
      stderr: redact((run.stderr || '').slice(-2000)),
    }
  }

  const parsed = parseEnvelope(run.stdout)
  const base = { cwd, exit_code: run.exit_code, duration_ms: run.duration_ms }
  if (parsed.error) {
    return {
      ...base, ok: false, error: parsed.error,
      raw_json: redact((run.stdout || '').slice(0, 20000)),
      stderr: redact((run.stderr || '').slice(-4000)),
    }
  }
  const ev = parsed.resultEvent
  const out = {
    ...base,
    ok: run.exit_code === 0 && ev.is_error !== true,
    result: typeof ev.result === 'string' ? redact(ev.result) : '',
    subtype: ev.subtype,
    num_turns: ev.num_turns,
    cli_duration_ms: ev.duration_ms,
    session_id: ev.session_id,
    // 只回传"花了多少"，不回传 user 事件（那是 CLI 自己的提示词，最大的一块）。
    usage: ev.usage ? { input_tokens: ev.usage.input_tokens, output_tokens: ev.usage.output_tokens } : undefined,
  }
  if (ev.structured_output !== undefined) out.structured_output = ev.structured_output
  if (Array.isArray(ev.permission_denials) && ev.permission_denials.length > 0) {
    out.permission_denials = ev.permission_denials
  }
  // 退出码 0 但没有 result 文本：通常是 CLI 只在 stderr 里说明了原因。
  if (out.result === '' && !out.ok) out.stderr = redact((run.stderr || '').slice(-4000))
  return out
}

// ---- workbuddy_models / workbuddy_health ----

async function workbuddyModels() {
  const origin = gateway()
  const key = gatewayKey()
  if (!key) return { ok: false, gateway: origin, error: 'no API key found (env WB_MCP_API_KEY or CLI settings.json env.CODEBUDDY_API_KEY)' }
  try {
    const res = await fetch(origin + '/v1/models', {
      headers: { 'x-api-key': key, Authorization: 'Bearer ' + key },
      signal: AbortSignal.timeout(15000),
    })
    const text = await res.text()
    if (!res.ok) return { ok: false, gateway: origin, status: res.status, error: redact(text.slice(0, 500)) }
    let body
    try { body = JSON.parse(text) } catch { return { ok: false, gateway: origin, status: res.status, error: 'gateway returned non-JSON' } }
    const items = Array.isArray(body) ? body : (Array.isArray(body.data) ? body.data : [])
    return { ok: true, gateway: origin, count: items.length, models: items.map((m) => (typeof m === 'string' ? m : m && m.id)).filter(Boolean) }
  } catch (e) {
    return { ok: false, gateway: origin, error: redact(e && e.message) }
  }
}

async function workbuddyHealth() {
  const origin = gateway()
  const out = {
    ok: false,
    cli: { path: CLI_PATH, runtime: CLI_RUNTIME, exists: false },
    gateway: { url: origin },
  }
  try {
    out.cli.exists = existsSync(CLI_PATH)
  } catch (e) {
    out.cli.error = redact(e && e.message)
  }
  try {
    const res = await fetch(origin + '/health', { signal: AbortSignal.timeout(8000) })
    out.gateway.status = res.status
    out.gateway.ok = res.ok
    const text = await res.text()
    out.gateway.body = redact(text.slice(0, 500))
  } catch (e) {
    out.gateway.ok = false
    out.gateway.error = redact(e && e.message)
  }
  out.ok = out.cli.exists === true && out.gateway.ok === true
  return out
}

async function handleToolCall(name, args) {
  if (name === 'workbuddy_task') return workbuddyTask(args)
  if (name === 'workbuddy_models') return workbuddyModels()
  if (name === 'workbuddy_health') return workbuddyHealth()
  throw new Error('unknown tool: ' + name)
}

// ---- JSON-RPC 核心 ----
async function handleMessage(msg) {
  const id = msg.id
  if (msg.method === 'initialize') {
    return { jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } } }
  }
  if (msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled') return null
  if (msg.method === 'ping') return { jsonrpc: '2.0', id, result: {} }
  if (msg.method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools } }
  if (msg.method === 'tools/call') {
    const name = msg.params && msg.params.name
    const args = (msg.params && msg.params.arguments) || {}
    try {
      const value = await handleToolCall(name, args)
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] } }
    } catch (e) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'error: ' + redact(e && e.message || e) }], isError: true } }
    }
  }
  if (id !== undefined) {
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + msg.method } }
  }
  return null
}

// ---- stdio 传输 ----
function runStdio() {
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let idx = buffer.indexOf('\n')
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (line !== '') {
        let msg
        try { msg = JSON.parse(line) } catch { idx = buffer.indexOf('\n'); continue }
        void handleMessage(msg).then((resp) => {
          // 一行一条消息：绝不能 pretty-print，多出来的换行会被当成下一条消息。
          if (resp !== null) process.stdout.write(JSON.stringify(resp) + '\n')
        })
      }
      idx = buffer.indexOf('\n')
    }
  })
  process.stdin.on('end', () => {
    log('stdio closed')
    setTimeout(() => process.exit(0), 200)
  })
  // 只写 stderr：stdout 上一行杂音就够让客户端判协议错。
  log('stdio MCP ready, cli=' + CLI_PATH + ', gateway=' + gateway())
}

runStdio()
