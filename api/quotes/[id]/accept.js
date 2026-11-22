import { acceptQuote } from "../../../lib/tools.js";
import { readJsonBody, sendJson, handleOptions, bearerOf } from "../../../lib/http.js";
import { rateLimitExceeded, sendRateLimited } from "../../../lib/ratelimit.js";

// POST /api/quotes/{id}/accept — places the request in pending_review.
// Does NOT confirm execution (2026-11-16 launch decision).
export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
  const rl = await rateLimitExceeded(req, "write");
  if (rl) return sendRateLimited(res, rl);
  const body = (await readJsonBody(req)) || {};
  const out = await acceptQuote({ quote_id: req.query?.id, access_token: body.access_token || bearerOf(req) || undefined, pay_with: body.pay_with || undefined });
  return sendJson(res, out.isError ? 400 : 200, out);
}
