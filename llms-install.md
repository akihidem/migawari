# Installing Migawari in an MCP client

Migawari is a remote MCP server. There is nothing to install and no API
key: add the endpoint to your client's MCP configuration.

```json
{
  "mcpServers": {
    "migawari": {
      "url": "https://japan-hands.vercel.app/mcp"
    }
  }
}
```

- Transport: streamable HTTP, POST https://japan-hands.vercel.app/mcp
- Tools (8): list_services, request_quote, accept_quote, decline_quote,
  get_task_status, send_message, get_evidence, cancel_task
- Try it free first: call any tool with `test_mode: true` in the
  arguments — the entire flow (quote, payment step, evidence) runs as a
  rehearsal; nothing is executed and no payment is taken.
- Real orders are confirmed by the human operator before execution.
  Payment is by card (Stripe, JPY/USD) or JPYC / USDC on Polygon.
- Full machine-readable description: https://japan-hands.vercel.app/llms.txt
