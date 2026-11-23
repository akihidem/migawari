# Migawari

**The stand-in for AI agents in Japan — physical tasks, executed by humans.**
AIエージェントの身代わりとして、日本の物理タスクを実行するサービス

Migawari lets AI agents hire humans for physical tasks inside Japan:
in-store shopping proxy, in-store stock checks, on-site photo capture,
restaurant phone reservations in Japanese, queueing, and package
receiving & forwarding. It is agent-first: a machine-readable catalog,
instant itemised quotes for every service, and an MCP-native interface.

- Website: https://japan-hands.vercel.app/
- MCP endpoint: https://japan-hands.vercel.app/mcp
- Transport: Streamable HTTP. Connecting and listing tools require no
  sign-in or API key. `request_quote` returns an `access_token` that
  authorises that quote's accept / status / evidence / messages.
- Official MCP Registry: `io.github.akihidem/migawari`
- Full text for agents: https://japan-hands.vercel.app/llms.txt ·
  https://japan-hands.vercel.app/llms-full.txt
- Comparison with other options: https://japan-hands.vercel.app/comparison.md

> Renamed from "Japan Hands" to Migawari on 2026-11-23 (the old registry
> entry `io.github.akihidem/japan-hands` is deprecated).

## Connect

Claude Code:

```bash
claude mcp add --transport http migawari 'https://japan-hands.vercel.app/mcp'
```

JSON configuration (Claude Desktop, Cursor, VS Code and others):

```json
{
  "mcpServers": {
    "migawari": {
      "type": "http",
      "url": "https://japan-hands.vercel.app/mcp"
    }
  }
}
```

## Services and pricing

| Service | What a human does | Handling fee |
|---|---|---|
| `shopping_proxy` | Buys a specified item in a physical store in Japan (incl. store-only / limited-edition releases and pop-ups) and ships it to you. New items only. | from JPY 16,500 |
| `stock_check` | Visits the store, checks shelf stock, price and display state, returns photos and a written record. | from JPY 8,800 |
| `photo_capture` | Goes to a named place and returns on-site photos (storefront, display, menu, notices) as evidence. | from JPY 13,200 |
| `phone_reservation` | Calls a restaurant in Japanese and books in your name. Restaurants only — no lodging. | from JPY 5,500 |
| `queueing` | Stands in line for you (release-day sales, events, numbered tickets). | from JPY 9,900 / hour |
| `package_forwarding` | Receives a package, photographs its packing state, forwards it with tracking. | from JPY 8,800 |

Plus a quote fee of JPY 2,200, charged as part of the total when you
accept a quote (requesting a quote is free; if the operator declines
after payment, everything paid — including the quote fee — is refunded).
Total = item price (tax incl.) + quote fee + handling fee + shipping.
Akihabara is on a weekday daily run; Ginza is a premium zone for
shopping (+JPY 5,500 handling). Coverage: Japan only.

Payment: card via Stripe (JPY / USD), or stablecoins — JPYC or USDC on
Polygon (`pay_with: "jpyc"` / `"usdc"` at accept time; the exact amount,
including a unique fractional tail, identifies your transfer and is
verified on-chain).

## Tools (8)

| Tool | Description |
|---|---|
| `list_services` | List the services provided in Japan with prices, limits and exclusions. |
| `request_quote` | Get an instant itemised quote and an `access_token`. Set `test_mode: true` to simulate the whole flow free. |
| `accept_quote` | Accept a quote (choose `pay_with`: `card` / `jpyc` / `usdc`). The task enters `pending_review`. |
| `decline_quote` | Decline a quote. |
| `get_task_status` | Status and operator messages for a quote or task. |
| `send_message` | Leave a note for the human operator about a quote or task. |
| `get_evidence` | Evidence package for a task (timestamped photos, call records, receipts, tracking numbers), SHA-256 hashed — returned even for failed tasks. |
| `cancel_task` | Cancel a quote or task. |

## Safe verification

- `test_mode: true` on `request_quote` runs the **entire flow as a
  simulation**: no payment is requested and nothing is executed. Use it
  to verify integration before spending anything.
- Quotes are instant; **execution is not**. Every accepted request is
  reviewed by a human operator individually during the launch phase
  (`pending_review`) before any work starts. No start or completion
  time is promised before that review.
- Migawari acts strictly as agent: never a party to the sales contract,
  never holding title to goods or inventory, and outcomes are never
  guaranteed. What is sold is faithful execution with evidence returned.

## Not offered

CAPTCHA / bot-defense bypass; identity-verification (KYC) impersonation;
account farming or impersonation; operations using someone else's
credentials; lodging reservations; used-goods purchases; tasks outside
Japan.

## Free sister service

Need Japanese *data* rather than hands? Japan Data Tools is a free MCP
server from the same operator (holidays, business days, wareki, tax,
corporate / invoice number validation, postcode / address lookup):
https://japan-data-tools.vercel.app/mcp — its `need_human_in_japan`
tool points back here.

## Repository layout

This repository is the production app itself (zero-dependency Node,
deployed on Vercel): `api/` holds the Vercel Functions (MCP, catalog,
quotes, tasks), `lib/` the catalog / pricing / tools implementation,
and `public/` the landing page and machine-readable files
(`llms.txt`, `llms-full.txt`, `services.json`, `openapi.yaml`,
`server.json`, `comparison.md`).
