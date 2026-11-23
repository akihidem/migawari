// Shared implementations for the agent tools.
// Used by both the MCP endpoint (api/mcp.js) and the REST endpoints (api/*.js),
// so behaviour is identical on both surfaces.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  DESCRIPTION,
  NOT_OFFERED,
  POSITIONING,
  SERVICE_NAME,
  SERVICES,
  TERMS,
  ZONES,
} from "./catalog.js";
import { computeQuote } from "./pricing.js";
import { getRecord, putRecord, storageBackend } from "./store.js";
import { notifyOperator } from "./notify.js";
import { createCheckout, paymentsEnabled } from "./payments.js";
import { buildPaymentInstructions, checkStablecoinPayment, stablecoinEnabled } from "./stablecoin.js";
import { evidenceView } from "./evidence.js";

const id = (prefix) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;

// Access tokens (2026-11-17, adopted pattern): request_quote returns a token
// once; only its SHA-256 hash is stored. The token authorises accept, decline,
// task status, evidence and messages for that quote/task. Quote summaries stay
// readable by id alone (ids are unguessable).
const newAccessToken = () => `hfa_${randomBytes(24).toString("hex")}`;
const hashToken = (t) => createHash("sha256").update(String(t)).digest("hex");
function tokenOk(record, args = {}) {
  if (!record?.access_token_hash) return true;
  const given = args.access_token || (args.authorization || "").replace(/^Bearer\s+/i, "");
  if (!given) return false;
  const a = Buffer.from(hashToken(given));
  const b = Buffer.from(String(record.access_token_hash));
  return a.length === b.length && timingSafeEqual(a, b);
}
const tokenError = () => ({
  isError: true,
  error: "invalid_access_token",
  message: "This record requires the access_token returned by request_quote. Pass it as access_token (MCP) or Authorization: Bearer <token> (REST).",
});

export function catalogView() {
  return {
    name: SERVICE_NAME,
    positioning: POSITIONING,
    description: DESCRIPTION,
    coverage: "Japan only",
    interface: {
      mcp: "/mcp (streamable HTTP)",
      rest: {
        services: "GET /api/services",
        create_quote: "POST /api/quote",
        quote_status: "GET /api/quotes/{id}",
        accept_quote: "POST /api/quotes/{id}/accept",
        decline_quote: "POST /api/quotes/{id}/decline",
        evidence: "GET /api/tasks/{id}/evidence",
        availability: "GET /api/availability",
        send_message: "POST /api/message {id, access_token, message}",
        cancel: "POST /api/cancel {id, access_token, reason}",
      },
      legal: {
        terms: "/terms",
        privacy: "/privacy",
        tokushoho: "/tokushoho",
      },
    },
    services: SERVICES,
    zones: ZONES,
    not_offered: NOT_OFFERED,
    terms: TERMS,
    storage_backend: storageBackend,
  };
}

export async function listServices() {
  return catalogView();
}

export async function requestQuote(args = {}) {
  const { quote, error, message } = computeQuote(args);
  if (error) return { isError: true, error, message };

  const accessToken = newAccessToken();
  const record = {
    id: id("q"),
    kind: "quote",
    status: "quoted",
    request: args,
    quote,
    test_mode: args.test_mode === true,
    access_token_hash: hashToken(accessToken),
    messages: [],
    created_at: new Date().toISOString(),
  };
  await putRecord("quotes", record.id, record);
  const notification = record.test_mode
    ? { sent: false, reason: "test_mode" }
    : await notifyOperator("quote_requested", {
    id: record.id,
    service_id: quote.service_id,
    total_jpy: quote.breakdown.total_jpy,
    currency: quote.currency,
    requester: args.requester || null,
    });
  return {
    quote_id: record.id,
    status: record.status,
    quote,
    access_token: accessToken,
    test_mode: record.test_mode,
    next_action: record.test_mode
      ? "Test order: call accept_quote with this quote_id and access_token to simulate the flow. No payment is requested in test mode."
      : "To proceed, call accept_quote with this quote_id and access_token. Accepting enters pending_review (not a confirmation). Store the access_token: it is shown only once.",
    notification: notification.sent ? "operator_notified" : "operator_notification_skipped",
    next_steps:
      "To proceed, call accept_quote with this quote_id. Accepting does NOT confirm execution: the request enters pending_review and a human operator confirms or declines it individually. Or call decline_quote to close it — no charge is made unless you accept.",
  };
}

export async function acceptQuote(args = {}) {
  const quoteId = args.quote_id || args.id;
  const record = quoteId ? await getRecord("quotes", quoteId) : null;
  if (!record) return { isError: true, error: "quote_not_found", message: `No quote ${quoteId}` };
  if (!tokenOk(record, args)) return tokenError();
  if (record.status !== "quoted") {
    return {
      isError: true,
      error: "quote_not_open",
      message: `Quote ${quoteId} is ${record.status} and cannot be accepted.`,
    };
  }
  if (new Date(record.quote.expires_at) < new Date()) {
    record.status = "expired";
    await putRecord("quotes", record.id, record);
    return { isError: true, error: "quote_expired", message: `Quote ${quoteId} expired at ${record.quote.expires_at}. Request a new quote.` };
  }

  // Payment rail selection. "card" (Stripe) is the default; "jpyc" / "usdc"
  // choose stablecoins on Polygon. An unconfigured stablecoin rail fails
  // closed here — before any task exists — with a clean error.
  const payWith = String(args.pay_with || "card").toLowerCase();
  if (!["card", "jpyc", "usdc"].includes(payWith)) {
    return { isError: true, error: "invalid_pay_with", message: "pay_with must be one of: card, jpyc, usdc." };
  }
  const wantsStablecoin = payWith === "jpyc" || payWith === "usdc";
  if (wantsStablecoin && record.test_mode !== true && !stablecoinEnabled()) {
    return {
      isError: true,
      error: "stablecoin_unavailable",
      message: "Stablecoin payments (JPYC / USDC on Polygon) are not available yet: no receiving address is configured. Pay by card instead, or ask the operator.",
    };
  }

  const task = {
    id: id("t"),
    kind: "task",
    quote_id: record.id,
    service_id: record.quote.service_id,
    status: "pending_review", // ← 2026-11-16 decision: never confirmed at accept time
    request: record.request,
    quote: record.quote,
    evidence: { items: [], sha256: null },
    test_mode: record.test_mode === true,
    access_token_hash: record.access_token_hash || null,
    messages: [],
    created_at: new Date().toISOString(),
    history: [{ at: new Date().toISOString(), event: "accepted_by_agent_pending_review" }],
  };
  record.status = "accepted_pending_review";
  record.task_id = task.id;
  await putRecord("quotes", record.id, record);
  await putRecord("tasks", task.id, task);
  const notification = await notifyOperator("quote_accepted_pending_review", {
    id: task.id,
    quote_id: record.id,
    service_id: task.service_id,
    total_jpy: task.quote.breakdown.total_jpy,
    requester: record.request.requester || null,
  });

  if (!task.test_mode && wantsStablecoin) {
    const instructions = await buildPaymentInstructions({ token: payWith, quote: task.quote });
    if (instructions) {
      instructions.payment_id = `sc_${task.id}`;
      task.payment_instructions = instructions;
      task.payment = {
        status: "unpaid",
        via: "stablecoin",
        token: instructions.token,
        chain: instructions.chain,
        amount: instructions.amount,
        amount_jpy: task.quote.breakdown.total_jpy,
        currency: task.quote.currency || "JPY",
      };
      await putRecord("payments", instructions.payment_id, { task_id: task.id });
      await putRecord("tasks", task.id, task);
    }
  } else if (!task.test_mode && paymentsEnabled()) {
    const checkout = await createCheckout({
      amountJpy: task.quote.breakdown.total_jpy,
      description: `Migawari — ${task.service_id} (task ${task.id})`,
      taskId: task.id,
    });
    if (checkout) {
      task.checkout_url = checkout.url;
      task.payment = {
        status: "unpaid",
        checkout_session_id: checkout.sessionId,
        amount_jpy: task.quote.breakdown.total_jpy,
        currency: task.quote.currency || "JPY",
      };
      await putRecord("payments", checkout.sessionId, { task_id: task.id });
      await putRecord("tasks", task.id, task);
    }
  }
  return {
    task_id: task.id,
    quote_id: record.id,
    status: "pending_review",
    test_mode: task.test_mode,
    checkout_url: task.checkout_url || null,
    payment_instructions: task.payment_instructions || null,
    next_action: task.test_mode
      ? "Test order received. Poll get_task_status with the task_id and access_token; the operator will simulate progress. No payment is involved."
      : task.payment_instructions
        ? `Send exactly ${task.payment_instructions.amount} ${task.payment_instructions.symbol} on Polygon to ${task.payment_instructions.address} (see payment_instructions), then poll get_task_status with the task_id and access_token — the payment is detected on-chain automatically once confirmed. Payment does not itself confirm execution: the operator still reviews every request.`
        : task.checkout_url
          ? "Pay the total via checkout_url, then poll get_task_status with the task_id and access_token. Payment does not itself confirm execution: the operator still reviews every request."
          : "Poll get_task_status with the task_id and access_token for the operator's decision. Payment instructions follow once the operator confirms.",
    notification: notification.sent ? "operator_notified" : "operator_notification_skipped",
    message:
      "Received. Your request is now pending operator review. This is NOT a confirmation of execution: during the launch phase a human operator reviews every request individually and confirms or declines it. No start time, same-day handling, or completion time is promised. Poll get_task_status with the task_id for the decision.",
  };
}

export async function declineQuote(args = {}) {
  const quoteId = args.quote_id || args.id;
  const record = quoteId ? await getRecord("quotes", quoteId) : null;
  if (!record) return { isError: true, error: "quote_not_found", message: `No quote ${quoteId}` };
  if (!tokenOk(record, args)) return tokenError();
  if (record.status !== "quoted") {
    return {
      isError: true,
      error: "quote_not_open",
      message: `Quote ${quoteId} is ${record.status} and cannot be declined.`,
    };
  }
  record.status = "declined";
  record.decline_reason = args.reason || null;
  record.declined_at = new Date().toISOString();
  await putRecord("quotes", record.id, record);
  return {
    quote_id: record.id,
    status: "declined",
    next_action: "Nothing further is needed. Request a new quote any time.",
    note: "No charge was made for this quote; no handling fee applies.",
  };
}

const NEXT_ACTION_BY_STATUS = {
  quoted: "Call accept_quote with the quote_id and access_token to proceed, or decline_quote to close it.",
  accepted_pending_review: "The request is with the operator. Poll get_task_status on the task_id.",
  pending_review: "Wait for the operator's decision; poll get_task_status. You can also send_message to add information.",
  confirmed: "The operator confirmed execution. Follow get_task_status for progress and evidence.",
  in_progress: "The task is being executed. Poll get_task_status; evidence is attached as it is produced.",
  completed: "The task is complete. Call get_evidence for the evidence package.",
  failed: "The task could not be completed. Call get_evidence: evidence is returned even for failed tasks. You can also send_message to discuss alternatives.",
  declined_by_operator: "The operator declined this request after review. Nothing further is needed; you may request a new quote with adjusted details.",
  cancelled: "This quote was cancelled. Request a new quote any time.",
  cancelled_by_agent: "This task was cancelled at your request. If payment was already made, the operator will contact you about a refund via the record messages.",
  declined: "This request was declined. Nothing further is needed.",
  expired: "This quote expired. Request a new quote.",
};

function statusView(record, full = false) {
  if (!record) return null;
  const messages = record.messages || [];
  const msgView = full ? messages : messages.slice(-3);
  if (record.kind === "task") {
    const history = record.history || [];
    return {
      id: record.id,
      kind: "task",
      quote_id: record.quote_id,
      service_id: record.service_id,
      status: record.status,
      payment_status: record.payment?.status || (record.test_mode ? "test_mode" : "not_required"),
      test_mode: record.test_mode === true,
      checkout_url: record.checkout_url || null,
      payment_instructions: record.payment_instructions || null,
      created_at: record.created_at,
      history: full ? history : history.slice(-1),
      history_count: history.length,
      messages: msgView,
      messages_count: messages.length,
      next_action: NEXT_ACTION_BY_STATUS[record.status] || "Poll get_task_status for updates.",
      status_explanation:
        record.status === "pending_review"
          ? "A human operator is reviewing this request. Execution is not confirmed yet, and no timeline is promised. The status will change to confirmed or declined after review."
          : undefined,
    };
  }
  return {
    id: record.id,
    kind: "quote",
    status: record.status,
    task_id: record.task_id || null,
    service_id: record.quote.service_id,
    total_jpy: record.quote.breakdown.total_jpy,
    expires_at: record.quote.expires_at,
    test_mode: record.test_mode === true,
    messages: msgView,
    messages_count: messages.length,
    next_action: NEXT_ACTION_BY_STATUS[record.status] || "Poll get_task_status for updates.",
    created_at: record.created_at,
  };
}

export async function getTaskStatus(args = {}) {
  const theId = args.id || args.task_id || args.quote_id;
  if (!theId) return { isError: true, error: "id_required", message: "Provide id (task_id or quote_id)." };
  const kind = theId.startsWith("t_") ? "tasks" : "quotes";
  let record = await getRecord(kind, theId);
  let recordKind = kind;
  if (!record) {
    record = await getRecord(kind === "tasks" ? "quotes" : "tasks", theId);
    recordKind = kind === "tasks" ? "quotes" : "tasks";
    if (!record) return { isError: true, error: "not_found", message: `No record for ${theId}` };
  }
  // Tasks are token-protected; quote summaries stay readable by id alone.
  if (record.kind === "task" && !tokenOk(record, args)) return tokenError();
  // Lazy stablecoin verification: an unpaid live task with a stablecoin
  // assignment is checked against the chain whenever its status is polled.
  // RPC failures must never break a status read, so they are swallowed.
  if (
    record.kind === "task" &&
    record.test_mode !== true &&
    record.payment?.status !== "paid" &&
    record.payment_instructions
  ) {
    try {
      await checkStablecoinPayment(record);
    } catch {
      /* chain unreachable right now — the next poll retries */
    }
  }
  return statusView(record, args.full === true);
}

export async function sendMessage(args = {}) {
  const theId = args.id || args.task_id || args.quote_id;
  const text = typeof args.message === "string" ? args.message.trim() : "";
  if (!theId) return { isError: true, error: "id_required", message: "Provide id (task_id or quote_id)." };
  if (!text) return { isError: true, error: "message_required", message: "Provide message text (1-2000 chars)." };
  const kind = theId.startsWith("t_") ? "tasks" : "quotes";
  let record = await getRecord(kind, theId);
  let recordKind = kind;
  if (!record) {
    record = await getRecord(kind === "tasks" ? "quotes" : "tasks", theId);
    recordKind = kind === "tasks" ? "quotes" : "tasks";
    if (!record) return { isError: true, error: "not_found", message: `No record for ${theId}` };
  }
  if (!tokenOk(record, args)) return tokenError();
  record.messages = record.messages || [];
  if (record.messages.length >= 200) {
    return { isError: true, error: "message_limit_reached", message: "This record already holds 200 messages. Ask the operator to continue in a new request if needed." };
  }
  record.messages.push({ from: "agent", text: text.slice(0, 2000), at: new Date().toISOString() });
  await putRecord(recordKind, record.id, record);
  await notifyOperator("agent_message", { id: record.id, kind: record.kind, preview: text.slice(0, 120) });
  return {
    id: record.id,
    message_sent: true,
    messages_count: record.messages.length,
    next_action: "Your message is stored on the record and notified to the operator. Poll get_task_status for any reply in messages.",
  };
}


export async function cancelTask(args = {}) {
  const theId = args.id || args.task_id || args.quote_id;
  if (!theId) return { isError: true, error: "id_required", message: "Provide id (task_id or quote_id)." };
  const kind = theId.startsWith("t_") ? "tasks" : "quotes";
  let record = await getRecord(kind, theId);
  let recordKind = kind;
  if (!record) {
    record = await getRecord(kind === "tasks" ? "quotes" : "tasks", theId);
    recordKind = kind === "tasks" ? "quotes" : "tasks";
    if (!record) return { isError: true, error: "not_found", message: `No record for ${theId}` };
  }
  if (!tokenOk(record, args)) return tokenError();
  const reason = typeof args.reason === "string" ? args.reason.slice(0, 500) : null;
  const now = new Date().toISOString();
  if (record.kind === "quote") {
    if (record.status !== "quoted") {
      return { isError: true, error: "not_cancellable", message: `Quote ${theId} is ${record.status}. To stop an accepted request, cancel its task instead.` };
    }
    record.status = "cancelled";
    record.cancel_reason = reason;
    record.cancelled_at = now;
    await putRecord(recordKind, record.id, record);
    return { quote_id: record.id, status: "cancelled", next_action: "Nothing further is needed. Request a new quote any time.", note: "Per the fee model, a quote fee already charged (JPY 2,200) is non-refundable; if you paid for a task, the operator follows up about a refund of the remainder via the record messages." };
  }
  const cancellable = ["pending_review", "confirmed", "in_progress"];
  if (!cancellable.includes(record.status)) {
    return { isError: true, error: "not_cancellable", message: `Task ${theId} is ${record.status} and cannot be cancelled.` };
  }
  record.status = "cancelled_by_agent";
  record.cancel_reason = reason;
  record.cancelled_at = now;
  record.history = record.history || [];
  record.history.push({ at: now, event: "cancelled_by_agent", reason });
  await putRecord(recordKind, record.id, record);
  await notifyOperator("task_cancelled_by_agent", { id: record.id, quote_id: record.quote_id, reason });
  return {
    task_id: record.id,
    status: "cancelled_by_agent",
    next_action: "The task is stopped. If payment was already made, the operator will follow up about a refund via the record messages (poll get_task_status).",
  };
}

export async function getEvidence(args = {}) {
  const taskId = args.task_id || args.id;
  const task = taskId ? await getRecord("tasks", taskId) : null;
  if (!task) return { isError: true, error: "task_not_found", message: `No task ${taskId}` };
  if (!tokenOk(task, args)) return tokenError();
  const ev = evidenceView(task);
  return {
    task_id: task.id,
    status: task.status,
    next_action: ev.items.length > 0 ? "Review the evidence. If anything is missing, send_message to the operator." : "No evidence yet. Poll get_task_status; evidence is attached as the task is executed.",
    evidence: ev.items,
    evidence_sha256: ev.sha256,
    note:
      ev.items.length > 0
        ? "Evidence is returned for every task, including failed ones. evidence_sha256 is the SHA-256 of the canonical evidence package ({task_id, items:[{type, url, label, at}]}); recompute it to verify the package was not altered."
        : "No evidence yet. Evidence (photos, records, tracking numbers) is attached as the task is executed, and is returned even if the task fails.",
  };
}

// ── MCP tool definitions ────────────────────────────────────────────────────
export const TOOL_DEFS = [
  {
    name: "list_services",
    title: "List services",
    annotations: { readOnlyHint: true, destructiveHint: false },
    description:
      "List the Migawari catalog: services, prices, zones, terms, and what is NOT offered. Migawari stands in for AI agents in Japan, executing physical tasks with humans (AIエージェントの身代わりとして、日本の物理タスクを実行するサービス). Use it when you need a human in Japan to: buy a limited-edition or in-store-only item, check in-store stock (e.g. in Akihabara), photograph a shop, display or place, book a restaurant by phone in Japanese, stand in line / queue for a product launch, or receive and forward a package. Coverage: Japan only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "request_quote",
    title: "Request a quote",
    annotations: { readOnlyHint: false, destructiveHint: false },
    description:
      "Request an instant total quote for a physical task in Japan: shopping proxy (including limited-edition and in-store-only items), in-store stock checks, on-site photo capture, restaurant phone reservations in Japanese, queueing / standing in line, or package forwarding. The total is itemised (item price + quote fee JPY 2,200 + handling fee + shipping). Requesting a quote is free: the quote fee (JPY 2,200) is charged as part of the total when you accept, and is non-refundable once charged. Getting a quote does not reserve execution: accepting a quote only places the request in pending_review. The response includes an access_token shown only once: store it, it authorises accept/decline/status/evidence/messages for this quote.",
    inputSchema: {
      type: "object",
      properties: {
        service_id: {
          type: "string",
          enum: SERVICES.map((s) => s.id),
          description: "Catalog service id (see list_services).",
        },
        area: { type: "string", description: "Area / city in Japan, e.g. 'Akihabara', 'Ginza', 'Shibuya'." },
        items: {
          type: "array",
          description: "For shopping_proxy: items to buy.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              estimated_price_jpy: { type: "number", description: "Tax-inclusive estimate in JPY." },
              quantity: { type: "number" },
              url: { type: "string" },
              notes: { type: "string" },
            },
            required: ["name", "estimated_price_jpy"],
          },
        },
        item_price_jpy: { type: "number", description: "Alternative to items[]: total item price, tax incl., JPY." },
        shipping_jpy: { type: "number", description: "Optional shipping override in JPY; defaults apply otherwise." },
        hours: { type: "number", description: "For queueing: hours (minimum 1)." },
        currency: { type: "string", enum: ["JPY", "USD"], description: "USD totals use the FX rate fixed at quote time." },
        details: {
          type: "object",
          description:
            "Service-specific details: store name/address, target items, photo subjects, restaurant name + party size + desired time (phone_reservation; venue_type must be 'restaurant'), queue location, package sender/destination, etc.",
          additionalProperties: true,
        },
        requester: {
          type: "object",
          description: "Who is asking: agent name and a contact the operator can reply to.",
          properties: {
            agent_name: { type: "string" },
            contact: { type: "string" },
          },
          additionalProperties: true,
        },
        notes: { type: "string" },
        test_mode: { type: "boolean", description: "If true, this is a test order: the flow is simulated and no payment is requested." },
      },
      required: ["service_id"],
    },
  },
  {
    name: "accept_quote",
    title: "Accept a quote",
    annotations: { readOnlyHint: false, destructiveHint: false },
    description:
      "Accept a quote. IMPORTANT: this does not confirm execution. The request enters pending_review; a human operator confirms or declines each request individually during the launch phase. No timeline is promised. Poll get_task_status for the outcome. Payment: pay_with 'card' (default, Stripe) or 'jpyc' / 'usdc' to pay in stablecoins on Polygon — the response then carries payment_instructions with the exact amount (including a unique fractional tail that identifies your transfer) and the receiving address.",
    inputSchema: {
      type: "object",
      properties: {
        quote_id: { type: "string" },
        access_token: { type: "string", description: "The access_token returned by request_quote." },
        pay_with: { type: "string", enum: ["card", "jpyc", "usdc"], description: "Payment rail: card (Stripe, default), or jpyc / usdc stablecoins on Polygon." },
      },
      required: ["quote_id", "access_token"],
    },
  },
  {
    name: "decline_quote",
    title: "Decline a quote",
    annotations: { readOnlyHint: false, destructiveHint: true },
    description:
      "Decline a quote and close it. Declining a quote you have not accepted is free of charge; no handling fee applies.",
    inputSchema: {
      type: "object",
      properties: {
        quote_id: { type: "string" },
        reason: { type: "string" },
        access_token: { type: "string", description: "The access_token returned by request_quote." },
      },
      required: ["quote_id", "access_token"],
    },
  },
  {
    name: "get_task_status",
    title: "Get task status",
    annotations: { readOnlyHint: true, destructiveHint: false },
    description: "Get the status of a quote or task by id (quote_id q_… or task_id t_…). Brief by default; pass full: true for the complete record. For tasks, the access_token is required. To leave a note for the operator, use send_message.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        access_token: { type: "string", description: "Required for task ids; the token returned by request_quote." },
        full: { type: "boolean" },
      },
      required: ["id"],
    },
  },
  {
    name: "send_message",
    title: "Send a message to the operator",
    annotations: { readOnlyHint: false, destructiveHint: false },
    description: "Send a message to the human operator about a quote or task. The operator's replies appear in the messages of get_task_status.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        access_token: { type: "string" },
        message: { type: "string", description: "Plain text, 1-2000 characters." },
      },
      required: ["id", "access_token", "message"],
    },
  },
  {
    name: "get_evidence",
    title: "Get task evidence",
    annotations: { readOnlyHint: true, destructiveHint: false },
    description:
      "Get evidence attached to a task (photos, records, tracking numbers). Evidence is returned even for failed tasks.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string" }, access_token: { type: "string", description: "The access_token returned by request_quote." } },
      required: ["task_id", "access_token"],
    },
  },
  {
    name: "cancel_task",
    title: "Cancel a quote or task",
    annotations: { readOnlyHint: false, destructiveHint: true },
    description:
      "Cancel a quote that has not been accepted yet, or a task that is in pending_review, confirmed, or in_progress. Cancelling an unaccepted quote is free. If payment was already made for a task, the quote fee (JPY 2,200) remains charged per the fee model, and the operator follows up about a refund of the remainder via the record messages.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "quote_id (q_…) or task_id (t_…). " },
        access_token: { type: "string", description: "The access_token returned by request_quote." },
        reason: { type: "string" },
      },
      required: ["id", "access_token"],
    },
  },
];

export const TOOL_HANDLERS = {
  list_services: listServices,
  request_quote: requestQuote,
  accept_quote: acceptQuote,
  decline_quote: declineQuote,
  get_task_status: getTaskStatus,
  get_evidence: getEvidence,
  send_message: sendMessage,
  cancel_task: cancelTask,
};
