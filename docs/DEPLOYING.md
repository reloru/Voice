# Deploying

The server is stateless apart from the JSONL files in `DATA_DIR`. It needs:

- a **public HTTPS URL** xAI can POST to,
- `XAI_API_KEY` and `XAI_WEBHOOK_SECRET`,
- an `agent.yaml`,
- a persistent volume if you want transcripts to survive a redeploy.

It does **not** need to be geographically near your callers, and it does not
need much CPU or bandwidth — the call audio flows between the caller and xAI
directly, never through this process.

## 1. Get the server reachable

### Cloudflare Workers (recommended)

Free tier, always on, permanent HTTPS URL, and nothing running on your own
machine. The webhook handler is a Worker; each live call runs inside a
**Durable Object**, because a plain Worker invocation cannot hold a WebSocket
open for the length of a phone call.

```bash
npx wrangler deploy
npx wrangler secret put XAI_API_KEY
npx wrangler secret put XAI_WEBHOOK_SECRET
npx wrangler secret put DASHBOARD_TOKEN        # openssl rand -hex 32
npx wrangler secret put NOTIFY_WEBHOOK_URL     # optional
```

`wrangler deploy` prints the URL. The webhook path is `/webhooks/xai`.

**Editing the agent without a terminal.** The config lives in KV under the key
`agent.yaml`. Change it in the Cloudflare dashboard at _Workers & Pages → KV →
VOICE_KV → agent.yaml_; it applies to the next call, with no redeploy. If you
save something invalid the Worker logs the error and falls back to the bundled
default rather than dropping calls. The same thing over HTTP:

```bash
curl -X PUT https://<your-worker>/config \
  -H "Authorization: Bearer $DASHBOARD_TOKEN" \
  --data-binary @agent.yaml          # validates before storing; 400 if invalid
```

**Confirming it works**, without needing a phone number:

```bash
curl https://<your-worker>/healthz
curl -X POST https://<your-worker>/selftest -H "Authorization: Bearer $DASHBOARD_TOKEN"
```

`/selftest` opens a real realtime session from the Durable Object, asks Grok for
one word, and reports the transcript, audio size, and every event it saw. If
that returns `"ok": true`, the deployment can reach xAI and hold a WebSocket —
which is the only part that is hard.

Live logs:

```bash
npx wrangler tail --format pretty
```

Notes specific to this target:

- Records are stored in KV with a 30-day TTL, newest-first by key prefix.
  Transcripts are personal data; the TTL is deliberate.
- The Durable Object is addressed by `call_id`, so xAI's webhook retries are
  idempotent — a repeat delivery hits the same instance, which refuses to open
  a second session.
- `MAX_CONCURRENT_CALLS` does not apply here; each call gets its own object.
  xAI's own ceiling of 100 concurrent sessions per team is the real limit.

### Local, for testing

```bash
npm run dev
cloudflared tunnel --url http://localhost:8080
```

Cloudflare's quick tunnels need no account and print an `https://….trycloudflare.com`
URL. The URL changes every restart, so re-point the webhook each time:

```bash
npm run cli -- numbers set-webhook --id phone_xxx --url https://<tunnel>/webhooks/xai
```

### Docker

```bash
docker build -t voice-agent .
docker run -d --name voice-agent -p 8080:8080 \
  --env-file .env \
  -v "$PWD/agent.yaml:/app/agent.yaml:ro" \
  -v "$PWD/data:/app/data" \
  voice-agent
```

The image runs as a non-root user, ships without dev dependencies, has a
`HEALTHCHECK` against `/healthz`, and uses `tini` so `SIGTERM` reaches Node and
in-flight calls are hung up cleanly instead of being cut off.

### Fly.io

```bash
fly launch --no-deploy
fly secrets set \
  XAI_API_KEY=xai-... \
  XAI_WEBHOOK_SECRET=whsec_... \
  NODE_ENV=production
fly volumes create voice_data --size 1
fly deploy
```

Add to `fly.toml`:

```toml
[env]
  PORT = "8080"
  DATA_DIR = "/data"

[[mounts]]
  source = "voice_data"
  destination = "/data"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = false   # a stopped machine misses the call webhook
```

`auto_stop_machines` matters: scale-to-zero adds cold-start latency to the
webhook, and xAI is holding a ringing caller while it waits.

### Anywhere else

Render, Railway, Cloud Run, a $5 VPS behind Caddy — all fine. Requirements are
only: HTTPS, a stable URL, and the process not being suspended between calls.

## 2. Get a number and point it here

xAI will not provision a number in most areas — the console says _"Your area
does not support provisioning phone numbers. Use Twilio or Direct SIP instead."_
and the API returns 403. Both alternatives work identically from this server's
point of view.

**Twilio (easiest).** Sign up at twilio.com, buy a local number (~$1.15/mo,
~$0.0085/min inbound), then in console.x.ai → Voice Agents → New phone number →
**Twilio** tab, paste the Account SID, Auth Token, and the number. xAI
configures the SIP trunk for you.

**Direct SIP.** Use a number from any carrier or your own PBX. The console's
**Direct SIP** tab shows the SIP URI to route to
(`sip:{number}@sip.voice.x.ai;transport=…`), an allowed-address list, and
optional digest auth. The same thing over the API:

```bash
npm run cli -- numbers register \
  --number +15551234567 \
  --url https://your-host/webhooks/xai \
  --name "screening line" \
  --sip-user myuser --sip-pass "$(openssl rand -hex 24)"
```

Then point whichever number you ended up with at this server:

```bash
npm run cli -- numbers set-webhook --id phone_xxx --url https://your-host/webhooks/xai
npm run cli -- numbers list          # confirm it is routed
```

`register` prints the `sip_host` to point your carrier's trunk at, and the
`dispatch_signing_secret` — **shown once**. Put it in `XAI_WEBHOOK_SECRET`
before the next call arrives. Add `--allow-cidr 203.0.113.10/32` (repeatable)
to accept INVITEs only from your carrier's addresses.

## 3. Forward your real number

To have the agent answer calls you don't pick up, set conditional forwarding on
your mobile line. On most US GSM carriers, dialled from the handset:

| Rule                     | Code                                    |
| ------------------------ | --------------------------------------- |
| Forward when unanswered  | `**61*<agent number>*11*20#` (20s ring) |
| Forward when busy        | `**67*<agent number>#`                  |
| Forward when unreachable | `**62*<agent number>#`                  |
| Forward everything       | `**21*<agent number>#`                  |
| Cancel all forwarding    | `##002#`                                |

Codes vary by carrier — check yours, or set it in the carrier's app. Start with
_unanswered_ forwarding: your phone still rings normally, and the agent only
picks up what you let go.

## 4. Verify

```bash
npm run cli -- doctor            # flags numbers that are not routed anywhere
curl https://your-host/healthz
```

Then call the number. Watch the logs for `accepted call` followed by
`realtime session connected`. After hanging up you should see `call ended` and a
new line in `data/calls.jsonl`.

## Getting notified about messages

Set `NOTIFY_WEBHOOK_URL` and the server POSTs JSON when a message is taken and
when a call ends:

```json
{
  "kind": "message.taken",
  "message": {
    "id": "…",
    "callId": "…",
    "callerName": "Dana",
    "callbackNumber": "+15555550123",
    "message": "The roof quote came in at four thousand dollars.",
    "urgency": "urgent"
  },
  "sent_at": "2026-08-21T17:04:11.000Z"
}
```

Point it at a Zapier/Make/n8n hook for SMS or email, or at your own endpoint.
Delivery is best-effort and never blocks a live call — failures are logged and
the call continues.

## Operational notes

- **Concurrency:** `MAX_CONCURRENT_CALLS` (default 10) caps live calls per
  process. Beyond it, extra calls are hung up rather than queued, so nobody
  waits in silence. xAI's own ceiling is 100 concurrent sessions per team.
- **Restarts:** `SIGTERM` hangs up live calls before exiting. Deploying mid-call
  drops that caller — deploy when the line is quiet if you can.
- **Duplicate webhooks:** xAI retries deliveries. A repeat `call_id` is ignored
  rather than opening a second session.
- **Log noise:** set `LOG_LEVEL=warn` in production; `debug` prints every
  unhandled realtime event, which is useful when the API adds one.

## Troubleshooting

| Symptom                                                       | Likely cause                                                                                                            |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Server exits with `XAI_WEBHOOK_SECRET is required`            | No signing secret. Re-create the webhook to get a fresh one, or set `ALLOW_UNSIGNED_WEBHOOKS=true` for local work only. |
| Calls ring out, no webhook arrives                            | The number is not routed. `npm run cli -- doctor` flags numbers with no webhook or agent.                               |
| `401 invalid signature` in the logs                           | `XAI_WEBHOOK_SECRET` does not match the number's webhook — most often after `set-webhook` issued a new secret.          |
| `rejected an unverified webhook … timestamp_out_of_tolerance` | Server clock drift. Fix NTP; do not widen `WEBHOOK_TOLERANCE_SECONDS`.                                                  |
| `accepted call` then an immediate close                       | Expected for `simulate-call` (the `call_id` is invented). On a real call, check the API key is valid for realtime.      |
| Agent talks over the caller                                   | Lower `agent.speed`, and consider raising `turn_detection` sensitivity by editing `src/realtime/session.ts`.            |
| Goodbye gets clipped                                          | Raise `call.hangup_delay_ms`.                                                                                           |
