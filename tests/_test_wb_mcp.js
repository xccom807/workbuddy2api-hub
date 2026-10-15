/* The WorkBuddy MCP server must speak JSON-RPC over stdio well enough for Codex
   to drive it, and must survive the CLI's real output shape.

   Two things this suite pins down that are easy to get wrong and impossible to
   notice by reading the code:

     1. `--output-format json` does NOT print one envelope object; it prints a
        JSON ARRAY of every event, and the answer only lives in the last
        {type:"result"} element. A server that returns the whole array hands the
        model ~25k tokens of the CLI's own system prompt as the "result";
     2. the CLI is a real executable that spawns its own children, so a timeout
        must kill the process TREE. Killing just the direct child leaves a
        grandchild burning quota - this suite asserts the grandchild stops.

   The default run is offline and costs nothing: it points WB_MCP_CLI at a fake
   CLI generated in a temp dir and stubs global fetch. The real CLI is only
   touched when WB_MCP_LIVE=1 is set. Run with Node.
*/
'use strict';
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const MCP_PATH = path.join(__dirname, '..', 'mcp', 'wb-mcp.mjs');
const FAKE_KEY = 'sk-fake-key-for-tests-0123456789';
const FAKE_MODEL = 'fake-model-alpha';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-mcp-test-'));
// A clean directory for the fake CLI to "work" in: TMP itself holds the fake
// executable and the receipt files.
const WORKDIR = path.join(TMP, 'work');
fs.mkdirSync(WORKDIR);
// Where the real CLI is allowed to run in live mode: its own empty directory,
// so a stray edit never lands next to the test's own artifacts.
const LIVE_WORKDIR = path.join(TMP, 'live');
fs.mkdirSync(LIVE_WORKDIR);
const RECEIPT = path.join(TMP, 'receipt.json');
const HEARTBEAT = path.join(TMP, 'heartbeat.txt');

let PASS = 0;
let FAIL = 0;
const check = (label, cond, extra) => {
  if (cond) { PASS += 1; console.log('  [PASS] ' + label); }
  else { FAIL += 1; console.log('  [FAIL] ' + label + (extra !== undefined ? '  ' + String(extra) : '')); }
};
const section = title => { console.log(''); console.log('[' + title + ']'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- fake CLI ---------------------------------------------------------------
// Mirrors the real envelope: an array whose last element is the result event.
const fakeCli = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { spawn } = require('child_process');
const argv = process.argv.slice(2);
const val = name => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
const receiptPath = process.env.WB_FAKE_RECEIPT;
if (receiptPath) {
  fs.writeFileSync(receiptPath, JSON.stringify({argv: argv, cwd: process.cwd()}));
}
const mode = process.env.WB_FAKE_MODE || 'ok';
if (mode === 'sleep') {
  // A grandchild that keeps ticking: if the server only kills the direct child,
  // this outlives the request and the test can see it.
  const beat = process.env.WB_FAKE_HEARTBEAT;
  if (beat) {
    const kid = spawn(process.execPath, ['-e',
      'const fs=require("fs");setInterval(()=>{try{fs.appendFileSync(process.argv[1],"tick\\\\n")}catch(e){}},100)',
      beat], {detached: true, stdio: 'ignore'});
    kid.unref();
  }
  console.error('fake cli: pretending to be busy');
  setTimeout(() => process.exit(0), 30000);
} else if (mode === 'badjson') {
  process.stdout.write('not json at all\\n');
  process.exit(0);
} else if (mode === 'crash') {
  console.error('fake cli: exploded');
  process.exit(3);
} else if (mode === 'error') {
  const envelope = [
    {type: 'result', subtype: 'error', is_error: true, result: 'boom: upstream refused the request',
     session_id: 'fake-session', duration_ms: 7, num_turns: 0, permission_denials: []},
  ];
  process.stdout.write(JSON.stringify(envelope));
  process.exit(1);
} else {
  const envelope = [
    // The first event is the one that makes "regurgitate the array" expensive.
    {type: 'message', role: 'user', sessionId: 'fake-session',
     content: [{type: 'input_text', text: '<system-reminder>'.repeat(400) + ' NOISE_MARKER </system-reminder>'}]},
    {type: 'message', role: 'assistant', status: 'completed', sessionId: 'fake-session',
     providerData: {model: 'deepseek-v4.1-flash'},
     content: [{type: 'output_text', text: '收到'}]},
    {type: 'result', subtype: 'success', is_error: false, result: '收到',
     uuid: 'fake-uuid', session_id: 'fake-session', duration_ms: 1234, duration_api_ms: 1200,
     num_turns: 1, total_cost_usd: 0,
     usage: {input_tokens: 111, output_tokens: 2}, permission_denials: []},
  ];
  if (val('--json-schema')) envelope[2].structured_output = {answer: '收到'};
  process.stdout.write(JSON.stringify(envelope));
  process.exit(0);
}
`;
fs.writeFileSync(path.join(TMP, 'fake-codebuddy.cjs'), fakeCli);

const childEnv = extra => {
  const env = Object.assign({}, process.env, {
    WB_MCP_CLI: path.join(TMP, 'fake-codebuddy.cjs'),
    WB_FAKE_RECEIPT: RECEIPT,
    WB_FAKE_HEARTBEAT: HEARTBEAT,
    WB_MCP_GATEWAY: GATEWAY_URL,   // the loopback stub below, never 8788
    WB_MCP_API_KEY: FAKE_KEY,
    WB_MCP_SETTINGS: path.join(TMP, 'no-settings.json'),
  }, extra || {});
  // A real key in the ambient environment would defeat the leak assertions.
  delete env.CODEBUDDY_API_KEY;
  return env;
};

// ---- loopback gateway stub --------------------------------------------------
// The server runs in its own process, so a stubbed globalThis.fetch in this one
// would never be reached. Anything it talks to over HTTP has to be real.
let GATEWAY_MODE = 'models';
let gatewayHits = [];
const gatewayServer = http.createServer((req, res) => {
  gatewayHits.push({url: req.url, headers: req.headers});
  const send = (status, body, type) => {
    res.writeHead(status, {'Content-Type': type || 'application/json'});
    res.end(body);
  };
  if (req.url === '/v1/models') {
    if (GATEWAY_MODE === 'unauthorized') return send(401, JSON.stringify({detail: 'bad key ' + FAKE_KEY}));
    if (GATEWAY_MODE === 'html') return send(502, '<html>502 bad gateway</html>', 'text/html');
    return send(200, JSON.stringify({object: 'list', data: [{id: 'm-one'}, {id: 'm-two'}]}));
  }
  if (req.url === '/health') {
    if (GATEWAY_MODE === 'down') { res.destroy(); return; }
    return send(200, JSON.stringify({status: 'ok', version: 'test'}));
  }
  send(404, JSON.stringify({error: 'not found'}));
});
let GATEWAY_URL = '';

// ---- MCP client over stdio --------------------------------------------------
function startServer(env) {
  const proc = spawn(process.execPath, [MCP_PATH], { env: env, stdio: ['pipe', 'pipe', 'pipe'] });
  const client = {proc: proc, pending: new Map(), seq: 0, stderr: '', exited: false, badLines: []};
  let buffer = '';
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', c => { client.stderr += c; });
  proc.stdout.on('data', chunk => {
    buffer += chunk;
    let idx = buffer.indexOf('\n');
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line !== '') {
        let msg = null;
        try { msg = JSON.parse(line); } catch (e) { client.badLines.push(line.slice(0, 200)); }
        if (msg && msg.id !== undefined && client.pending.has(msg.id)) {
          const resolve = client.pending.get(msg.id);
          client.pending.delete(msg.id);
          resolve(msg);
        }
      }
      idx = buffer.indexOf('\n');
    }
  });
  proc.on('exit', () => { client.exited = true; });
  client.send = (obj) => {
    // No Nagle: a delayed tiny write would look like a hang to the client.
    if (proc.stdin.writable) { try { proc.stdin.setNoDelay(true); } catch (e) {} }
    proc.stdin.write(JSON.stringify(obj) + '\n');
  };
  client.request = (obj, timeoutMs) => new Promise((resolve, reject) => {
    const id = ++client.seq;
    const timer = setTimeout(() => {
      client.pending.delete(id);
      reject(new Error('timed out waiting for a reply to ' + obj.method + '; stderr=' + client.stderr.slice(-500)));
    }, timeoutMs || 20000);
    client.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    client.send(Object.assign({jsonrpc: '2.0', id: id}, obj));
  });
  client.stop = () => {
    try { proc.stdin.end(); } catch (e) {}
    setTimeout(() => { try { proc.kill(); } catch (e) {} }, 300);
  };
  return client;
}

const payloadOf = (reply) => {
  assert.ok(reply && reply.result, 'expected a result, got ' + JSON.stringify(reply));
  assert.ok(Array.isArray(reply.result.content) && reply.result.content.length > 0, 'expected content blocks');
  const text = reply.result.content[0].text;
  // Tools the server does not know are answered as an isError text block, the
  // same way MCP itself reports a thrown handler.
  if (reply.result.isError && !/^[\s]*[{[]/.test(text)) return {ok: false, error: text};
  return JSON.parse(text);
};
const initialize = client => client.request({
  method: 'initialize',
  params: {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'wb-mcp-test', version: '0'}},
});
const listTools = async (client) => {
  await initialize(client);
  client.send({jsonrpc: '2.0', method: 'notifications/initialized'});
  const reply = await client.request({method: 'tools/list', params: {}});
  return reply.result.tools;
};
const callTool = (client, name, args) => client.request({method: 'tools/call', params: {name: name, arguments: args}});

(async () => {
  assert.ok(fs.existsSync(MCP_PATH), 'server not found: ' + MCP_PATH);
  await new Promise((resolve, reject) => {
    gatewayServer.once('error', reject);
    gatewayServer.listen(0, '127.0.0.1', resolve);
  });
  GATEWAY_URL = 'http://127.0.0.1:' + gatewayServer.address().port;

  // ==========================================================================
  section('1. tools/list: three tools, legal schemas, no secrets');
  const main = startServer(childEnv());
  const tools = await listTools(main);
  const byName = new Map(tools.map(t => [t.name, t]));
  check('tools/list returns exactly three tools',
        tools.length === 3, tools.map(t => t.name).join(','));
  check('the three expected names are present',
        ['workbuddy_task', 'workbuddy_models', 'workbuddy_health'].every(n => byName.has(n)),
        tools.map(t => t.name).join(','));
  let schemaOk = tools.length > 0;
  for (const t of tools) {
    const s = t.inputSchema;
    const legal = s && s.type === 'object' && s.properties && typeof s.properties === 'object' && !Array.isArray(s.properties)
      && (s.required === undefined || (Array.isArray(s.required) && s.required.every(r => Object.prototype.hasOwnProperty.call(s.properties, r))))
      && Object.values(s.properties).every(p => typeof p.type === 'string' && p.type.length > 0);
    if (!legal || !t.description || t.description.length < 20) schemaOk = false;
  }
  check('every inputSchema is a legal object schema with described properties', schemaOk,
        JSON.stringify(tools.map(t => t.inputSchema)));
  check('workbuddy_task says over MCP only through tools/call (no arguments key)',
        !Object.prototype.hasOwnProperty.call(byName.get('workbuddy_task'), 'arguments'));
  const taskProps = byName.get('workbuddy_task').inputSchema.properties;
  check('workbuddy_task requires instruction and cwd',
        JSON.stringify(byName.get('workbuddy_task').inputSchema.required) === JSON.stringify(['instruction', 'cwd']),
        JSON.stringify(byName.get('workbuddy_task').inputSchema.required));
  check('timeout_ms is a number, permission_mode carries the CLI enum',
        taskProps.timeout_ms.type === 'number' && Array.isArray(taskProps.permission_mode.enum)
        && taskProps.permission_mode.enum.indexOf('acceptEdits') !== -1);
  check('the tool listing leaks no API key',
        !JSON.stringify(tools).includes(FAKE_KEY), 'fake key found in tools/list');
  const handshake = await initialize(startServer(childEnv()));
  check('the server version handshake names wb-mcp',
        handshake.result.serverInfo.name === 'wb-mcp' && handshake.result.protocolVersion === '2024-11-05',
        JSON.stringify(handshake.result.serverInfo));

  // ==========================================================================
  section('2. workbuddy_task: the real envelope is an array, not one object');
  const taskCall = await callTool(main, 'workbuddy_task', {instruction: '只回复两个字：收到', cwd: WORKDIR});
  const task = payloadOf(taskCall);
  await sleep(200);
  const receipt = JSON.parse(fs.readFileSync(RECEIPT, 'utf8'));
  check('ok is true', task.ok === true, JSON.stringify(task).slice(0, 300));
  check('exit_code is 0', task.exit_code === 0, task.exit_code);
  check('result is the assistant answer, not the raw array',
        task.result === '收到', JSON.stringify(task.result));
  check('duration_ms is reported', typeof task.duration_ms === 'number' && task.duration_ms >= 0, task.duration_ms);
  check('cwd is echoed back', task.cwd === WORKDIR, task.cwd);
  check('num_turns is lifted off the result event', task.num_turns === 1, task.num_turns);
  check('usage is summarised to token counts only',
        task.usage && task.usage.input_tokens === 111 && task.usage.output_tokens === 2,
        JSON.stringify(task.usage));
  check('the CLI inlined memory/plan prompt never reaches the caller',
        !JSON.stringify(task).includes('NOISE_MARKER'));
  check('no structured_output key when no schema was asked for',
        !Object.prototype.hasOwnProperty.call(task, 'structured_output'));

  check('CLI is spawned with -p <instruction> --output-format json',
        receipt.argv[0] === '-p' && receipt.argv[1] === '只回复两个字：收到'
        && receipt.argv.indexOf('--output-format') !== -1
        && receipt.argv[receipt.argv.indexOf('--output-format') + 1] === 'json',
        JSON.stringify(receipt.argv));
  check('the CLI runs in the requested cwd', receipt.cwd === WORKDIR, receipt.cwd);
  check('--no-session-persistence is always passed',
        receipt.argv.indexOf('--no-session-persistence') !== -1, JSON.stringify(receipt.argv));
  check('--permission-mode defaults to acceptEdits with one value',
        receipt.argv[receipt.argv.indexOf('--permission-mode') + 1] === 'acceptEdits'
        && receipt.argv[receipt.argv.indexOf('--permission-mode') + 2] === '--add-dir',
        JSON.stringify(receipt.argv));
  check('--add-dir <cwd> is passed', receipt.argv[receipt.argv.indexOf('--add-dir') + 1] === WORKDIR);
  check('--model is omitted when the caller did not ask for one',
        receipt.argv.indexOf('--model') === -1, JSON.stringify(receipt.argv));
  check('--json-schema is omitted when the caller did not ask for one',
        receipt.argv.indexOf('--json-schema') === -1, JSON.stringify(receipt.argv));

  await callTool(main, 'workbuddy_task', {
    instruction: 'x', cwd: WORKDIR, permission_mode: 'plan', model: FAKE_MODEL, json_schema: '{"type":"object"}',
  });
  await sleep(200);
  const r2 = JSON.parse(fs.readFileSync(RECEIPT, 'utf8'));
  check('--permission-mode follows the caller', r2.argv[r2.argv.indexOf('--permission-mode') + 1] === 'plan');
  check('--model is passed through when given',
        r2.argv[r2.argv.indexOf('--model') + 1] === FAKE_MODEL, JSON.stringify(r2.argv));
  check('--json-schema is passed as one JSON string',
        r2.argv[r2.argv.indexOf('--json-schema') + 1] === '{"type":"object"}', JSON.stringify(r2.argv));
  const schemaCall = await callTool(main, 'workbuddy_task', {instruction: 'x', cwd: WORKDIR, json_schema: '{"type":"object"}'});
  const withSchema = payloadOf(schemaCall);
  check('structured_output is surfaced when the CLI returns it',
        withSchema.structured_output && withSchema.structured_output.answer === '收到',
        JSON.stringify(withSchema.structured_output));

  // ==========================================================================
  section('3. failure shapes are reported, not thrown');
  const noDir = payloadOf(await callTool(main, 'workbuddy_task', {instruction: 'x', cwd: path.join(TMP, 'nope', 'deeper')}));
  check('a missing cwd is an error result', noDir.ok === false && /does not exist/.test(noDir.error || ''), JSON.stringify(noDir));
  check('a missing cwd is never created', !fs.existsSync(path.join(TMP, 'nope')));
  const missingArg = payloadOf(await callTool(main, 'workbuddy_task', {cwd: WORKDIR}));
  check('a blank instruction is rejected', missingArg.ok === false && /instruction/.test(missingArg.error || ''), JSON.stringify(missingArg));

  const badJsonServer = startServer(childEnv({WB_FAKE_MODE: 'badjson'}));
  const badJson = payloadOf(await callTool(badJsonServer, 'workbuddy_task', {instruction: 'x', cwd: WORKDIR}));
  badJsonServer.stop();
  check('non-JSON stdout becomes {ok:false, raw_json} instead of a crash',
        badJson.ok === false && typeof badJson.raw_json === 'string' && badJson.raw_json.length > 0,
        JSON.stringify(badJson).slice(0, 200));

  const errServer = startServer(childEnv({WB_FAKE_MODE: 'error'}));
  const errReply = payloadOf(await callTool(errServer, 'workbuddy_task', {instruction: 'x', cwd: WORKDIR}));
  errServer.stop();
  check('is_error:true in the envelope makes ok false', errReply.ok === false && errReply.exit_code === 1,
        JSON.stringify(errReply));

  const crashServer = startServer(childEnv({WB_FAKE_MODE: 'crash'}));
  const crash = payloadOf(await callTool(crashServer, 'workbuddy_task', {instruction: 'x', cwd: WORKDIR}));
  crashServer.stop();
  check('a CLI crash surfaces the exit code and stderr',
        crash.ok === false && crash.exit_code === 3 && /exploded/.test(crash.stderr || ''),
        JSON.stringify(crash).slice(0, 300));

  // ==========================================================================
  section('4. timeout kills the process tree, not just the child');
  const slow = startServer(childEnv({WB_FAKE_MODE: 'sleep'}));
  const t0 = Date.now();
  const timedOut = payloadOf(await callTool(slow, 'workbuddy_task', {instruction: 'x', cwd: WORKDIR, timeout_ms: 1000}));
  const waited = Date.now() - t0;
  check('the call returns at roughly the requested deadline', waited < 15000, waited + 'ms');
  check('the timeout is reported as ok:false with timed_out:true',
        timedOut.ok === false && timedOut.timed_out === true, JSON.stringify(timedOut).slice(0, 300));
  // The grandchild ticks every 100ms; give it a moment to have started, then
  // wait long enough that a survivor would have written several more ticks.
  await sleep(500);
  const beatsAfterKill = fs.existsSync(HEARTBEAT) ? fs.readFileSync(HEARTBEAT, 'utf8').length : 0;
  await sleep(1000);
  const beatsLater = fs.existsSync(HEARTBEAT) ? fs.readFileSync(HEARTBEAT, 'utf8').length : 0;
  check('the grandchild actually started ticking', beatsAfterKill > 0, beatsAfterKill);
  check('the grandchild stopped ticking once the tree was killed',
        beatsAfterKill === beatsLater, 'ticks ' + beatsAfterKill + ' -> ' + beatsLater);
  // A non-numeric timeout must not become setTimeout(NaN), which fires on the
  // next tick and is indistinguishable from "the CLI exited at once". The fake
  // CLI sleeps 30s, so a correct default is still pending after 3.5s.
  const junk = await Promise.race([
    callTool(slow, 'workbuddy_task', {instruction: 'x', cwd: WORKDIR, timeout_ms: 'not-a-number'})
      .then(reply => ({settled: true, reply: reply})),
    sleep(3500).then(() => ({settled: false})),
  ]);
  check('a non-numeric timeout_ms falls back to the 10-minute default, not to NaN',
        junk.settled === false, JSON.stringify(junk.reply || null).slice(0, 200));
  slow.stop();

  // ==========================================================================
  section('5. workbuddy_models / workbuddy_health');
  GATEWAY_MODE = 'models';
  gatewayHits = [];
  const models = payloadOf(await callTool(main, 'workbuddy_models', {}));
  check('models are listed by id',
        models.ok === true && JSON.stringify(models.models) === JSON.stringify(['m-one', 'm-two']),
        JSON.stringify(models));
  check('the gateway is called under /v1/models',
        models.count === 2 && gatewayHits.some(h => h.url === '/v1/models'),
        JSON.stringify(gatewayHits.map(h => h.url)));
  const keyHeader = (gatewayHits.find(h => h.url === '/v1/models') || {headers: {}}).headers;
  check('the API key is sent as a header',
        String(keyHeader['x-api-key'] || '').indexOf(FAKE_KEY) !== -1, JSON.stringify(Object.keys(keyHeader)));
  check('the API key never appears in the tool result',
        !JSON.stringify(models).includes(FAKE_KEY), JSON.stringify(models));

  GATEWAY_MODE = 'unauthorized';
  const denied = payloadOf(await callTool(main, 'workbuddy_models', {}));
  check('a rejected key is reported without echoing it',
        denied.ok === false && denied.status === 401 && !JSON.stringify(denied).includes(FAKE_KEY),
        JSON.stringify(denied));

  GATEWAY_MODE = 'html';
  const badGateway = payloadOf(await callTool(main, 'workbuddy_models', {}));
  check('a non-JSON gateway body is a clean error', badGateway.ok === false && badGateway.status === 502,
        JSON.stringify(badGateway));

  GATEWAY_MODE = 'models';
  const offlineServer = startServer(childEnv({WB_MCP_GATEWAY: 'http://127.0.0.1:59999'}));
  const offline = payloadOf(await callTool(offlineServer, 'workbuddy_health', {}));
  offlineServer.stop();
  check('health reports the CLI while the gateway is down',
        offline.cli && offline.cli.exists === true && offline.gateway.ok === false && offline.ok === false,
        JSON.stringify(offline));

  const healthy = payloadOf(await callTool(main, 'workbuddy_health', {}));
  check('health is ok when both the CLI and the gateway answer',
        healthy.ok === true && healthy.gateway.status === 200, JSON.stringify(healthy));

  // ==========================================================================
  section('6. protocol hygiene');
  const ping = await main.request({method: 'ping'});
  check('ping answers with an empty result', ping.result && Object.keys(ping.result).length === 0, JSON.stringify(ping));
  const unknown = await main.request({method: 'no/such/method'});
  check('an unknown method is -32601, not a crash',
        unknown.error && unknown.error.code === -32601, JSON.stringify(unknown));
  const unknownTool = payloadOf(await callTool(main, 'no_such_tool', {}));
  check('an unknown tool name is an error result, not a transport failure',
        unknownTool.ok === false && /unknown tool/.test(unknownTool.error || ''), JSON.stringify(unknownTool));
  check('nothing but JSON-RPC was ever written to stdout',
        main.badLines.length === 0, JSON.stringify(main.badLines));
  check('the server explains itself on stderr, not stdout',
        /stdio MCP ready/.test(main.stderr), main.stderr.slice(0, 200));
  main.stop();
  await sleep(400);

  // ==========================================================================
  section('7. live CLI (WB_MCP_LIVE=1)');
  if (process.env.WB_MCP_LIVE === '1') {
    // The real CLI, the real settings.json and the real gateway. In particular
    // WB_MCP_GATEWAY must go: the CLI reads CODEBUDDY_BASE_URL from its own
    // environment, and inheriting the stub URL would make it talk to nothing.
    const liveEnv = Object.assign({}, process.env);
    delete liveEnv.WB_MCP_CLI;
    delete liveEnv.WB_MCP_SETTINGS;
    delete liveEnv.WB_MCP_API_KEY;
    delete liveEnv.WB_MCP_GATEWAY;
    delete liveEnv.WB_FAKE_RECEIPT;
    delete liveEnv.WB_FAKE_HEARTBEAT;
    delete liveEnv.WB_FAKE_MODE;
    const live = startServer(liveEnv);
    try {
      const liveTask = payloadOf(await callTool(live, 'workbuddy_task', {
        instruction: '只回复两个字：在线', cwd: LIVE_WORKDIR, permission_mode: 'plan', timeout_ms: 120000,
      }));
      check('the real CLI answers with a non-empty result',
            liveTask.ok === true && typeof liveTask.result === 'string' && liveTask.result.trim().length > 0,
            JSON.stringify(liveTask).slice(0, 400));
      console.log('  [live] result=' + JSON.stringify(liveTask.result) + ' duration_ms=' + liveTask.duration_ms);
      check('the live answer did not leak the raw event array',
            !JSON.stringify(liveTask).includes('system-reminder'), JSON.stringify(liveTask).slice(0, 200));
    } finally {
      live.stop();
    }
  } else {
    console.log('  [SKIP] live CLI checks need WB_MCP_LIVE=1 (spends a little quota);');
    console.log('         run: set WB_MCP_LIVE=1 && node tests/_test_wb_mcp.js');
  }

  section('done');
  await new Promise(resolve => gatewayServer.close(resolve));
  finish(FAIL ? 1 : 0);
})().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  finish(1, FAIL + 1);
});

// A killed subtree on Windows can leave the event loop holding a handle, and a
// suite that never exits reads as a hang in tests/run_all.py. Report, then go.
function finish(code, failed) {
  if (failed !== undefined) FAIL = failed;
  console.log('PASS=' + PASS + ' FAIL=' + FAIL);
  try { fs.rmSync(TMP, {recursive: true, force: true}); } catch (e) {}
  process.exit(code);
}
