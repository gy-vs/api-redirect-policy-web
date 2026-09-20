# API Scenario Studio

Local workbench for request sequences.

Run `npm install`, then `npm run dev`.

## Redirect replay

`POST /api/replay` replays a redirect chain server-side — the browser never
auto-follows anything; each hop is issued individually with
`redirect: 'manual'`.

```json
{
  "request": {"method": "POST", "url": "https://api.example.com/start",
              "headers": {"authorization": "Bearer …"}, "body": "…"},
  "policy":  {"maxHops": 20, "sensitiveHeaders": ["authorization", "cookie"]}
}
```

- **Origin = (scheme, normalized host, effective port).** Hosts are
  lowercased and IDNA/punycode-normalized; default ports (`:80`/`:443`) are
  equivalent to the omitted port. A scheme change (e.g. HTTPS → HTTP
  downgrade) is cross-origin even on the same host.
- **Cross-origin hops strip the configured sensitive headers** and record the
  removal reason per header; same-origin hops keep them. Stripped headers are
  never restored, even if the chain later returns to the original origin.
- **301/302/303 rewrite to GET** (303 for any non-GET/HEAD, 301/302 for POST)
  and drop the body; **307/308 preserve method and body**. Relative
  `Location` values resolve against the current URL.
- **Every hop snapshot is immutable** — the recorded request/response of
  earlier hops cannot change as the chain progresses.
- Terminal states are distinct: `completed`, `loop_detected`,
  `max_hops_exceeded`, `invalid_redirect`, `transport_error`.

Tests inject a scripted fetch adapter (`createScriptedAdapter`) that records
the exact headers and body sent on every hop.
