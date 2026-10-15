# -*- coding: utf-8 -*-
"""反代代跑 web_search / web_fetch（开关在 wb_proxy.LOCAL_WEB_TOOLS）

背景：Codex App 会宣告 web_search 这种 Responses 的伺服器端工具，但 WorkBuddy
上游没有任何搜寻服务——v1.5.3 的 revert 已经量测过，直接把 web_search /
web_search_preview / web_fetch 丢给 chat endpoint，模型的回答跟完全不给工具
一样（零个 tool call）。所以没有现成的执行器可以转接，只能由反代自己跑。

v1.5.0 ~ 1.5.2 做过同一件事，被 revert（issue #43）。三个缺陷都在这里修掉：

  1. 只认 args["query"] 这个字串。模型改送 queries 阵列时会收到一句「你没问
     问题」，于是必然重试、必然把回合数耗光。-> query_args() 同时接受
     query / queries / q，并把多个查询合并成一次搜寻。
  2. 去重只看已展开成 chat 形状的 function，漏掉客户端原本那份伺服器端宣告，
     上游因此同时看到两个同名的 web_search。-> install_tool_defs() 先把同名
     项目全部拿掉，再放进唯一一份我们的定义。
  3. 回合用尽时合成一个 resp_wrapup（status=completed、output=[]）收尾，把
     失败伪装成正常结束，客户端看到的是「讲到一半断掉」。-> 这里不合成任何
     东西：呼叫端在最后一轮把工具收回，让模型自己用文字收尾。

搜寻后端是 DuckDuckGo 的 HTML 版（不需要 API key）。任何失败都回一句可读的
错误给模型，不假造结果。只用 Python 标准库。

第二类客户端不是「宣告伺服器端工具、等模型去呼叫」，而是把整则 /v1/messages
请求当成一次搜寻：唯一一则 user 讯息就是搜寻指令，回应里只读结构化结果块。
DSH 的 web_search provider 就是这个形状（`web_search_20250305` + 一句
"Perform a web search for the query: ..."）。这种请求由 native_search_query()
认出来，anthropic_search_blocks() 组出 server_tool_use / web_search_tool_result
两块——DeepSeek 官方端点回的就是这个形状，客户端解析的是它。
"""

import html as _html
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
import uuid

WEB_SEARCH_NAME = "web_search"
WEB_FETCH_NAME = "web_fetch"

# 客户端会用这几种 type 宣告同一个工具
SEARCH_DECL_TYPES = ("web_search", "web_search_preview", "web_search_preview_2025_03_11")
FETCH_DECL_TYPES = ("web_fetch",)

# Anthropic 的**伺服器端**搜寻工具宣告。跟上面那几种「客户端自己执行」的宣告
# 不是一回事：这个的意思是「服务端替我跑搜寻，把结构化结果回给我」。目前只有
# DSH 的 web_search provider 用这个 type。
NATIVE_SEARCH_DECL_TYPES = ("web_search_20250305",)
# DSH 送来的一整则请求就是这一句，查询字串接在冒号后面。
SEARCH_INSTRUCTION_PREFIX = "perform a web search for the query:"

_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

MAX_RESULTS = 10
MAX_FETCH_CHARS = 100000
HTTP_TIMEOUT = 20
SEARCH_ENDPOINT = "https://html.duckduckgo.com/html/"


class _UnsafeRedirectError(Exception):
    """Raised when a web tool response redirects into a disallowed address."""


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Apply the same URL policy to every redirect target as the initial URL."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urllib.parse.urljoin(req.full_url, str(newurl or ""))
        safe_url, problem = _guard_url(target)
        if problem:
            raise _UnsafeRedirectError(problem)
        return super().redirect_request(req, fp, code, msg, headers, safe_url)


def max_rounds():
    """最多代跑几轮网路工具。环境变数可覆盖，方便临时关小。"""
    try:
        n = int(os.environ.get("WB_MAX_WEB_ROUNDS", "") or "")
    except (TypeError, ValueError):
        n = 0
    return min(8, n) if n > 0 else 3


MAX_WEB_ROUNDS = max_rounds()


def web_search_tool_def():
    return {
        "type": "function",
        "name": WEB_SEARCH_NAME,
        "description": (
            "Searches the web for real-time information and returns ranked results "
            "with titles, URLs and snippets. Use it for current events, documentation "
            "lookup, or anything beyond your knowledge cutoff. To read a page in full, "
            "call web_fetch on its URL afterwards."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query (at least 2 characters).",
                },
                "numResults": {
                    "type": "number",
                    "description": "How many results to return (1-10, default 5).",
                },
            },
            "required": ["query"],
        },
    }


def web_fetch_tool_def():
    return {
        "type": "function",
        "name": WEB_FETCH_NAME,
        "description": (
            "Fetches a URL and returns its readable text. Use startIndex to page "
            "through a long page."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "Absolute http:// or https:// URL to fetch.",
                },
                "startIndex": {
                    "type": "number",
                    "description": "Character offset to continue reading a long page.",
                },
            },
            "required": ["url"],
        },
    }


def _declared(tools, types):
    for t in tools or []:
        if not isinstance(t, dict):
            continue
        if str(t.get("type") or "").strip().lower() in types:
            return True
        # 有些客户端会把它包成 function 形状
        if str(t.get("name") or "").strip().lower() in types:
            return True
    return False


def client_wants_web(tools):
    """客户端宣告了哪几个网路工具（伺服器端或 function 形状都算）。"""
    return {
        "search": _declared(tools, SEARCH_DECL_TYPES + (WEB_SEARCH_NAME,)),
        "fetch": _declared(tools, FETCH_DECL_TYPES + (WEB_FETCH_NAME,)),
    }


def install_tool_defs(chat_tools, wants):
    """把客户端的网路工具宣告换成我们的 function。

    同名项目（伺服器端的 {"type": "web_search"}、客户端自己带的 function、
    以及上一轮从我们这里学到的定义）一律先移除，只留唯一一份；否则上游会
    同时看到两个 web_search，模型会挑错那个去呼叫。
    """
    names = set()
    if wants.get("search"):
        names.add(WEB_SEARCH_NAME)
    if wants.get("fetch"):
        names.add(WEB_FETCH_NAME)

    kept = []
    for t in chat_tools or []:
        if not isinstance(t, dict):
            kept.append(t)
            continue
        type_name = str(t.get("type") or "").strip().lower()
        name = str(t.get("name") or "").strip().lower()
        if isinstance(t.get("function"), dict):
            name = name or str((t.get("function") or {}).get("name") or "").strip().lower()
        if name in names or type_name in names:
            continue
        kept.append(t)

    if wants.get("search"):
        kept.append(web_search_tool_def())
    if wants.get("fetch"):
        kept.append(web_fetch_tool_def())
    return kept


def is_internal_tool(name):
    return str(name or "").strip() in (WEB_SEARCH_NAME, WEB_FETCH_NAME)


def query_args(args):
    """从工具参数取出查询字串。

    旧版只读 args["query"] 这个字串，模型改送 queries 阵列时就会被回一句
    「你没问问题」——issue #43 就是这样一路重试到回合用尽。这里接受
    query / queries / q，阵列会用 " or " 接起来。
    """
    if not isinstance(args, dict):
        return ""
    raw = args.get("query")
    if raw is None:
        raw = args.get("queries")
    if raw is None:
        raw = args.get("q")
    if isinstance(raw, (list, tuple)):
        parts = [str(x).strip() for x in raw if str(x or "").strip()]
        return " or ".join(parts)
    return str(raw or "").strip()


def url_arg(args):
    if not isinstance(args, dict):
        return ""
    raw = args.get("url")
    if raw is None:
        raw = args.get("urls")
    if isinstance(raw, (list, tuple)):
        for x in raw:
            if str(x or "").strip():
                return str(x).strip()
        return ""
    return str(raw or "").strip()


def _http_get(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": _USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    })
    opener = urllib.request.build_opener(_SafeRedirectHandler())
    with opener.open(req, timeout=HTTP_TIMEOUT) as resp:
        raw = resp.read()
        charset = resp.headers.get_content_charset() or "utf-8"
    try:
        return raw.decode(charset, "replace")
    except Exception:
        return raw.decode("utf-8", "replace")


def _strip_tags(text):
    text = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", text or "")
    text = re.sub(r"(?is)<br\s*/?>", chr(10), text)
    text = re.sub(r"(?is)</(p|div|li|tr|h[1-6])>", chr(10), text)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = _html.unescape(text)
    text = text.replace(chr(160), " ")
    text = re.sub(r"[ \t\f\v]+", " ", text)
    text = re.sub(r"\s*\n\s*", chr(10), text)
    text = re.sub(chr(10) + "{3,}", chr(10) + chr(10), text)
    return text.strip()


def _ddg_target(href):
    """解开 DuckDuckGo 的 /l/?uddg= 转址。"""
    href = _html.unescape(str(href or "").strip())
    if href.startswith("//"):
        href = "https:" + href
    try:
        parsed = urllib.parse.urlparse(href)
        if "duckduckgo.com" in parsed.netloc and parsed.path.startswith("/l/"):
            target = (urllib.parse.parse_qs(parsed.query).get("uddg") or [""])[0]
            if target:
                return urllib.parse.unquote(target)
    except Exception:
        pass
    return href


def search(query, num_results=5):
    """DuckDuckGo HTML 版搜寻，回传要喂给模型的可读字串。"""
    query = str(query or "").strip()
    if len(query) < 2:
        return ('Error: web_search needs a query of at least 2 characters; '
                'got %r. Pass it as {"query": "..."}.' % query)
    try:
        n = int(num_results)
    except (TypeError, ValueError):
        n = 5
    n = max(1, min(MAX_RESULTS, n))

    url = SEARCH_ENDPOINT + "?" + urllib.parse.urlencode({"q": query})
    try:
        page = _http_get(url)
    except _UnsafeRedirectError as exc:
        return "Error: search redirect blocked (%s)." % exc
    except urllib.error.HTTPError as exc:
        return "Error: the search backend answered HTTP %s for %r." % (exc.code, query)
    except Exception as exc:
        return "Error: could not reach the search backend for %r (%s)." % (
            query, type(exc).__name__)

    blocks = re.split(r'(?is)<div[^>]+class="[^"]*result__body[^"]*"', page)
    results = []
    for block in blocks[1:]:
        m_link = re.search(
            r'(?is)<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', block)
        if not m_link:
            continue
        href = _ddg_target(m_link.group(1))
        title = _strip_tags(m_link.group(2))
        m_snip = re.search(r'(?is)class="[^"]*result__snippet[^"]*"[^>]*>(.*?)</a>', block)
        snippet = _strip_tags(m_snip.group(1)) if m_snip else ""
        if not href or not title:
            continue
        results.append({"title": title, "url": href, "snippet": snippet})
        if len(results) >= n:
            break

    if not results:
        return ("No results found for: %s%sTry a broader or differently worded query."
                % (query, chr(10) + chr(10)))

    lines = ["%d. %s%s   %s%s   %s" % (i, r["title"], chr(10), r["url"], chr(10), r["snippet"])
             for i, r in enumerate(results, 1)]
    return ("Search results for: %s%s%s%s%sCite the sources you used at the end of "
            "your answer." % (query, chr(10) + chr(10), (chr(10) + chr(10)).join(lines),
                              chr(10) + chr(10), ""))


def _guard_url(url):
    """只允许对外的一般 http(s) 网址。"""
    try:
        parsed = urllib.parse.urlparse(str(url or ""))
    except Exception:
        return None, "Invalid URL."
    if parsed.scheme.lower() not in ("http", "https"):
        return None, "Only http:// or https:// URLs are supported."
    if parsed.username or parsed.password:
        return None, "Credentials in the URL are not allowed."
    host = (parsed.hostname or "").lower()
    if not host or "." not in host or host.endswith(".localhost"):
        return None, "Private, loopback or single-label hosts are not allowed."
    if re.match(r"^(127\.|10\.|192\.168\.|169\.254\.|0\.)", host) or \
            re.match(r"^172\.(1[6-9]|2\d|3[01])\.", host):
        return None, "Private network addresses are not allowed."
    return url, ""


def fetch(url, start_index=0):
    url, problem = _guard_url(url)
    if problem:
        return "Error: %s" % problem
    try:
        page = _http_get(url)
    except _UnsafeRedirectError as exc:
        return "Error: redirect blocked (%s)." % exc
    except urllib.error.HTTPError as exc:
        return "Error: %s answered HTTP %s." % (url, exc.code)
    except Exception as exc:
        return "Error: could not fetch %s (%s)." % (url, type(exc).__name__)

    text = _strip_tags(page)
    try:
        start = max(0, int(start_index))
    except (TypeError, ValueError):
        start = 0
    if start >= len(text):
        return ("Error: startIndex %d is past the end of the page (%d characters "
                "total)." % (start, len(text)))

    end = min(start + MAX_FETCH_CHARS, len(text))
    head = "URL: %s%sCharacters: %d-%d of %d" % (url, chr(10), start, end, len(text))
    tail = ""
    if end < len(text):
        tail = (chr(10) + chr(10) + "[Truncated. Call web_fetch again with startIndex=%d "
                "to continue.]" % end)
    return head + chr(10) + chr(10) + text[start:end] + tail


def sources_from_result(result):
    """把搜寻结果里的 (标题, 网址) 读回来。

    喂给模型的是文字，但客户端要画引用来源需要结构化资料，所以在这里从我们
    自己产出的格式反解，不必另外保存状态。
    """
    out = []
    pattern = r"(?m)^\d+\.\s*(.+?)\s*\n\s*(https?://\S+)\s*$"
    for m in re.finditer(pattern, str(result or "")):
        url = m.group(2).strip().rstrip(".,;:!?")
        title = m.group(1).strip()
        if url and not any(s["url"] == url for s in out):
            out.append({"title": title or url, "url": url})
    return out


def native_search_declared(tools):
    """客户端宣告了 Anthropic 的伺服器端 web_search 吗。

    只认 {"type": "web_search_20250305"} 这种形状。function 形状的同名工具是
    客户端自己执行的，不归这条路管。
    """
    for t in tools or []:
        if not isinstance(t, dict):
            continue
        if str(t.get("type") or "").strip().lower() in NATIVE_SEARCH_DECL_TYPES:
            return True
    return False


def native_search_query(text):
    """从搜寻指令里取回查询字串；不是这个形状就回空字串。

    指令形状是固定的（DSH 就是这么送的），所以这里不做模糊猜测：形状对不上
    就回空字串，调用端照原本的管线走。
    """
    raw = str(text or "").strip()
    if not raw:
        return ""
    if not raw.lower().startswith(SEARCH_INSTRUCTION_PREFIX):
        return ""
    return raw[len(SEARCH_INSTRUCTION_PREFIX):].strip()


def anthropic_search_blocks(query, num_results=5):
    """跑一次搜寻，组成 Anthropic 的 server_tool_use + web_search_tool_result。

    回传 (blocks, sources, result_text)。result_text 是原本要喂给模型的可读
    字串，调用端拿它记录日志；客户端只读 blocks。

    搜寻失败（后端不可达、没有结果）时不给空块冒充成功，也不编造来源：结果块
    换成 Anthropic 自己的 web_search_tool_result_error 形状，sources 为空。
    """
    query = str(query or "").strip()
    result = search(query, num_results)
    sources = sources_from_result(result)
    tool_use_id = "srvtoolu_" + uuid.uuid4().hex[:24]
    if sources:
        content = [{
            "type": "web_search_result",
            "url": s["url"],
            "title": s.get("title") or s["url"],
        } for s in sources]
    else:
        content = {"type": "web_search_tool_result_error", "error_code": "unavailable"}
    blocks = [
        {
            "type": "server_tool_use",
            "id": tool_use_id,
            "name": WEB_SEARCH_NAME,
            "input": {"query": query},
        },
        {
            "type": "web_search_tool_result",
            "tool_use_id": tool_use_id,
            "content": content,
        },
    ]
    return blocks, sources, result


def execute(name, args_raw):
    """执行一次内部网路工具。永不抛例外，永远回一句能喂回模型的字串。"""
    name = str(name or "").strip()
    if isinstance(args_raw, str):
        try:
            args = json.loads(args_raw or "{}")
        except Exception:
            args = {}
    elif isinstance(args_raw, dict):
        args = args_raw
    else:
        args = {}
    if not isinstance(args, dict):
        args = {}

    try:
        if name == WEB_SEARCH_NAME:
            return search(query_args(args), args.get("numResults") or 5)
        if name == WEB_FETCH_NAME:
            return fetch(url_arg(args), args.get("startIndex") or 0)
        return "Error: %s is not a tool this gateway runs." % name
    except Exception as exc:
        return "Error running %s: %s: %s" % (name, type(exc).__name__, exc)
