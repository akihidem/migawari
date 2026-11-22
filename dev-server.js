// Local dev server: mounts the same handlers as Vercel would.
//   npm run dev   → http://localhost:8787
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8787);

const routes = [
  { pattern: /^\/mcp$/, load: () => import("./api/mcp.js") },
  { pattern: /^\/api\/mcp$/, load: () => import("./api/mcp.js") },
  { pattern: /^\/api\/services$/, load: () => import("./api/services.js") },
  { pattern: /^\/catalog$/, load: () => import("./api/services.js") },
  { pattern: /^\/api\/quote$/, load: () => import("./api/quote.js") },
  { pattern: /^\/api\/message$/, load: () => import("./api/message.js") },
  { pattern: /^\/api\/cancel$/, load: () => import("./api/cancel.js") },
  { pattern: /^\/api\/stripe\/webhook$/, load: () => import("./api/stripe/webhook.js") },
  { pattern: /^\/api\/health$/, load: () => import("./api/health.js") },
  { pattern: /^\/api\/availability$/, load: () => import("./api/availability.js") },
  {
    pattern: /^\/api\/quotes\/([^/]+)$/,
    load: () => import("./api/quotes/[id].js"),
    param: "id",
  },
  {
    pattern: /^\/api\/quotes\/([^/]+)\/accept$/,
    load: () => import("./api/quotes/[id]/accept.js"),
    param: "id",
  },
  {
    pattern: /^\/api\/quotes\/([^/]+)\/decline$/,
    load: () => import("./api/quotes/[id]/decline.js"),
    param: "id",
  },
  {
    pattern: /^\/api\/tasks\/([^/]+)\/evidence$/,
    load: () => import("./api/tasks/[id]/evidence.js"),
    param: "id",
  },
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  for (const r of routes) {
    const m = url.pathname.match(r.pattern);
    if (m) {
      req.query = Object.fromEntries(url.searchParams);
      if (r.param) req.query[r.param] = decodeURIComponent(m[1]);
      const mod = await r.load();
      return mod.default(req, res);
    }
  }
  // static from public/
  const file = url.pathname === "/" ? "/index.html" : url.pathname;
  const safe = path.normalize(path.join(root, "public", file));
  if (safe.startsWith(path.join(root, "public"))) {
    try {
      const data = await fs.readFile(safe);
      const type = safe.endsWith(".html")
        ? "text/html; charset=utf-8"
        : safe.endsWith(".json")
          ? "application/json"
          : "text/plain; charset=utf-8";
      res.writeHead(200, { "Content-Type": type });
      return res.end(data);
    } catch { /* fall through */ }
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found", path: url.pathname }));
});

server.listen(port, () => console.log(`hands-for-agents dev server on http://localhost:${port}`));
