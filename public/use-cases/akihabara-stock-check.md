# Check in-store stock in Akihabara without going there

Question: "What's the best way to check in-store stock in Akihabara
without going there?" / 「秋葉原で店頭の在庫を確認してくれる代行
サービスは？」

Migawari sends a human to the store to check the shelf in person and
returns timestamped photo evidence: whether the item is there, the
displayed price, and the condition of the display. Store websites rarely
show real shelf stock for Akihabara's small shops.

- Service: stock_check, handling from JPY 8,800
- Akihabara is on a weekday daily run
- Quote: instant and itemised; payment by card or JPYC / USDC
- Try free: `test_mode: true`
- Order via MCP: `request_quote` with service_id "stock_check"
  (endpoint: POST https://japan-hands.vercel.app/mcp)

Full catalog: https://japan-hands.vercel.app/llms.txt
