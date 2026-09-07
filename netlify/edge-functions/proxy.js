// Netlify Edge Functions 版（Deno 运行时，逻辑与 Vercel muse-egress/api/proxy.js 同源同步）。
// 无 regions 钉选：边缘 POP 由入口流量决定——6448 经 Clash(Vultr 美国)进来即落在美区 POP，
// 出口 IP 也随 POP。Edge 限制：50ms CPU（IO 等待不计）、首包须 40s 内开始、无墙钟上限公布。
export const config = { path: ["/v1/*", "/geo", "/"] };

const UPSTREAM = "https://opencode.ai"; // ROTATION STAMP: 1788808699344
const UA = "opencode/1.17.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13";

// responses-only 模型：zen 上只有 /v1/responses 端口，chat/messages 需桥接。
// 与本地 6448 脚本（server.mjs chatToResponsesBody / responsesToChatCompletion）对齐。
const RESPONSES_ONLY = [/^muse-spark-/];

// 输出顶下限：muse 的 max_output_tokens 一个顶装思考+正文，太小会被思考吃光
// 导致 status=incomplete 截断；入口兜底抬到下限（额度按实际用量计，抬顶不多扣）。
const MIN_OUTPUT_TOKENS = 65536;

function isResponsesOnly(model) {
  return typeof model === "string" && RESPONSES_ONLY.some((re) => re.test(model));
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && (b.type === "text" || b.type === "input_text" || b.type === "output_text"))
      .map((b) => b.text || "")
      .join("\n");
  }
  if (content != null) return String(content);
  return "";
}

// chat.completions body → responses body（无状态：全量 messages 转 input）
function chatToResponsesBody(chatBody, upstreamModel) {
  const msgList = chatBody.messages || [];
  let instructions = "";
  const input = [];
  let n = 0;
  const nid = (p) => `${p}_${Date.now().toString(36)}${(n++).toString(36)}`;
  for (const m of msgList) {
    if (!m) continue;
    // assistant tool_calls → function_call item
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const text = extractText(m.content);
      if (text.trim()) {
        input.push({ id: nid("msg"), role: "assistant", content: [{ type: "output_text", text }] });
      }
      for (const tc of m.tool_calls) {
        const name = tc.function?.name || tc.name || "unknown";
        const args = tc.function?.arguments ?? tc.arguments ?? "{}";
        input.push({
          type: "function_call",
          call_id: tc.id || nid("call"),
          name,
          arguments: typeof args === "string" ? args : JSON.stringify(args),
        });
      }
      continue;
    }
    // tool 结果 → function_call_output
    if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id || m.tool_callId || m.id || nid("call"),
        output: extractText(m.content),
      });
      continue;
    }
    // 3) 普通消息：文本 + 图片（多模态：muse-spark-1.3 支持 image 输入）
    // chat image_url 块 → responses input_image（URL 或 base64 data: URI 透传）
    let text = "";
    const imgParts = [];
    if (typeof m.content === "string") text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content.filter((b) => b && b.type === "text").map((b) => b.text || "").join("\n");
      for (const b of m.content) {
        const u = b && (b.type === "image_url" ? b.image_url?.url || b.image_url : null);
        if (typeof u === "string" && u) imgParts.push(u);
      }
    } else if (m.content != null) text = String(m.content);
    if (m.role === "system") {
      if (text.trim()) {
        instructions += (instructions ? "\n" : "") + text;
      }
      continue;
    }
    if (!String(text).trim() && !imgParts.length) continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    const parts = [];
    if (String(text).trim()) parts.push({ type: role === "user" ? "input_text" : "output_text", text });
    // 图片只在 user 消息拼 input_image（assistant 历史里的图不回放，避免上游拒收）
    if (role === "user") for (const u of imgParts) parts.push({ type: "input_image", image_url: u });
    if (!parts.length) continue;
    input.push({ id: nid("msg"), role, content: parts });
  }
  // chat tools → responses tools
  let respTools;
  if (Array.isArray(chatBody.tools) && chatBody.tools.length) {
    respTools = chatBody.tools.map((t) => {
      if (t.type === "function" && t.function) {
        return {
          type: "function",
          name: t.function.name,
          description: t.function.description || "",
          parameters: t.function.parameters || t.function.input_schema || t.function.schema || { type: "object", properties: {} },
        };
      }
      return t;
    });
  }
  let respToolChoice;
  if (chatBody.tool_choice) {
    if (typeof chatBody.tool_choice === "string") respToolChoice = chatBody.tool_choice;
    else if (chatBody.tool_choice.type === "function" && chatBody.tool_choice.function?.name)
      respToolChoice = { type: "function", name: chatBody.tool_choice.function.name };
    else respToolChoice = chatBody.tool_choice;
  }
  const effortSrc =
    chatBody.reasoning_effort ?? chatBody.effort ??
    (typeof chatBody.reasoning === "string" ? chatBody.reasoning : chatBody.reasoning?.effort) ??
    chatBody.extra_body?.reasoning_effort ?? chatBody.extra_body?.reasoning?.effort;
  const effortSet = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
  const clientEffort = effortSet.has(effortSrc) ? effortSrc : null;
  const effort = clientEffort || (upstreamModel.startsWith("muse-spark-") ? "xhigh" : null);
  const temp = Number(chatBody.temperature);
  const topP = Number(chatBody.top_p);
  const outCap = Number(chatBody.max_tokens) > MIN_OUTPUT_TOKENS ? Number(chatBody.max_tokens) : MIN_OUTPUT_TOKENS;
  return {
    model: upstreamModel, input, stream: !!chatBody.stream,
    max_output_tokens: outCap,
    ...(instructions ? { instructions } : {}),
    ...(respTools ? { tools: respTools } : {}),
    ...(respToolChoice ? { tool_choice: respToolChoice } : {}),
    ...(effort ? { reasoning: { effort } } : {}),
    ...(Number.isFinite(temp) ? { temperature: temp } : {}),
    ...(Number.isFinite(topP) ? { top_p: topP } : {}),
  };
}

// responses object → chat.completion object（非流）
function responsesToChatCompletion(respObj, model) {
  let text = "";
  const toolCalls = [];
  for (const item of respObj.output || []) {
    if (item.type === "message") {
      for (const c of item.content || [])
        if (c.type === "output_text") text += c.text || "";
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id || item.id || `call_${Date.now().toString(36)}`,
        type: "function",
        function: { name: item.name || "unknown", arguments: item.arguments || "{}" },
      });
    }
  }
  const ui = respObj.usage?.input_tokens ?? 0, uo = respObj.usage?.output_tokens ?? 0;
  const hasTools = toolCalls.length > 0;
  const finish = hasTools ? "tool_calls" : (respObj.status === "incomplete" ? "length" : "stop");
  const message = hasTools
    ? { role: "assistant", content: text || null, tool_calls: toolCalls }
    : { role: "assistant", content: text };
  return {
    id: respObj.id || `chatcmpl-${Date.now().toString(36)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: { prompt_tokens: ui, completion_tokens: uo, total_tokens: ui + uo },
  };
}

// responses SSE 上游块 → chat chunk 行；upstreamEvent 形如 "response.output_text.delta"
function responsesEventToChatChunk(ev, payload, model) {
  const base = {
    id: `chatcmpl-${Date.now().toString(36)}`, object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta: {}, finish_reason: null }],
  };
  if (ev === "response.output_text.delta" && typeof payload?.delta === "string") {
    base.choices[0].delta = { content: payload.delta };
    return `data: ${JSON.stringify(base)}\n\n`;
  }
  if (ev === "response.function_call_arguments.delta") {
    base.choices[0].delta = {
      tool_calls: [{ index: payload?.output_index ?? 0,
        function: { arguments: payload?.delta || "" } }],
    };
    return `data: ${JSON.stringify(base)}\n\n`;
  }
  if (ev === "response.output_item.added" && payload?.item?.type === "function_call") {
    base.choices[0].delta = {
      tool_calls: [{ index: payload?.output_index ?? 0, id: payload.item.call_id || payload.item.id,
        type: "function", function: { name: payload.item.name || "", arguments: "" } }],
    };
    return `data: ${JSON.stringify(base)}\n\n`;
  }
  if (ev === "response.completed" || ev === "response.incomplete") {
    // 注意 ev 是完整事件名（"response.completed"），比较错会把自己判成截断
    base.choices[0].finish_reason = ev === "response.incomplete" ? "length" : "stop";
    return `data: ${JSON.stringify(base)}\n\n`;
  }
  // reasoning 增量 → SSE comment 保活（xhigh 长思考几分钟无正文时，下游靠这些字节重置读超时；
  // comment 按 SSE 规范被解析器忽略，零风险）。之前返回 null 被静默吞掉 = 长思考必断流/504。
  if ((ev === "response.reasoning_text.delta" || ev === "response.reasoning_summary_text.delta") && typeof payload?.delta === "string") {
    const line = String(payload.delta).split(/\r?\n/, 1)[0].slice(0, 200).trim();
    if (line) return `: thinking ${line}\n\n`;
    return `: keep-alive\n\n`;
  }
  return null;
}

function zenHeaders(contentType, fwd) {
  // 上游现强制要求 x-opencode-session（缺失即 MissingSessionID 400
  // "free tier can only be used in OpenCode"）。本地 6448 每次都带真 session
  // 下来，边缘函数必须原样透传；直连 curl 等没带时现场生成一个兜底。
  return {
    "Authorization": "Bearer public",
    "User-Agent": UA,
    "Content-Type": contentType || "application/json",
    "x-opencode-client": "cli",
    "x-opencode-project": "global",
    "x-opencode-session": fwd?.session || nidLike("ses"),
    "x-opencode-request": fwd?.request || nidLike("msg"),
  };
}

// 无依赖随手 id（edge runtime 零引入；上游只要求有值，不校验归属）
function nidLike(p) {
  const r = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)))
    .map((b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[b % 62]).join("");
  return `${p}_${Date.now().toString(36)}${r(16)}`;
}

async function zenFetch(path, { method = "GET", body = undefined, stream = false, fwd = null } = {}) {
  const r = await fetch(UPSTREAM + "/zen" + path, {
    method,
    headers: { ...zenHeaders("application/json", fwd), ...(stream ? { "Accept": "text/event-stream" } : {}) },
    body,
  });
  return r;
}

// Anthropic messages body → responses body（取 messages 文本；system 拼 instructions）
function anthropicToResponsesBody(aBody, upstreamModel) {
  const input = [];
  let n = 0;
  const nid = (p) => `${p}_${Date.now().toString(36)}${(n++).toString(36)}`;
  let instructions = "";
  const sys = aBody.system;
  if (typeof sys === "string" && sys.trim()) instructions = sys;
  else if (Array.isArray(sys)) instructions = sys.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
  for (const m of aBody.messages || []) {
    // Anthropic image 块 → responses input_image（base64 → data URI，url 直传）
    const imgs = Array.isArray(m.content)
      ? m.content.filter((b) => b && b.type === "image").map((b) => {
          const src = b.source || {};
          if (src.type === "url") return src.url;
          if (src.type === "base64" && src.data) return `data:${src.media_type || "image/jpeg"};base64,${src.data}`;
          return null;
        }).filter(Boolean)
      : [];
    const text = extractText(
      typeof m.content === "string" ? m.content
        : Array.isArray(m.content) ? m.content.map((b) => (b.type === "text" ? b.text : "")).join("\n")
        : m.content
    );
    if (!String(text).trim() && !imgs.length) continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    const parts = [];
    if (String(text).trim()) parts.push({ type: role === "user" ? "input_text" : "output_text", text });
    if (role === "user") for (const u of imgs) parts.push({ type: "input_image", image_url: u });
    if (!parts.length) continue;
    input.push({ id: nid("msg"), role, content: parts });
  }
  return {
    model: upstreamModel, input, stream: !!aBody.stream,
    max_output_tokens: Number(aBody.max_tokens) > MIN_OUTPUT_TOKENS ? Number(aBody.max_tokens) : MIN_OUTPUT_TOKENS,
    ...(instructions ? { instructions } : {}),
    ...(upstreamModel.startsWith("muse-spark-") ? { reasoning: { effort: "xhigh" } } : {}),
  };
}

// responses object → Anthropic messages object（非流）
function responsesToAnthropic(respObj, model) {
  let text = "";
  for (const item of respObj.output || []) {
    if (item.type === "message") {
      for (const c of item.content || [])
        if (c.type === "output_text") text += c.text || "";
    }
  }
  const ui = respObj.usage?.input_tokens ?? 0, uo = respObj.usage?.output_tokens ?? 0;
  return {
    id: respObj.id || `msg_${Date.now().toString(36)}`, type: "message", role: "assistant",
    content: [{ type: "text", text }], model,
    stop_reason: respObj.status === "incomplete" ? "max_tokens" : "end_turn",
    usage: { input_tokens: ui, output_tokens: uo },
  };
}

// ── 流式直通：立即 200 SSE + 周期 ping 保活 + 后台泵上游 ──
// 为什么：Netlify 边缘函数有 40s 响应头超时 + 函数级超时预算（超限回
// "the edge function timed out"）。旧写法 await fetch 到上游首包才返回响应头，
// muse xhigh 长推理/大请求会撞死（网关看到 502）。改为先返回 200（响应头
// 超时归零），上游等待期每 10s 发 SSE 注释行防整条链路空闲掐断；上游非 200
// 转成流内 error 帧（code=upstream_status_NNN），网关探测期识别后透明重试/
// 换桶（对齐 6448 流内错误协议），下游无感。
function egressStreamResponse(upP) {
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      const push = (s) => { if (closed) return; try { controller.enqueue(enc.encode(s)); } catch { closed = true; } };
      const ping = setInterval(() => push(": ping\n\n"), 10000);
      try {
        const r = await upP;
        push(`: egress-status: ${r.status}\n\n`);
        if (r.ok && r.body) {
          const reader = r.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (closed) { try { reader.cancel(); } catch {} break; }
            try { controller.enqueue(value); } catch { closed = true; try { reader.cancel(); } catch {} break; }
          }
        } else {
          let txt = "";
          try { txt = await r.text(); } catch {}
          let msg = txt ? txt.slice(0, 500) : `upstream ${r.status}`;
          let type = "upstream_error";
          try {
            const j = JSON.parse(txt);
            msg = String(j.error?.message || j.message || j.detail || msg).slice(0, 500);
            type = String(j.error?.type || j.type || type);
          } catch {}
          push(`data: ${JSON.stringify({ error: { message: msg, type, code: "upstream_status_" + r.status } })}\n\ndata: [DONE]\n\n`);
        }
      } catch (e) {
        push(`data: ${JSON.stringify({ error: { message: "egress fetch failed: " + (e?.message || e), type: "upstream_error", code: "upstream_status_502" } })}\n\ndata: [DONE]\n\n`);
      } finally {
        clearInterval(ping);
        try { controller.close(); } catch {}
      }
    },
  });
  return new Response(stream, { status: 200, headers: {
    "content-type": "text/event-stream", "cache-control": "no-cache, no-transform",
    "connection": "keep-alive", "access-control-allow-origin": "*",
  } });
}

export default async function handler(req) {
  const url = new URL(req.url);
  const targetPath = url.searchParams.get("zp") || url.pathname;

  if (targetPath === "/geo") {
    const t = await (await fetch("https://ipwho.is/")).json();
    return new Response(JSON.stringify({ ip: t.ip, country: t.country, city: t.city, success: t.success }), { headers: { "content-type": "application/json" } });
  }
  if (targetPath === "/") {
    return new Response(JSON.stringify({ ok: true, service: "muse-egress", bridge: "chat+messages+responses v1" }), { headers: { "content-type": "application/json" } });
  }

  const method = req.method;
  const rawBody = ["GET", "HEAD"].includes(method) ? undefined : await req.text();
  let reqJson = null;
  try { reqJson = rawBody ? JSON.parse(rawBody) : null; } catch { /* 非 JSON 按透传处理 */ }
  const model = reqJson?.model || "";
  const bridge = isResponsesOnly(model);
  // 下游（本地 6448）带来的真 session/request id，原样透传给 zen
  const fwd = {
    session: req.headers.get("x-opencode-session") || "",
    request: req.headers.get("x-opencode-request") || "",
  };

  // ── chat.completions 桥接（仅 responses-only 模型；其余透传）──
  if (targetPath === "/v1/chat/completions" && bridge && reqJson) {
    const fixed = chatToResponsesBody(reqJson, model);
    const up = await zenFetch("/v1/responses", { method: "POST", body: JSON.stringify(fixed), stream: fixed.stream, fwd });
    if (!fixed.stream) {
      const txt = await up.text();
      let data = null;
      try { data = JSON.parse(txt); } catch { /* 下落透传原文 */ }
      if (up.status !== 200 || !data) {
        return new Response(txt, { status: up.status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
      }
      return new Response(JSON.stringify(responsesToChatCompletion(data, model)),
        { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
    }
    // 流式：responses SSE → chat SSE 转码透传
    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder(), dec = new TextDecoder();
        const reader = up.body.getReader();
        let buf = "", curEvent = "";
        const push = (s) => controller.enqueue(enc.encode(s));
        try {
          let dead = false;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, idx).trim();
              buf = buf.slice(idx + 1);
              if (!line) continue;
              if (line.startsWith(":")) continue;
              if (line.startsWith("event:")) { curEvent = line.slice(6).trim(); continue; }
              if (line.startsWith("data:")) {
                const payload = line.slice(5).trim();
                if (payload === "[DONE]") { push("data: [DONE]\n\n"); continue; }
                let obj = null;
                try { obj = JSON.parse(payload); } catch { continue; }
                const ev = curEvent || obj.type || "";
                // 上游流内错误帧（桶耗尽等，形如 {"type":"error","message":"exceed quota limit"}）：
                // 之前被静默吞掉 → 下游空响应；现如实转给下游（本函数无状态，不换桶）
                if (ev === "error" || ev === "response.failed" || obj.error) {
                  const msg = String(obj.message || obj.error?.message || obj.response?.error?.message || "stream error");
                  push(`data: ${JSON.stringify({ error: { message: msg } })}\n\ndata: [DONE]\n\n`);
                  dead = true;
                  break;
                }
                const chunk = responsesEventToChatChunk(ev, obj, model);
                if (chunk) push(chunk);
                curEvent = "";
              }
            }
            if (dead) break;
          }
          if (!dead) push("data: [DONE]\n\n");
        } catch (e) {
          push(`data: ${JSON.stringify({ error: { message: "bridge stream error: " + (e?.message || e) } })}\n\ndata: [DONE]\n\n`);
        } finally {
          try { controller.close(); } catch {}
        }
      },
    });
    return new Response(stream, { headers: {
      "content-type": "text/event-stream", "cache-control": "no-cache, no-transform",
      "connection": "keep-alive", "access-control-allow-origin": "*",
    } });
  }

  // ── Anthropic messages 桥接（仅 responses-only 模型；其余透传）──
  if (targetPath === "/v1/messages" && bridge && reqJson) {
    const fixed = anthropicToResponsesBody(reqJson, model);
    const up = await zenFetch("/v1/responses", { method: "POST", body: JSON.stringify(fixed), stream: fixed.stream, fwd });
    if (!fixed.stream) {
      const txt = await up.text();
      let data = null;
      try { data = JSON.parse(txt); } catch {}
      if (up.status !== 200 || !data) {
        return new Response(txt, { status: up.status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
      }
      return new Response(JSON.stringify(responsesToAnthropic(data, model)),
        { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
    }
    // 流式：转 Anthropic SSE（message_start/content_block_delta/message_delta/message_stop）
    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder(), dec = new TextDecoder();
        const reader = up.body.getReader();
        let buf = "", curEvent = "";
        const msgId = `msg_${Date.now().toString(36)}`;
        const push = (ev, data) => controller.enqueue(enc.encode(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`));
        push("message_start", { type: "message_start",
          message: { id: msgId, type: "message", role: "assistant", content: [], model, stop_reason: null,
            usage: { input_tokens: 0, output_tokens: 0 } } });
        push("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        try {
          let outLen = 0;
          let dead = false;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, idx).trim();
              buf = buf.slice(idx + 1);
              if (!line || line.startsWith(":")) continue;
              if (line.startsWith("event:")) { curEvent = line.slice(6).trim(); continue; }
              if (line.startsWith("data:")) {
                const payload = line.slice(5).trim();
                if (payload === "[DONE]") continue;
                let obj = null;
                try { obj = JSON.parse(payload); } catch { continue; }
                const ev = curEvent || obj.type || "";
                // 上游流内错误帧：转成可见文本（Anthropic SSE 无流内错误事件规范），照常收尾
                if (ev === "error" || ev === "response.failed" || obj.error) {
                  const msg = String(obj.message || obj.error?.message || obj.response?.error?.message || "stream error");
                  push("content_block_delta", { type: "content_block_delta", index: 0,
                    delta: { type: "text_delta", text: "[upstream: " + msg.slice(0, 120) + "]" } });
                  dead = true;
                  break;
                }
                if (ev === "response.output_text.delta" && typeof obj.delta === "string") {
                  outLen += obj.delta.length;
                  push("content_block_delta", { type: "content_block_delta", index: 0,
                    delta: { type: "text_delta", text: obj.delta } });
                }
                // reasoning 增量 → SSE comment 保活（xhigh 长思考零正文时不断流；comment 被解析器忽略）
                else if ((ev === "response.reasoning_text.delta" || ev === "response.reasoning_summary_text.delta") && typeof obj.delta === "string") {
                  const tl = String(obj.delta).split(/\r?\n/, 1)[0].slice(0, 200).trim();
                  controller.enqueue(enc.encode(`: thinking ${tl}\n\n`));
                }
                curEvent = "";
              }
            }
            if (dead) break;
          }
          push("content_block_stop", { type: "content_block_stop", index: 0 });
          push("message_delta", { type: "message_delta",
            delta: { stop_reason: "end_turn" }, usage: { output_tokens: outLen } });
          push("message_stop", { type: "message_stop" });
        } catch (e) {
          push("error", { type: "error", error: { type: "bridge_error", message: String(e?.message || e) } });
        } finally {
          try { controller.close(); } catch {}
        }
      },
    });
    return new Response(stream, { headers: {
      "content-type": "text/event-stream", "cache-control": "no-cache, no-transform",
      "connection": "keep-alive", "access-control-allow-origin": "*",
    } });
  }

  // ── 默认：原样透传（responses / models / 非 muse 模型等）──
  // 唯一例外：muse-spark 的 responses 请求没带 reasoning.effort 时默认补 xhigh
  // （对齐本地脚本满血默认；客户端显式值一律保留）。
  let body = ["GET", "HEAD"].includes(method) ? undefined : rawBody;
  if (targetPath === "/v1/responses" && reqJson) {
    if (bridge) {
      const patch = {};
      if (!reqJson.reasoning?.effort && !reqJson.reasoning_effort && !reqJson.effort) {
        patch.reasoning = { effort: "xhigh" };
      }
      const n = Number(reqJson.max_output_tokens);
      if (!Number.isFinite(n) || n < MIN_OUTPUT_TOKENS) patch.max_output_tokens = MIN_OUTPUT_TOKENS;
      if (Object.keys(patch).length) body = JSON.stringify({ ...reqJson, ...patch });
    }
    // 流式一律走立即-200 通道（绕开 40s 响应头超时/函数超时；错误转流内帧）
    if (reqJson.stream) {
      const upP = fetch(UPSTREAM + "/zen" + targetPath, {
        method,
        headers: zenHeaders(req.headers.get("content-type"), fwd),
        body,
      });
      return egressStreamResponse(upP);
    }
  }
  const r = await fetch(UPSTREAM + "/zen" + targetPath, {
    method,
    headers: zenHeaders(req.headers.get("content-type"), fwd),
    body,
  });
  return new Response(r.body, { status: r.status, headers: { "content-type": r.headers.get("content-type") || "application/json", "access-control-allow-origin": "*" } });
}
