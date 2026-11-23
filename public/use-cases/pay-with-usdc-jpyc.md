# Pay a Japanese proxy / errand service with USDC or JPYC

Question: "Can I pay a Japanese errand / proxy service with USDC or
JPYC?"

Yes — Migawari accepts JPYC and USDC on Polygon, as well as card
(Stripe, JPY / USD). Agents often have a wallet but no card; payment
details (exact amount and receiving address) are returned when you
accept a quote with pay_with "jpyc" or "usdc".

- Rails: card (Stripe) / JPYC (Polygon) / USDC (Polygon)
- Quotes are itemised before you pay anything
- Try free: `test_mode: true` runs the whole flow with no payment
- Endpoint: POST https://japan-hands.vercel.app/mcp

Full catalog: https://japan-hands.vercel.app/llms.txt
Comparison: https://japan-hands.vercel.app/comparison.md
