// Smoke test against the local dev server (npm run dev in another shell,
// or this script boots one itself on PORT 8799).
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { createHmac } from "node:crypto";
import http from "node:http";
rmSync("/tmp/hfa-test-store.json", { force: true });
rmSync("/tmp/hfa-test-store2.json", { force: true });

const PORT = 8799;
const base = `http://localhost:${PORT}`;
const child = spawn("node", ["dev-server.js"], {
  env: { ...process.env, PORT: String(PORT), HFA_STORE_FILE: "/tmp/hfa-test-store.json", HFA_RL_QUOTE_PER_HOUR: "9", STRIPE_WEBHOOK_SECRET: "whsec_test_local" },
  stdio: "ignore",
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name} ${extra}`);
  if (!cond) failures++;
}
async function j(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

try {
  await wait(900);

  const services = await j("GET", "/api/services");
  check("catalog 200", services.status === 200);

  const avail = await j("GET", "/api/availability");
  check("availability 200 + shape", avail.status === 200 && avail.data.accepting_new_tasks === true && typeof avail.data.note === "string", `got ${avail.status}/${JSON.stringify(avail.data)}`);
  check("positioning ja", services.data.positioning.ja.includes("身代わりとして、日本の物理タスクを実行するサービス"));
  check("6 services", services.data.services.length === 6);
  check("no lodging service", !services.data.services.some((s) => /hotel|lodging/i.test(s.id)));
  check("not_offered lists captcha", services.data.not_offered.includes("captcha_or_bot_defense_bypass"));

  const q = await j("POST", "/api/quote", {
    service_id: "shopping_proxy",
    area: "Akihabara",
    items: [{ name: "Limited figure", estimated_price_jpy: 12000, quantity: 1 }],
    requester: { agent_name: "smoke-test", contact: "test@example.com" },
  });
  check("quote 201", q.status === 201, `got ${q.status}`);
  const b = q.data.quote.breakdown;
  check("quote fee 2200", b.quote_fee_jpy === 2200);
  check("akihabara handling 16500*1.1 -> 18200", b.handling_fee_jpy === 18200, `got ${b.handling_fee_jpy}`);
  check("total math", b.total_jpy === 12000 + 2200 + 18200 + 1100, `got ${b.total_jpy}`);

  check("quote returns access_token", typeof q.data.access_token === "string" && q.data.access_token.startsWith("hfa_"));
  check("quote has next_action", typeof q.data.next_action === "string" && q.data.next_action.length > 0);

  const noTok = await j("POST", `/api/quotes/${q.data.quote_id}/accept`, {});
  check("accept without token rejected", noTok.data.error === "invalid_access_token", `got ${noTok.data.error}`);

  const accept = await j("POST", `/api/quotes/${q.data.quote_id}/accept`, { access_token: q.data.access_token });
  check("accept -> pending_review", accept.data.status === "pending_review");
  check("accept does not promise", /NOT a confirmation/.test(accept.data.message));
  check("accept next_action present", typeof accept.data.next_action === "string");

  const status = await j("GET", `/api/quotes/${accept.data.task_id}`, null, bearer(q.data.access_token));
  check("task status pending_review", status.data.status === "pending_review");
  const statusNoTok = await j("GET", `/api/quotes/${accept.data.task_id}`);
  check("task status without token rejected", statusNoTok.data.error === "invalid_access_token");

  const msg = await j("POST", "/api/message", { id: accept.data.task_id, access_token: q.data.access_token, message: "Please prioritise the red variant." });
  check("send_message ok", msg.data.message_sent === true);
  const status2 = await j("GET", `/api/quotes/${accept.data.task_id}`, null, bearer(q.data.access_token));
  check("message stored", status2.data.messages_count === 1 && status2.data.messages[0].from === "agent");

  const ev = await j("GET", `/api/tasks/${accept.data.task_id}/evidence`, null, bearer(q.data.access_token));
  check("evidence endpoint", ev.status === 200 && Array.isArray(ev.data.evidence));

  const cancelTaskRes = await j("POST", "/api/cancel", { id: accept.data.task_id, access_token: q.data.access_token, reason: "changed plans" });
  check("cancel task ok", cancelTaskRes.status === 200 && cancelTaskRes.data.status === "cancelled_by_agent");
  const statusAfterCancel = await j("GET", `/api/quotes/${accept.data.task_id}`, null, bearer(q.data.access_token));
  check("cancel persisted", statusAfterCancel.data.status === "cancelled_by_agent");

  const cq = await j("POST", "/api/quote", { service_id: "stock_check", area: "Shibuya", test_mode: true });
  const cqTok = cq.data["access" + "_token"];
  const cancelQuoteRes = await j("POST", "/api/cancel", { id: cq.data.quote_id, access_token: cqTok });
  check("cancel open quote ok", cancelQuoteRes.status === 200 && cancelQuoteRes.data.status === "cancelled");

  const tq = await j("POST", "/api/quote", { service_id: "stock_check", area: "Shibuya", test_mode: true });
  check("test_mode quote", tq.status === 201 && tq.data.test_mode === true);
  const tacc = await j("POST", `/api/quotes/${tq.data.quote_id}/accept`, { access_token: tq.data.access_token });
  check("test_mode accept, no checkout", tacc.data.test_mode === true && tacc.data.checkout_url === null);

  const hotel = await j("POST", "/api/quote", {
    service_id: "phone_reservation",
    details: { venue_type: "hotel", name: "Hotel X" },
  });
  check("hotel reservation rejected", hotel.status === 400 && hotel.data.error === "service_not_offered");

  const rest = await j("POST", "/api/quote", {
    service_id: "phone_reservation",
    details: { venue_type: "restaurant", name: "Sushi-ya", party_size: 2 },
    currency: "USD",
  });
  check("restaurant quote ok", rest.status === 201, `got ${rest.status}`);

  const negPrice = await j("POST", "/api/quote", { service_id: "stock_check", area: "Shibuya", item_price_jpy: -5000 });
  check("negative item_price_jpy rejected", negPrice.status === 400 && negPrice.data.error === "invalid_item_price", `got ${negPrice.status}/${negPrice.data.error}`);
  const negShip = await j("POST", "/api/quote", { service_id: "stock_check", area: "Shibuya", shipping_jpy: -1000 });
  check("negative shipping_jpy rejected", negShip.status === 400 && negShip.data.error === "invalid_shipping", `got ${negShip.status}/${negShip.data.error}`);
  check("usd fx fixed", rest.data.quote.fx && rest.data.quote.fx.jpy_per_usd > 0 && rest.data.quote.fx.total_usd > 0);

  // MCP surface
  const init = await j("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  check("mcp initialize", init.data.result?.serverInfo?.name === "migawari");
  const tools = await j("POST", "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" });
  check("mcp 8 tools", tools.data.result.tools.length === 8, `got ${tools.data.result.tools.length}`);
  check("mcp tools annotated", tools.data.result.tools.every((t) => t.title && t.annotations && typeof t.annotations.readOnlyHint === "boolean"));
  const call = await j("POST", "/mcp", {
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "request_quote", arguments: { service_id: "queueing", hours: 2, area: "Shinjuku" } },
  });
  const callOut = JSON.parse(call.data.result.content[0].text);
  check("mcp queueing 2h handling 19800", callOut.quote.breakdown.handling_fee_jpy === 19800, `got ${callOut.quote?.breakdown?.handling_fee_jpy}`);
  check("mcp quote returns access_token", typeof callOut.access_token === "string");

  // ── rate limit: 8 quote-bucket calls used above, limit is 9 ──
  const rl1 = await j("POST", "/api/quote", { service_id: "stock_check", area: "Shibuya", test_mode: true });
  check("rate limit: 9th quote allowed", rl1.status === 201, `got ${rl1.status}`);
  const rl2 = await j("POST", "/api/quote", { service_id: "stock_check", area: "Shibuya", test_mode: true });
  check("rate limit: 10th quote blocked 429", rl2.status === 429 && rl2.data.error === "rate_limited", `got ${rl2.status}`);
  const batchRl = await j("POST", "/mcp", [
    { jsonrpc: "2.0", id: 41, method: "tools/call", params: { name: "request_quote", arguments: { service_id: "stock_check", area: "Shibuya", test_mode: true } } },
  ]);
  check("mcp batch quote also rate limited", batchRl.status === 429, `got ${batchRl.status}`);

  // ── stripe webhook: bad signature rejected; good signature marks the task paid ──
  const whPayload = JSON.stringify({ id: "evt_test", type: "checkout.session.completed", data: { object: { id: "cs_test_local", amount_total: 33500, metadata: { task_id: accept.data.task_id } } } });
  const whBad = await fetch(base + "/api/stripe/webhook", { method: "POST", headers: { "Content-Type": "application/json", "stripe-signature": "t=1,v1=deadbeef" }, body: whPayload });
  check("webhook bad signature 400", whBad.status === 400, `got ${whBad.status}`);
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", "whsec_test_local").update(`${ts}.${whPayload}`).digest("hex");
  const whOk = await fetch(base + "/api/stripe/webhook", { method: "POST", headers: { "Content-Type": "application/json", "stripe-signature": `t=${ts},v1=${sig}` }, body: whPayload });
  check("webhook good signature 200", whOk.status === 200, `got ${whOk.status}`);
  const paidView = await j("GET", "/api/quotes/" + accept.data.task_id, null, bearer(q.data["access" + "_token"]));
  check("task payment_status paid after webhook", paidView.data.payment_status === "paid", `got ${paidView.data.payment_status}`);

  // ── stablecoin rail fails closed when STABLECOIN_ADDRESS is not configured
  // (this dev server has none). The still-open MCP queueing quote is reused,
  // so no extra quote-bucket call is consumed.
  const scFail = await j("POST", `/api/quotes/${callOut.quote_id}/accept`, { access_token: callOut.access_token, pay_with: "jpyc" });
  check("stablecoin accept fails closed when unconfigured", scFail.data.error === "stablecoin_unavailable", `got ${scFail.data.error}`);

  // ── unit checks of the fail-closed branch + verified token constants ──
  const sc = await import("../lib/stablecoin.js");
  check("unit: rail disabled without address", sc.stablecoinEnabled() === false);
  const noInstr = await sc.buildPaymentInstructions({ token: "jpyc", quote: { breakdown: { total_jpy: 11000 }, expires_at: new Date().toISOString() } });
  check("unit: no instructions when disabled", noInstr === null);
  check("unit: jpyc contract + 18 decimals", sc.tokenConfig("jpyc").contract === "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29" && sc.tokenConfig("jpyc").decimals === 18);
  check("unit: usdc contract + 6 decimals", sc.tokenConfig("usdc").contract === "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" && sc.tokenConfig("usdc").decimals === 6);
} finally {
  child.kill();
}

// ── Phase B: stablecoin rail configured, Polygon RPC stubbed locally ──
const DUMMY_ADDRESS = "0x1111111111111111111111111111111111111111";
const stubState = { latest: 0x100000, logs: [] };
const stub = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const out = { jsonrpc: "2.0", id: 1, result: null };
    try {
      const { method } = JSON.parse(raw);
      if (method === "eth_blockNumber") out.result = `0x${stubState.latest.toString(16)}`;
      else if (method === "eth_getLogs") out.result = stubState.logs;
    } catch { /* keep result null */ }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
  });
});
await new Promise((r) => stub.listen(8796, r));
const child2 = spawn("node", ["dev-server.js"], {
  env: { ...process.env, PORT: "8797", HFA_STORE_FILE: "/tmp/hfa-test-store2.json", STABLECOIN_ADDRESS: DUMMY_ADDRESS, POLYGON_RPC_URL: "http://localhost:8796" },
  stdio: "ignore",
});
const base2 = "http://localhost:8797";
async function j2(method, path, body, headers = {}) {
  const res = await fetch(base2 + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
// Async on purpose: the stub RPC server lives in this process, so a blocking
// spawnSync would freeze it while ops.mjs is calling it.
function ops(...argv) {
  return new Promise((resolve) => {
    const p = spawn("node", ["scripts/ops.mjs", ...argv], {
      env: { ...process.env, HFA_STORE_FILE: "/tmp/hfa-test-store2.json", STABLECOIN_ADDRESS: DUMMY_ADDRESS, POLYGON_RPC_URL: "http://localhost:8796" },
    });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
try {
  await wait(900);

  const sq1 = await j2("POST", "/api/quote", { service_id: "stock_check", area: "Shibuya" });
  check("B: quote for stablecoin test", sq1.status === 201 && sq1.data.quote.breakdown.total_jpy === 11000, `got ${sq1.status}`);
  const sacc1 = await j2("POST", `/api/quotes/${sq1.data.quote_id}/accept`, { access_token: sq1.data.access_token, pay_with: "jpyc" });
  const pi1 = sacc1.data.payment_instructions;
  check("B: jpyc accept returns instructions", sacc1.status === 200 && !!pi1, `got ${sacc1.status}`);
  check("B: instructions shape", pi1.chain === "polygon" && pi1.token === "jpyc" && pi1.address === DUMMY_ADDRESS && pi1.contract === "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29");
  check("B: jpyc amount is total + unique tail", pi1.amount.startsWith("11000.") && pi1.amount !== "11000.000000", `got ${pi1.amount}`);

  const sq2 = await j2("POST", "/api/quote", { service_id: "stock_check", area: "Shibuya" });
  const sacc2 = await j2("POST", `/api/quotes/${sq2.data.quote_id}/accept`, { access_token: sq2.data.access_token, pay_with: "jpyc" });
  check("B: two quotes get different amounts", sacc2.data.payment_instructions.amount !== pi1.amount, `${pi1.amount} vs ${sacc2.data.payment_instructions.amount}`);

  const uq = await j2("POST", "/api/quote", { service_id: "phone_reservation", details: { venue_type: "restaurant", name: "Sushi-ya" }, currency: "USD" });
  const uacc = await j2("POST", `/api/quotes/${uq.data.quote_id}/accept`, { access_token: uq.data.access_token, pay_with: "usdc" });
  const upi = uacc.data.payment_instructions;
  check("B: usdc instructions from fixed-FX total", !!upi && upi.token === "usdc" && upi.amount.startsWith("51.33") && upi.amount !== "51.330000", `got ${upi?.amount}`);

  // A matching on-chain transfer (stubbed) marks the task paid on status poll.
  const padAddr = (a) => `0x${a.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
  stubState.logs = [{
    address: pi1.contract,
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      padAddr("0x2222222222222222222222222222222222222222"),
      padAddr(DUMMY_ADDRESS),
    ],
    data: `0x${BigInt(pi1.amount_units).toString(16).padStart(64, "0")}`,
    blockNumber: `0x${(stubState.latest - 100).toString(16)}`,
    transactionHash: `0x${"ab".repeat(32)}`,
  }];
  const paidB = await j2("GET", `/api/quotes/${sacc1.data.task_id}`, null, bearer(sq1.data.access_token));
  check("B: matching transfer marks task paid (lazy check)", paidB.data.payment_status === "paid", `got ${paidB.data.payment_status}`);

  stubState.logs = [];
  const chk = await ops("check-stablecoin", sacc2.data.task_id);
  check("B: ops check-stablecoin reports unpaid without a transfer", chk.status === 0 && chk.stdout.includes('"paid": false') && chk.stdout.includes("no_matching_transfer_yet"), (chk.stdout || chk.stderr || "").slice(0, 160));

  // Evidence recorded via ops carries the package SHA-256.
  const evAdd = await ops("evidence", sacc1.data.task_id, "--type", "record", "--label", "stub evidence", "--url", "https://example.com/evidence/1");
  check("B: ops evidence prints sha256", evAdd.status === 0 && /sha256: [0-9a-f]{64}/.test(evAdd.stdout), (evAdd.stdout || "").slice(0, 160));
  const evGet = await j2("GET", `/api/tasks/${sacc1.data.task_id}/evidence`, null, bearer(sq1.data.access_token));
  check("B: get_evidence returns items + sha256", Array.isArray(evGet.data.evidence) && evGet.data.evidence.length === 1 && /^[0-9a-f]{64}$/.test(evGet.data.evidence_sha256 || ""), `got ${evGet.data.evidence_sha256}`);

  // Availability toggle round-trip through the ops console.
  const avOff = await ops("availability", "off");
  const availOff = await j2("GET", "/api/availability");
  check("B: availability off via ops", avOff.status === 0 && availOff.data.accepting_new_tasks === false, `got ${JSON.stringify(availOff.data)}`);
  await ops("availability", "on");
  const availOn = await j2("GET", "/api/availability");
  check("B: availability back on", availOn.data.accepting_new_tasks === true);
} finally {
  child2.kill();
  stub.close();
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
