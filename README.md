# GridHub MCP Server

Live and historical electricity market data for AI agents, over the [Model Context Protocol](https://modelcontextprotocol.io).

**Endpoint:** `https://api.grid-hub.app/mcp` — hosted, Streamable HTTP, stateless. Nothing to install.

Covers 25 grid zones — US ISOs (CAISO, ERCOT, PJM, MISO, NYISO, ISO-NE, SPP), 12 European bidding zones, Great Britain, and the five Australian NEM regions — normalised into one JSON schema. Sourced from EIA, ENTSO-E, NESO, Elexon and AEMO; every response carries its licence and attribution.

## Tools

| Tool | What it returns |
|---|---|
| `get_zone_brief` | Current price / demand / carbon intensity ranked against the zone's own last 30 days (percentile, vs-median, min/max), 24h trend, generation mix, and a one-sentence summary. Best for "is electricity cheap or clean in X right now?" |
| `get_latest` | Most recent value of every metric one zone publishes, with unit and timestamp |
| `get_history` | Time series for one metric over a start/end window (up to 31 days per call) |
| `get_map_snapshot` | Headline values for all 25 zones at once — compare or rank zones |
| `list_zones` | Zone ids, names, sources, currencies, licences (free) |
| `get_status` | Ingestion freshness per source and zone (free) |

## Access

Three levels, no signup needed to start:

1. **Sample mode** — connect with no credentials. Tools return real, current data, truncated (history capped at 50 rows; brief returns one context block). Results are clearly marked.
2. **Free API key** — 500 requests/day. Instant email signup at [grid-hub.app/developers](https://grid-hub.app/developers#free-key), or `POST https://api.grid-hub.app/v1/keys/signup` with `{"email": "..."}`. Send as `Authorization: Bearer <ghk_key>`.
3. **x402 pay-per-call** — USDC on Base, $0.001–$0.02 per call, via the `X-PAYMENT` header. See [the x402 flow](https://grid-hub.app/developers).

## Setup

**Claude Code**
```bash
claude mcp add --transport http gridhub https://api.grid-hub.app/mcp \
  --header "Authorization: Bearer YOUR_KEY"
```

**Cursor / Windsurf / VS Code** (`mcp.json`)
```json
{
  "mcpServers": {
    "gridhub": {
      "url": "https://api.grid-hub.app/mcp",
      "headers": { "Authorization": "Bearer YOUR_KEY" }
    }
  }
}
```

**Claude Desktop / claude.ai** — add `https://api.grid-hub.app/mcp` as a custom connector. These clients don't send custom headers; pass the key as the optional `api_key` tool argument, or use sample mode.

**Local stdio bridge** — for clients that only support local (stdio) servers. It proxies to the hosted endpoint via `mcp-remote`; nothing runs locally except the bridge.
```json
{
  "mcpServers": {
    "gridhub": {
      "command": "npx",
      "args": ["-y", "github:jalcodev/gridhub-mcp"],
      "env": { "GRIDHUB_API_KEY": "YOUR_KEY" }
    }
  }
}
```
Or with Docker: `docker build -t gridhub-mcp . && docker run -i -e GRIDHUB_API_KEY=YOUR_KEY gridhub-mcp`. Omit the key for sample mode.

**Any client, no key** — omit the header. You'll get sample-mode data and a note on how to upgrade.

## Protocol

- Streamable HTTP, stateless: one JSON-RPC message per POST, JSON response. No sessions, no SSE.
- Speaks MCP `2026-07-28` (header-mirrored requests, no handshake) and `2025-03-26` through `2025-11-25` (`initialize` handshake).
- Tool results include `structuredContent` alongside the text block.
- Rate limits and quotas are those of the underlying [REST API](https://api.grid-hub.app/llms.txt); the MCP layer adds none of its own.

## Related

- REST API docs: https://grid-hub.app/developers
- OpenAPI: https://api.grid-hub.app/openapi.json
- `llms.txt`: https://api.grid-hub.app/llms.txt
- Official MCP Registry entry: `io.github.jalcodev/gridhub`

## License

The code in this repository is MIT licensed. Data returned by the service is subject to each source's licence, stated in every response (`license` and `attribution` fields).
