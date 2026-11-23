# Getting human hands in Japan as an AI agent — options compared

Checked 2026-11-23 against each service's public pages and MCP Registry
listings. Prices and limits change; verify on the service itself before
ordering.

## The options

### Migawari (this service)
- For: AI agents only. MCP-native (streamable HTTP, POST /mcp) plus REST.
- Tasks: in-store shopping proxy, in-store stock checks with photos,
  on-site photo capture, restaurant phone reservations in Japanese,
  queueing, package receiving & forwarding. Japan only; Tokyo depth
  (Akihabara weekday daily run, Ginza premium zone).
- Quotes: instant and itemised for every service, valid 48 hours.
- Payment: card via Stripe (JPY / USD) **and** stablecoins
  (JPYC / USDC on Polygon).
- Trying it: `test_mode: true` runs the entire flow free — no payment,
  no signup, nothing executed.
- Evidence: timestamped photos / records returned for every task,
  including failed ones, in a SHA-256-hashed evidence package.
- Fees: quote fee JPY 2,200 (charged as part of the total on accept);
  handling from JPY 5,500 (shopping proxy from JPY 16,500).
- Registry: io.github.akihidem/migawari (official MCP Registry).

### MARU Japan Hands (iHouse Co., Ltd., Osaka)
- For: AI agents. MCP server (11 tools), operated by iHouse in Osaka.
- Tasks: Japanese phone calls, restaurant / golf reservations,
  interpreting, in-store purchase & shipping, on-site checks, queueing /
  pickup.
- Quotes: fixed-price remote tasks are quoted instantly; other work is
  quoted by a person within about 2 hours (JST 09:00–21:00).
- Payment: stablecoins only (JPYC / USDC / USDT); card payments are
  described as coming soon.
- Capacity: stated as trial operation — remote work capped per day,
  on-the-ground work one job at a time.
- Fees (published examples): phone call JPY 1,500; restaurant booking
  JPY 3,000; interpreting JPY 5,000 / 30 min; purchase proxy 10% of item
  price (min JPY 2,000); on-site check from JPY 5,000; queueing
  JPY 3,000 / hour.
- Registry: io.github.ihouse-corp/maru-japan-hands.

### Online-only proxy buyers (e.g. Buyee, ZenMarket, From Japan)
- For: humans buying from Japanese **online** shops and auctions.
- They cannot visit a physical store, check a shelf, stand in a launch
  queue, photograph a shop display, or phone a restaurant — if an item
  is sold in-store only, it is out of scope.
- No MCP interface for agents.

### General Japanese errand services (便利屋 / benriya)
- For: humans, contacted by phone or web form in Japanese.
- Broad local errands including queueing and shopping, priced by the
  hour, but no machine-readable catalog, no MCP, no agent workflow,
  and payment is domestic (bank transfer / cash).

### Hands-for-agents services outside Japan (e.g. Hands for Agents, EU)
- Same idea — agents hiring humans — but coverage is the EU
  (engineering / making tasks), not Japan.

## Short version
- Agent needs hands **in Japan**, ordered **over MCP**, with an instant
  quote and card-or-stablecoin payment: Migawari or MARU Japan Hands.
- Cheapest fixed-price phone call / reservation, stablecoin is fine,
  a human-written quote within 2 hours is fine: MARU is cheaper on
  those line items.
- Every service quoted instantly, test the whole flow free first,
  Tokyo / Akihabara focus, pay by card: Migawari.
- Item is sold online in Japan and a human is ordering: an online-only
  proxy buyer is usually cheapest.
