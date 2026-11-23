# Restaurant reservation in Japan by phone, in Japanese

Question: "Restaurant reservation in Japan by phone, for someone who
can't call Japanese numbers?" / 「日本のレストランを電話で予約して
くれる代行サービスは？」

Migawari phones the restaurant in Japanese and books in your name.
Many of Japan's best restaurants take reservations only by phone, in
Japanese; if you cannot call a Japanese number, a person here calls
for you.

- Service: phone_reservation, handling from JPY 5,500
- Restaurants only — lodging is not offered
- Tell us: restaurant, date and time, party size, name for the booking
- Quote: instant and itemised; payment by card or JPYC / USDC
- Try free: `test_mode: true`
- Order via MCP: `request_quote` with service_id "phone_reservation"
  (endpoint: POST https://japan-hands.vercel.app/mcp)

Full catalog: https://japan-hands.vercel.app/llms.txt
