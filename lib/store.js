// Ledger storage adapter.
// Production: Vercel KV / Upstash Redis via REST (KV_REST_API_URL + KV_REST_API_TOKEN).
// Fallback: a single JSON file (local dev: app/data/store.json; on Vercel without KV:
// /tmp — ephemeral, so configure KV before real traffic; see README).
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const kvUrl = process.env.KV_REST_API_URL;
const kvToken = process.env.KV_REST_API_TOKEN;
const useKv = Boolean(kvUrl && kvToken);

const localFile =
  process.env.HFA_STORE_FILE ||
  (process.env.VERCEL
    ? "/tmp/hfa-store.json"
    : path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "store.json"));

async function kvCommand(cmd) {
  const res = await fetch(kvUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${kvToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error(`KV error: ${res.status}`);
  const data = await res.json();
  return data.result;
}

async function readFileStore() {
  try {
    const raw = await fs.readFile(localFile, "utf8");
    const parsed = JSON.parse(raw);
    for (const k of ["quotes", "tasks", "payments", "settings"]) {
      if (!parsed[k] || typeof parsed[k] !== "object") parsed[k] = {};
    }
    if (!parsed.counters) parsed.counters = {};
    return parsed;
  } catch {
    return { quotes: {}, tasks: {}, payments: {}, settings: {}, counters: {} };
  }
}

async function writeFileStore(store) {
  await fs.mkdir(path.dirname(localFile), { recursive: true });
  await fs.writeFile(localFile, JSON.stringify(store, null, 2));
}

export const storageBackend = useKv ? "vercel-kv" : "local-file";

export async function putRecord(kind, id, record) {
  if (useKv) {
    await kvCommand(["SET", `hfa:${kind}:${id}`, JSON.stringify(record)]);
    return;
  }
  const store = await readFileStore();
  store[kind][id] = record;
  await writeFileStore(store);
}

export async function getRecord(kind, id) {
  if (useKv) {
    const raw = await kvCommand(["GET", `hfa:${kind}:${id}`]);
    return raw ? JSON.parse(raw) : null;
  }
  const store = await readFileStore();
  return store[kind][id] || null;
}

export async function listRecords(kind) {
  if (useKv) {
    const out = [];
    let cursor = "0";
    do {
      const res = await kvCommand(["SCAN", cursor, "MATCH", `hfa:${kind}:*`, "COUNT", "100"]);
      cursor = res[0];
      for (const key of res[1]) {
        const raw = await kvCommand(["GET", key]);
        if (raw) out.push(JSON.parse(raw));
      }
    } while (cursor !== "0");
    return out;
  }
  const store = await readFileStore();
  return Object.values(store[kind] || {});
}

// Fixed-window counter used by the rate limiter. Returns the new count.
export async function incrementCounter(key, windowSec) {
  if (useKv) {
    const n = await kvCommand(["INCR", `hfa:counter:${key}`]);
    if (n === 1) await kvCommand(["EXPIRE", `hfa:counter:${key}`, String(windowSec)]);
    return n;
  }
  const store = await readFileStore();
  const nowMs = Date.now();
  const cur = store.counters[key];
  if (!cur || cur.exp <= nowMs) {
    store.counters[key] = { n: 1, exp: nowMs + windowSec * 1000 };
    await writeFileStore(store);
    return 1;
  }
  cur.n += 1;
  await writeFileStore(store);
  return cur.n;
}
