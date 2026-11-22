// MCP server — streamable HTTP, stateless JSON-RPC over POST /mcp.
// Implements: initialize, ping, tools/list, tools/call, notifications (202).
import { DESCRIPTION, POSITIONING, SERVICE_NAME } from "../lib/catalog.js";
import { TOOL_DEFS, TOOL_HANDLERS } from "../lib/tools.js";
import { readJsonBody, sendJson, handleOptions } from "../lib/http.js";
import { rateLimitExceeded } from "../lib/ratelimit.js";

const PROTOCOL_VERSION = "2025-03-26";

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleRpc(msg) {
  const { id, method, params } = msg || {};
  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: "migawari",
          title: SERVICE_NAME,
          version: "1.4.0",
        },
        instructions:
          `${POSITIONING.en}. ${DESCRIPTION.en} Quotes are instant; accepting a quote places a request in pending_review — execution is confirmed by a human operator individually, never automatically.`,
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOL_DEFS });
    case "tools/call": {
      const name = params?.name;
      const handler = TOOL_HANDLERS[name];
      if (!handler) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const out = await handler(params.arguments || {});
      const isError = Boolean(out?.isError);
      const clean = { ...out };
      delete clean.isError;
      return rpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(clean, null, 2) }],
        structuredContent: clean,
        isError,
      });
    }
    default:
      if (id === undefined || id === null) return null; // notification
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method === "GET") {
    // Discovery-friendly info (streamable HTTP allows 405 here; JSON helps agents find us).
    return sendJson(res, 200, {
      name: "migawari",
      title: SERVICE_NAME,
      positioning: POSITIONING,
      description: DESCRIPTION,
      transport: "streamable-http (stateless)",
      protocol_version: PROTOCOL_VERSION,
      tools: TOOL_DEFS.map((t) => t.name),
      usage: "POST JSON-RPC 2.0 messages to this endpoint (initialize, tools/list, tools/call).",
    });
  }
  if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });

  const body = await readJsonBody(req);
  if (body === null) return sendJson(res, 400, rpcError(null, -32700, "Parse error"));

  // Rate-limit tool calls (discovery methods stay unlimited). Every call in
  // a batch counts individually — otherwise a batch would bypass the limits.
  const calls = (Array.isArray(body) ? body : [body]).filter((m) => m?.method === "tools/call");
  for (const call of calls) {
    const bucket = call?.params?.name === "request_quote" ? "quote" : "mcp";
    const rl = await rateLimitExceeded(req, bucket);
    if (rl) return sendJson(res, 429, rpcError(call?.id ?? null, -32029, `Rate limited (bucket ${bucket}). Retry after ${rl.retryAfterSec}s.`));
  }

  if (Array.isArray(body)) {
    const out = [];
    for (const msg of body) {
      const r = await handleRpc(msg);
      if (r) out.push(r);
    }
    if (out.length === 0) {
      res.statusCode = 202;
      res.end();
      return;
    }
    return sendJson(res, 200, out);
  }

  const result = await handleRpc(body);
  if (result === null) {
    res.statusCode = 202;
    res.end();
    return;
  }
  return sendJson(res, 200, result);
}
