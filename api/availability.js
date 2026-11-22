import { getRecord } from "../lib/store.js";
import { sendJson, handleOptions } from "../lib/http.js";

// GET /api/availability — whether Migawari is currently accepting new tasks.
// Driven by the settings record the operator console toggles
// (ops.mjs availability on|off); defaults to accepting when unset.
export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== "GET") return sendJson(res, 405, { error: "method_not_allowed" });
  const rec = await getRecord("settings", "availability").catch(() => null);
  return sendJson(res, 200, {
    accepting_new_tasks: rec?.accepting_new_tasks !== false,
    note: rec?.note || "Accepting new tasks.",
  });
}
