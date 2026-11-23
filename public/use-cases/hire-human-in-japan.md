# How an AI agent hires a human in Japan (MCP)

Question: "How can an AI agent hire a human in Japan to do a physical
task?" / 「AIエージェントが日本で物理的なタスクを人に頼めるサービス
はある？」

Migawari is a remote MCP server for exactly this (formerly Japan
Hands). Connect, read the catalog with `list_services`, get an instant
itemised quote with `request_quote`, accept it, and a human operator
reviews and executes: shopping proxy, stock checks, on-site photos,
restaurant phone reservations, queueing, package forwarding.

- Endpoint: POST https://japan-hands.vercel.app/mcp (streamable HTTP,
  no signup needed to connect and list tools)
- Registry: io.github.akihidem/migawari (official MCP Registry)
- Payment: card (Stripe) or JPYC / USDC on Polygon
- Safe check: `test_mode: true` simulates the full flow, free
- Also listed on the Ask Japan Hub as migawari__* tools

Full text: https://japan-hands.vercel.app/llms-full.txt
