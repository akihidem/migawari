#!/usr/bin/env node
// Japan Hands — operator console (window use only; not exposed over HTTP).
//
// Usage:
//   node scripts/ops.mjs list                     # pending_review tasks + open quotes
//   node scripts/ops.mjs show <id>                # full record (quote or task)
//   node scripts/ops.mjs confirm <task_id> [--note "text"]   (refused while payment.status is unpaid)
//   node scripts/ops.mjs paid <task_id> [--note "text"]      (record an out-of-band payment manually)
//   node scripts/ops.mjs decline <task_id> --reason "text"
//   node scripts/ops.mjs status <task_id> <in_progress|completed|failed> [--note "text"]
//   node scripts/ops.mjs evidence <task_id> --type photo|record|tracking|note --url <url> [--label "text"]
//   node scripts/ops.mjs reply <id> --message "text"
//   node scripts/ops.mjs check-stablecoin <task_id>   (verify a JPYC/USDC payment on Polygon now)
//   node scripts/ops.mjs availability [on|off]        (show or toggle accepting new tasks)
//
// Storage follows lib/store.js: Vercel KV when KV_REST_API_URL/KV_REST_API_TOKEN
// are set (load them from .env.local — `vercel env pull`), else the local file.
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const raw = await fs.readFile(path.join(root, ".env.local"), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* no .env.local: rely on the environment */ }

const { getRecord, putRecord, listRecords, storageBackend } = await import("../lib/store.js");
const { attachEvidence } = await import("../lib/evidence.js");
const { checkStablecoinPayment } = await import("../lib/stablecoin.js");

const now = () => new Date().toISOString();
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};

async function loadAny(id) {
  const kind = id.startsWith("t_") ? "tasks" : "quotes";
  let rec = await getRecord(kind, id);
  if (rec) return [kind, rec];
  const other = kind === "tasks" ? "quotes" : "tasks";
  rec = await getRecord(other, id);
  return rec ? [other, rec] : [null, null];
}

async function loadTask(id) {
  const rec = await getRecord("tasks", id);
  if (!rec) { console.error(`no task ${id}`); process.exit(1); }
  return rec;
}

function touch(rec, event, extra = {}) {
  rec.history = rec.history || [];
  rec.history.push({ at: now(), event, ...extra });
  rec.updated_at = now();
}

switch (cmd) {
  case "list": {
    const tasks = await listRecords("tasks");
    const quotes = await listRecords("quotes");
    const pending = tasks.filter((t) => t.status === "pending_review");
    const active = tasks.filter((t) => ["confirmed", "in_progress"].includes(t.status));
    const open = quotes.filter((q) => q.status === "quoted");
    console.log(`backend: ${storageBackend}`);
    console.log(`\n== pending_review (${pending.length}) ==`);
    for (const t of pending) console.log(`${t.id}  ${t.service_id}  ¥${t.quote.breakdown.total_jpy}  pay:${t.payment?.status || (t.test_mode ? "test" : "n/a")}  ${t.created_at}${t.test_mode ? "  [test]" : ""}`);
    console.log(`\n== active (${active.length}) ==`);
    for (const t of active) console.log(`${t.id}  ${t.status}  ${t.service_id}  ${t.created_at}${t.test_mode ? "  [test]" : ""}`);
    console.log(`\n== open quotes (${open.length}) ==`);
    for (const q of open) console.log(`${q.id}  ${q.quote.service_id}  ¥${q.quote.breakdown.total_jpy}  expires ${q.quote.expires_at}${q.test_mode ? "  [test]" : ""}`);
    break;
  }
  case "show": {
    const [, rec] = await loadAny(args[1]);
    if (!rec) { console.error(`no record ${args[1]}`); process.exit(1); }
    console.log(JSON.stringify(rec, null, 2));
    break;
  }
  case "confirm": {
    const task = await loadTask(args[1]);
    if (task.status !== "pending_review") { console.error(`task is ${task.status}, not pending_review`); process.exit(1); }
    if (task.payment && task.payment.status !== "paid") {
      console.error(`payment gate: task is unpaid (payment.status=${task.payment.status}). Work starts only after payment is confirmed — wait for the Stripe webhook, or record an out-of-band payment with: ops.mjs paid ${task.id} --note "..."`);
      process.exit(1);
    }
    task.status = "confirmed";
    touch(task, "confirmed_by_operator");
    const note = flag("note");
    if (note) { task.messages = task.messages || []; task.messages.push({ from: "operator", text: note, at: now() }); }
    await putRecord("tasks", task.id, task);
    console.log(`confirmed ${task.id}`);
    break;
  }
  case "decline": {
    const task = await loadTask(args[1]);
    if (task.status !== "pending_review") { console.error(`task is ${task.status}, not pending_review`); process.exit(1); }
    const reason = flag("reason") || "Declined after operator review.";
    task.status = "declined_by_operator";
    task.decline_reason = reason;
    touch(task, "declined_by_operator", { reason });
    task.messages = task.messages || [];
    task.messages.push({ from: "operator", text: reason, at: now() });
    await putRecord("tasks", task.id, task);
    console.log(`declined ${task.id}: ${reason}`);
    break;
  }
  case "status": {
    const task = await loadTask(args[1]);
    const next = args[2];
    if (!["in_progress", "completed", "failed"].includes(next)) { console.error("status must be in_progress|completed|failed"); process.exit(1); }
    task.status = next;
    touch(task, `status_${next}`);
    const note = flag("note");
    if (note) { task.messages = task.messages || []; task.messages.push({ from: "operator", text: note, at: now() }); }
    await putRecord("tasks", task.id, task);
    console.log(`${task.id} -> ${next}`);
    break;
  }
  case "evidence": {
    const task = await loadTask(args[1]);
    const type = flag("type") || "note";
    const url = flag("url");
    const label = flag("label") || "";
    if (!url && !label) { console.error("evidence needs --url or --label"); process.exit(1); }
    const item = { type, url: url || null, label, at: now() };
    attachEvidence(task, item);
    touch(task, "evidence_added", { type });
    await putRecord("tasks", task.id, task);
    console.log(`evidence added to ${task.id}: ${JSON.stringify(item)}`);
    console.log(`evidence package sha256: ${task.evidence.sha256}`);
    break;
  }
  case "paid": {
    const task = await loadTask(args[1]);
    const note = flag("note") || "Payment recorded manually by operator.";
    task.payment = { ...(task.payment || {}), status: "paid", paid_at: now(), via: "manual", note };
    touch(task, "payment_recorded_manual", { note });
    await putRecord("tasks", task.id, task);
    console.log(`payment marked paid (manual): ${task.id}`);
    break;
  }
  case "check-stablecoin": {
    const task = await loadTask(args[1]);
    try {
      const out = await checkStablecoinPayment(task);
      console.log(JSON.stringify(out, null, 2));
    } catch (e) {
      console.error(`stablecoin check failed: ${e.message}`);
      process.exit(1);
    }
    break;
  }
  case "availability": {
    const mode = args[1];
    if (mode === "on" || mode === "off") {
      const rec = {
        accepting_new_tasks: mode === "on",
        note: mode === "on" ? "Accepting new tasks." : "Temporarily not accepting new tasks. Existing tasks are unaffected.",
        updated_at: now(),
      };
      await putRecord("settings", "availability", rec);
      console.log(`availability -> ${mode} (accepting_new_tasks: ${rec.accepting_new_tasks})`);
    } else {
      const rec = await getRecord("settings", "availability");
      console.log(JSON.stringify(rec || { accepting_new_tasks: true, note: "Accepting new tasks. (default — no settings record)" }, null, 2));
    }
    break;
  }
  case "reply": {
    const [kind, rec] = await loadAny(args[1]);
    if (!rec) { console.error(`no record ${args[1]}`); process.exit(1); }
    const text = flag("message");
    if (!text) { console.error("reply needs --message"); process.exit(1); }
    rec.messages = rec.messages || [];
    rec.messages.push({ from: "operator", text, at: now() });
    rec.updated_at = now();
    await putRecord(kind, rec.id, rec);
    console.log(`replied on ${rec.id} (${rec.messages.length} messages)`);
    break;
  }
  default:
    console.log("commands: list | show <id> | confirm <task_id> [--note] | paid <task_id> [--note] | decline <task_id> --reason | status <task_id> <in_progress|completed|failed> [--note] | evidence <task_id> --type --url [--label] | reply <id> --message | check-stablecoin <task_id> | availability [on|off]");
}
