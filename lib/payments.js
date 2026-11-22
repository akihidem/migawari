// Stripe Checkout link creation (adopted pattern, 2026-11-17).
// Active only when STRIPE_SECRET_KEY is set in the environment; without it the
// service runs quote-only and no checkout_url is issued. Zero-dependency:
// plain fetch against api.stripe.com with form encoding.
import { putRecord } from "./store.js";
import { notifyOperator } from "./notify.js";

const SITE = process.env.HFA_SITE_URL || "https://japan-hands.vercel.app";

// The single internal "mark paid" path. The Stripe webhook performs exactly
// these steps inline (status flip + history entry + operator notification);
// the stablecoin checker calls this helper so both rails land identically.
// Mutates the task, persists it, and notifies the operator.
export async function recordPaymentReceived(task, { via, amountTotal = null, paymentExtra = {} }) {
  const now = new Date().toISOString();
  task.payment = {
    ...(task.payment || {}),
    ...paymentExtra,
    status: "paid",
    paid_at: now,
    amount_total: amountTotal ?? task.payment?.amount_jpy ?? null,
    via,
  };
  task.history = [...(task.history || []), { at: now, event: "payment_received", by: via }];
  await putRecord("tasks", task.id, task);
  await notifyOperator("payment_received", { id: task.id, amount_total: amountTotal });
  return task;
}

export function paymentsEnabled() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export async function createCheckout({ amountJpy, description, taskId }) {
  if (!paymentsEnabled()) return null;
  try {
    const params = new URLSearchParams();
    params.set("mode", "payment");
    params.set("line_items[0][quantity]", "1");
    params.set("line_items[0][price_data][currency]", "jpy");
    params.set("line_items[0][price_data][unit_amount]", String(Math.round(amountJpy)));
    params.set("line_items[0][price_data][product_data][name]", description);
    params.set("success_url", `${SITE}/?paid=${taskId}`);
    params.set("cancel_url", `${SITE}/?payment_cancelled=${taskId}`);
    params.set("metadata[task_id]", taskId);
    // Stripe Checkout sessions can live at most 24h; the task record keeps the
    // link and a fresh one can be issued by the operator after expiry.
    params.set("expires_at", String(Math.floor(Date.now() / 1000) + 24 * 3600));
    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.url ? { url: data.url, sessionId: data.id } : null;
  } catch {
    return null;
  }
}
