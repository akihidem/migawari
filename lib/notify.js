// Notification hook: emails the operator on new requests.
// Disabled unless HFA_NOTIFY_ENABLED=1 AND RESEND_API_KEY is set.
// Uses the Resend API (https://resend.com) over plain fetch — no SDK dependency.
// Failures never break the request flow; they are reported in the return value.
// See README "Notifications" for setup.
export async function notifyOperator(event, payload) {
  const enabled = process.env.HFA_NOTIFY_ENABLED === "1";
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.HFA_NOTIFY_TO || "";
  const from =
    process.env.HFA_NOTIFY_FROM || "Migawari <onboarding@resend.dev>";

  if (!enabled) return { sent: false, reason: "disabled (HFA_NOTIFY_ENABLED != 1)" };
  if (!apiKey) return { sent: false, reason: "RESEND_API_KEY not set" };
  if (!to) return { sent: false, reason: "HFA_NOTIFY_TO not set" };

  const subject = `[Migawari] ${event}: ${payload.id || payload.quote_id || ""}`;
  const text = [
    `Event: ${event}`,
    `Time: ${new Date().toISOString()}`,
    "",
    JSON.stringify(payload, null, 2),
    "",
    "Reminder: launch phase — every accepted request is pending_review.",
    "Confirm or decline with the requester individually before any execution.",
  ].join("\n");

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    if (!res.ok) {
      return { sent: false, reason: `resend ${res.status}: ${await res.text()}` };
    }
    return { sent: true, to };
  } catch (e) {
    return { sent: false, reason: String(e) };
  }
}
