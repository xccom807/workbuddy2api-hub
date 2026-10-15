"""The Anthropic Messages route runs the client's server-side web_search itself.

A request can declare Anthropic's *server-side* search tool
({"type": "web_search_20250305"}), which means "you run the search and hand me
the structured result" - not "give the model a function to call". DSH's
web_search provider is the reference client: the whole request is one user turn
reading "Perform a web search for the query: <q>", it sends no stream, and it
reads nothing but the `web_search_tool_result` block. Against the official
DeepSeek endpoint that block is what the provider parses; without it the search
fails as WEB_PROVIDER_ERROR.

Before this path existed the declaration was dropped into "these server tools
are not available here" and the client got prose (or a tool_use for a tool it
never declared), so a client that routes its search here could never search.

What is pinned here:

  * the exact request shape is recognised, and only that shape - a conversation
    that merely declares the tool, a function-shaped declaration, a multi-turn
    history, or the switch being off all keep the old behaviour;
  * the response carries server_tool_use + web_search_tool_result, in that
    order, with a shared tool_use_id and one item per result;
  * the search-only path never opens the upstream (no account is spent);
  * a failed search returns Anthropic's result-error shape plus the readable
    reason, and never fabricates a source.

The gateway runs in-process against a mock upstream so "the upstream was never
called" is observed, not assumed. The search backend is stubbed: no network.
"""
import json
import os
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

import _lifecycle as life  # noqa: E402  (shared spare-port pick)

WORK = tempfile.mkdtemp(prefix="anthropic-web-search-")
ACCOUNTS = os.path.join(WORK, "accounts")
os.makedirs(ACCOUNTS, exist_ok=True)
os.environ["ACCOUNTS_DIR"] = ACCOUNTS
os.environ["WB_PROXY_USAGE_DIR"] = os.path.join(WORK, "usage")
os.makedirs(os.environ["WB_PROXY_USAGE_DIR"], exist_ok=True)
os.environ["HOME"] = WORK
os.environ["USERPROFILE"] = WORK
os.environ["WB_PROXY_KEY"] = "TESTKEY"

import base64  # noqa: E402


def jwt(uid="acct-search-1"):
    def seg(obj):
        raw = json.dumps(obj, separators=(",", ":")).encode("utf-8")
        return base64.urlsafe_b64encode(raw).decode().rstrip("=")
    return seg({"alg": "none", "typ": "JWT"}) + "." + seg(
        {"uid": uid, "exp": int(time.time()) + 86400 * 30}) + ".x"


with open(os.path.join(ACCOUNTS, "acct1.json"), "w", encoding="utf-8") as fh:
    json.dump({
        "uid": "acct-search-1",
        "accessToken": jwt(),
        "refreshToken": "",
        "expiresAt": int(time.time()) + 86400 * 30,
        "realm": "intl",
        "domain": "www.workbuddy.ai",
        "platform": "CLI",
        "product": "workbuddy",
        "enabled": True,
    }, fh)

UPSTREAM_PORT = life.free_port()
MOCK = {"requests": [], "text": "an answered turn"}


def sse(chunks):
    out = []
    for c in chunks:
        out.append(("data: " + json.dumps(c) + "\n\n").encode("utf-8"))
    out.append(b"data: [DONE]\n\n")
    return b"".join(out)


def chat_chunks(text):
    """The upstream always answers with an SSE stream, aggregated by the gateway."""
    head = {"id": "chatcmpl_search_1", "model": "deepseek-v4.1-flash"}
    return [
        dict(head, choices=[{"index": 0, "delta": {"role": "assistant", "content": ""}}]),
        dict(head, choices=[{"index": 0, "delta": {"content": text}}]),
        dict(head, choices=[{"index": 0, "delta": {}, "finish_reason": "stop"}],
             usage={"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8}),
    ]


class MockUpstream(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            body = {"_raw": raw.decode("utf-8", "replace")}
        MOCK["requests"].append({"path": self.path, "body": body,
                                 "headers": dict(self.headers)})
        payload = sse(chat_chunks(MOCK["text"]))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        payload = b'{"data":{}}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


upstream = ThreadingHTTPServer(("127.0.0.1", UPSTREAM_PORT), MockUpstream)
threading.Thread(target=upstream.serve_forever, daemon=True).start()

import wb_identity  # noqa: E402
import wb_proxy as P  # noqa: E402
import wb_settings  # noqa: E402
import wb_webtools as W  # noqa: E402

_ENDPOINTS = dict(wb_identity._ENDPOINTS)
for key in list(_ENDPOINTS):
    _ENDPOINTS[key] = ("http://127.0.0.1:%d" % UPSTREAM_PORT, _ENDPOINTS[key][1])
wb_identity._ENDPOINTS.update(_ENDPOINTS)

GATEWAY_PORT = life.free_port()


class Args(object):
    host = "127.0.0.1"
    port = GATEWAY_PORT
    api_key = "TESTKEY"
    system_prompt = "You are a helpful assistant."
    user_agent = None
    usage_dir = os.environ["WB_PROXY_USAGE_DIR"]
    accounts_dir = ACCOUNTS
    import_desktop = False
    lan = False
    panel_password = None
    info = None


P._apply_cli_overrides(Args())
P._bootstrap_runtime(Args())
wb_settings.set_local_web_tools(ACCOUNTS, True)
gateway = ThreadingHTTPServer(("127.0.0.1", GATEWAY_PORT), P.Handler)
threading.Thread(target=gateway.serve_forever, daemon=True).start()

PASS = FAIL = 0


def check(label, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print("  [PASS] %s" % label)
    else:
        FAIL += 1
        print("  [FAIL] %s  %s" % (label, detail))


def request(method, path, body=None, headers=None, timeout=30):
    url = "http://127.0.0.1:%d%s" % (GATEWAY_PORT, path)
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("x-api-key", "TESTKEY")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def parse_sse(raw):
    events = []
    for block in raw.decode("utf-8", "replace").split("\n\n"):
        event = data = ""
        for line in block.splitlines():
            if line.startswith("event: "):
                event = line[7:]
            elif line.startswith("data: "):
                data += line[6:]
        if event:
            events.append((event, json.loads(data or "{}")))
    return events


def wait_ready():
    for _ in range(60):
        try:
            code, _b = request("GET", "/health", timeout=2)
            if code == 200:
                return True
        except Exception:
            pass
        time.sleep(0.25)
    return False


RESULTS = ("Search results for: %s\n\n"
           "1. Cats - Wikipedia\n   https://en.wikipedia.org/wiki/Cat\n   the cat\n\n"
           "2. Cats | ASPCA\n   https://www.aspca.org/pet-care/cats\n   cat care\n")
SEARCH_CALLS = []


def fake_search(query, num_results=5):
    SEARCH_CALLS.append(query)
    return RESULTS % query


def search_request(text, tools=None, **extra):
    payload = {
        "model": "deepseek-v4-flash",
        "max_tokens": 4096,
        "messages": [{"role": "user", "content": [{"type": "text", "text": text}]}],
        "tools": tools if tools is not None else [
            {"type": "web_search_20250305", "name": "web_search", "max_uses": 5}],
    }
    payload.update(extra)
    return payload


ADDENDUM = ("1. Addendum - Example\n   https://example.com/addendum\n   more\n")
SEARCH_FAILED = "Error: could not reach the search backend for 'cats' (URLError)."

try:
    if not wait_ready():
        print("  [FAIL] gateway did not start")
        sys.exit(1)

    print("[1] only the search-request shape takes this path")
    check("the DSH shape yields its query",
          P.native_search_request(search_request("Perform a web search for the query: cats"))
          == "cats")
    check("a plain string content works the same",
          P.native_search_request({
              "messages": [{"role": "user",
                            "content": "Perform a web search for the query: cats"}],
              "tools": [{"type": "web_search_20250305", "name": "web_search"}]}) == "cats")
    check("case and padding do not matter",
          P.native_search_request(search_request(
              "  perform a WEB SEARCH for the query:   cats  ")) == "cats")
    check("a conversation is not a search request",
          P.native_search_request({
              "messages": [{"role": "user", "content": "hi"}],
              "tools": [{"type": "web_search_20250305", "name": "web_search"}]}) is None)
    check("a multi-turn history is not a search request",
          P.native_search_request({
              "messages": [{"role": "user", "content": "Perform a web search for the query: cats"},
                           {"role": "assistant", "content": "ok"}],
              "tools": [{"type": "web_search_20250305", "name": "web_search"}]}) is None)
    check("a function-shaped declaration is not the server-side tool",
          P.native_search_request({
              "messages": [{"role": "user", "content": "Perform a web search for the query: cats"}],
              "tools": [{"type": "function", "name": "web_search",
                         "parameters": {"type": "object"}}]}) is None)
    check("without the declaration nothing happens",
          P.native_search_request(search_request("Perform a web search for the query: cats",
                                                 tools=[])) is None)
    check("an empty query is refused",
          P.native_search_request(search_request("Perform a web search for the query:  ")) is None)
    with mock.patch.object(W, "search", side_effect=fake_search):
        blocks, sources, _text = W.anthropic_search_blocks("cats")
    check("the blocks carry one item per result and a shared id",
          len(blocks) == 2 and blocks[1]["tool_use_id"] == blocks[0]["id"]
          and len(blocks[1]["content"]) == len(sources) == 2, blocks)

    print()
    print("[2] the server runs the search and the upstream stays untouched")
    SEARCH_CALLS[:] = []
    MOCK["requests"][:] = []
    with mock.patch.object(W, "search", side_effect=fake_search):
        code, body = request("POST", "/v1/messages",
                             search_request("Perform a web search for the query: cats"))
    payload = json.loads(body or b"{}")
    content = payload.get("content") or []
    check("200", code == 200, (code, payload))
    check("no upstream request was made", MOCK["requests"] == [],
          [r["path"] for r in MOCK["requests"]])
    check("the search ran once, with the client's query", SEARCH_CALLS == ["cats"], SEARCH_CALLS)
    check("block 0 is server_tool_use for web_search",
          len(content) == 2 and content[0].get("type") == "server_tool_use"
          and content[0].get("name") == "web_search"
          and (content[0].get("input") or {}).get("query") == "cats", content[:1])
    result_block = content[1] if len(content) > 1 else {}
    items = result_block.get("content")
    check("block 1 is the web_search_tool_result",
          result_block.get("type") == "web_search_tool_result"
          and isinstance(items, list) and len(items) == 2, result_block)
    check("the result block points at the server_tool_use",
          result_block.get("tool_use_id") == content[0].get("id"), result_block)
    check("each item carries an url and a title",
          all(i.get("type") == "web_search_result" and i.get("url") and i.get("title")
              for i in items), items)
    check("the parsed urls are the ones the client cites",
          [i["url"] for i in items] == ["https://en.wikipedia.org/wiki/Cat",
                                        "https://www.aspca.org/pet-care/cats"], items)
    check("stop_reason is end_turn",
          payload.get("stop_reason") == "end_turn", payload.get("stop_reason"))
    check("no tokens are billed for a search",
          (payload.get("usage") or {}).get("output_tokens") == 0
          and (payload.get("usage") or {}).get("input_tokens") == 0, payload.get("usage"))
    check("an id in the Anthropic shape", str(payload.get("id") or "").startswith("msg_"),
          payload.get("id"))

    print()
    print("[3] the streamed form emits the same blocks, in order")
    SEARCH_CALLS[:] = []
    MOCK["requests"][:] = []
    with mock.patch.object(W, "search", side_effect=fake_search):
        code, body = request("POST", "/v1/messages",
                             search_request("Perform a web search for the query: cats",
                                            stream=True))
    events = parse_sse(body)
    names = [e for e, _ in events]
    check("200 with an SSE body", code == 200 and names[:1] == ["message_start"],
          (code, names[:3]))
    check("message_start carries an empty content list",
          (events[0][1].get("message") or {}).get("content") == [], events[0][1])
    starts = [d for e, d in events if e == "content_block_start"]
    check("two blocks are opened, at index 0 and 1",
          [b.get("index") for b in starts] == [0, 1], starts)
    check("block 0 is the server_tool_use",
          starts[0].get("content_block", {}).get("type") == "server_tool_use"
          and starts[0]["content_block"].get("input") == {}, starts[0])
    check("block 1 is the full result block",
          starts[1].get("content_block", {}).get("type") == "web_search_tool_result",
          starts[1])
    check("both blocks are closed",
          [d.get("index") for e, d in events if e == "content_block_stop"] == [0, 1],
          [d for e, d in events if e == "content_block_stop"])
    check("the input arrives as an input_json_delta",
          any(d.get("delta", {}).get("type") == "input_json_delta"
              and "cats" in (d["delta"].get("partial_json") or "")
              for e, d in events if e == "content_block_delta"),
          [d for e, d in events if e == "content_block_delta"])
    check("the stream ends properly",
          names[-2:] == ["message_delta", "message_stop"]
          and events[-2][1].get("delta", {}).get("stop_reason") == "end_turn", names[-2:])
    check("a streamed search spends no upstream call either", MOCK["requests"] == [],
          [r["path"] for r in MOCK["requests"]])

    print()
    print("[4] a failed search reports the failure, it does not invent a source")
    SEARCH_CALLS[:] = []
    with mock.patch.object(W, "search", return_value=SEARCH_FAILED):
        code, body = request("POST", "/v1/messages",
                             search_request("Perform a web search for the query: cats"))
    payload = json.loads(body or b"{}")
    content = payload.get("content") or []
    check("still 200 - the search ran, it just found nothing", code == 200, code)
    check("the result block carries Anthropic's error shape",
          len(content) >= 2
          and content[1].get("type") == "web_search_tool_result"
          and (content[1].get("content") or {}).get("type") == "web_search_tool_result_error",
          content[1:2])
    check("no web_search_result item was fabricated",
          not isinstance(content[1].get("content"), list), content[1])
    check("the readable reason rides along as text",
          any(b.get("type") == "text" and "could not reach" in (b.get("text") or "")
              for b in content), content)

    print()
    print("[5] with the switch off the old behaviour is untouched")
    wb_settings.set_local_web_tools(ACCOUNTS, False)
    try:
        MOCK["requests"][:] = []
        SEARCH_CALLS[:] = []
        with mock.patch.object(W, "search", side_effect=fake_search):
            code, body = request("POST", "/v1/messages",
                                 search_request("Perform a web search for the query: cats"))
        payload = json.loads(body or b"{}")
        check("the request goes upstream instead", len(MOCK["requests"]) == 1,
              [r["path"] for r in MOCK["requests"]])
        check("no local search ran", SEARCH_CALLS == [], SEARCH_CALLS)
        check("no result block is claimed",
              all(b.get("type") != "web_search_tool_result"
                  for b in (payload.get("content") or [])), payload.get("content"))
        sent = MOCK["requests"][0]["body"] if MOCK["requests"] else {}
        system = "".join(str(m.get("content") or "") for m in (sent.get("messages") or [])
                         if m.get("role") == "system")
        check("the tool is still reported as unavailable, as before",
              "web_search" in system and "not available here" in system, system)
    finally:
        wb_settings.set_local_web_tools(ACCOUNTS, True)

    print()
    print("[6] a conversation that declares the tool keeps the conversation path")
    MOCK["requests"][:] = []
    SEARCH_CALLS[:] = []
    conversation = {
        "model": "deepseek-v4.1-flash",
        "max_tokens": 64,
        "messages": [{"role": "user", "content": "what is new in cats?"}],
        "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": 5}],
    }
    with mock.patch.object(W, "search", side_effect=fake_search):
        code, body = request("POST", "/v1/messages", conversation)
    payload = json.loads(body or b"{}")
    check("the upstream answered", code == 200, code)
    check("one upstream request, no local search",
          len(MOCK["requests"]) == 1 and SEARCH_CALLS == [],
          (len(MOCK["requests"]), SEARCH_CALLS))
    check("the client's text block comes back unchanged",
          [b.get("type") for b in (payload.get("content") or [])] == ["text"],
          payload.get("content"))

    print()
    print("[7] the search path still validates the request it was given")
    code, body = request("POST", "/v1/messages",
                         {"messages": [{"role": "user",
                                        "content": "Perform a web search for the query: cats"}],
                          "tools": [{"type": "web_search_20250305", "name": "web_search"}]})
    payload = json.loads(body or b"{}")
    check("a missing model is still a 400 in the Anthropic envelope",
          code == 400 and payload.get("type") == "error"
          and (payload.get("error") or {}).get("type") == "invalid_request_error",
          (code, payload))

    code, body = request(
        "POST", "/v1/messages",
        search_request("Perform a web search for the query: cats"),
        headers={"x-api-key": "WRONG"})
    check("a wrong key is still 401", code == 401, code)
finally:
    try:
        gateway.shutdown()
        gateway.server_close()
    except Exception:
        pass
    try:
        upstream.shutdown()
        upstream.server_close()
    except Exception:
        pass
    for stop in ("SCHEDULER", "PRICING"):
        try:
            obj = getattr(P, stop, None)
            if obj is not None:
                obj.stop()
        except Exception:
            pass

print()
print("PASS=%d FAIL=%d" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
