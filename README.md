# Voice — a Grok agent that answers a phone number

A production-shaped voice agent that picks up a real phone number, screens the
caller, answers what it can, takes a message, and optionally puts urgent callers
through to you. It runs on xAI's Realtime (speech-to-speech) API over SIP.

Everything about how the agent behaves — its name, voice, greeting, personality,
what it knows, who gets put through, who gets hung up on — lives in one YAML
file. You should not need to touch the code to change any of it.

---

## Can an agent answer _my_ phone?

Short answer: **not your existing line directly — but you get the same result in
two steps, and it works well.**

Your mobile carrier owns your number, and there is no API that lets software
"pick up" a call ringing on your handset. What you can do instead:

1. **Give the agent its own phone number.**
2. **Forward your real number to it** — either everything, or (much more useful)
   only when you're busy or don't answer within a few rings. Every major carrier
   supports conditional call forwarding, usually free.

The result is what you actually wanted: you ignore a call, and instead of
voicemail the caller gets a competent assistant that finds out who they are,
what they need, and texts you a summary. You can also just hand out the agent's
number directly as a business or screening line.

## How it actually works

The single most surprising thing: **the audio never touches this server.**

xAI holds both ends of the phone call — the caller's leg and the model's leg.
This server is the _control plane_. It gets told a call arrived, configures the
agent's personality for that call, runs any tools the model decides to call, and
decides when the call ends.

```mermaid
sequenceDiagram
    participant C as Caller
    participant X as xAI (SIP + Grok)
    participant S as This server
    participant Y as Your phone

    C->>X: dials the agent's number
    X->>S: POST /webhooks/xai (signed realtime.call.incoming)
    S-->>X: 200 OK, immediately
    S->>X: WebSocket connect (?call_id=...)
    S->>X: session.update — persona, voice, tools
    X-->>C: "Hi, you've reached Reed's line…"

    Note over C,X: audio flows directly between caller and Grok

    X->>S: response.function_call_arguments.done (take_message)
    S->>S: save message, send notification
    S->>X: function_call_output
    X-->>C: "Got it, I'll pass that on."

    S->>X: POST /hangup  (or /refer to transfer)
    X-->>Y: transferred call, if the agent decided to
```

Because audio bypasses this process, the server is cheap to run and does not
need to be near the caller. A small VM or a free-tier container is plenty.

## Getting a phone number

**xAI cannot sell you a number in most areas.** The console says so plainly —
_"Your area does not support provisioning phone numbers. Use Twilio or Direct
SIP instead."_ — and the API refuses too, with
`403 Provisioning SpaceXAI phone numbers via the API is not supported.`

That changes nothing about this server. However the number is obtained, calls
arrive here as the same signed `realtime.call.incoming` webhook.

Three routes, easiest first:

| Route                    | How                                                                                                                                                                                                       | Cost                             |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **Twilio** (recommended) | Buy a number on Twilio, then console.x.ai → Voice Agents → New phone number → **Twilio** tab → paste Account SID, Auth Token, and the number. xAI wires up the SIP trunk for you.                         | ~$1.15/mo + ~$0.0085/min inbound |
| **Direct SIP**           | Any carrier or PBX you already own. The console's **Direct SIP** tab gives you the SIP URI (`sip:{number}@sip.voice.x.ai`) to point your trunk at, plus optional digest auth and an allowed-address list. | your carrier's rates             |
| **xAI-provisioned**      | Console only, where offered. Not available in most areas today.                                                                                                                                           | xAI telephony rates              |

Once the number exists on your team, point it at this server:

```bash
npm run cli -- numbers set-webhook --id phone_xxx --url https://<your-host>/webhooks/xai
```

xAI returns a `dispatch_signing_secret` (`whsec_…`) **exactly once** when the
webhook is created. That value is `XAI_WEBHOOK_SECRET`. Save it immediately — it
cannot be retrieved later, and without it this server rejects every delivery.

---

## Quick start

Requires Node 20.11+ and an xAI API key from [console.x.ai](https://console.x.ai).

```bash
npm install
cp .env.example .env            # add your XAI_API_KEY
cp agent.example.yaml agent.yaml # make the agent yours
```

For local development you can run without a signing secret:

```bash
# in .env
ALLOW_UNSIGNED_WEBHOOKS=true
```

Then:

```bash
npm run dev                       # start the server
npm run cli -- doctor             # check key, config, and numbers
npm run cli -- simulate-call      # fire a fake signed call at yourself
```

`simulate-call` sends a properly signed `realtime.call.incoming` at your own
server, so you can verify signature checking, caller lookup, and routing without
placing a real call. The call itself will fail to connect (the `call_id` is
invented) — that is expected, and the logs will show it got that far.

To take a real call while developing, expose your local server:

```bash
cloudflared tunnel --url http://localhost:8080
npm run cli -- numbers set-webhook --id phone_xxx --url https://<tunnel>/webhooks/xai
```

## Configuring the agent

All of it is in `agent.yaml` — see [`agent.example.yaml`](agent.example.yaml)
for the fully commented version. The parts that matter most:

```yaml
agent:
  name: Ada
  voice: eve # npm run cli -- voices
  speed: 0.95 # phone audio is clearer slightly slow

owner:
  name: Reed
  timezone: America/Chicago

greeting: >-
  Hi, you've reached Reed's line. I'm Ada, his assistant…

persona:
  style: Warm, brisk, and genuinely helpful…
  rules:
    - If someone is selling something, politely decline and end the call.
  guardrails:
    - Never accept or read out verification codes or one-time passcodes.

transfer:
  enabled: true
  target: "tel:+15551234567"
  policy: Transfer only if the caller says it is genuinely urgent.

known_callers: # greeted by name, screening skipped
  - number: "+15555550100"
    name: Dana

blocklist: [] # hung up on before the agent speaks

knowledge: # answered directly; anything else → "I'll pass it on"
  - question: What are your hours?
    answer: Nine to five, Central, Monday to Friday.
```

Run `npm run cli -- doctor` after editing — it validates the file, the timezone,
your API key, and whether your numbers are actually routed anywhere.

### What the agent can do on a call

| Tool             | Behaviour                                                                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `take_message`   | Records caller, callback number, message, and urgency. Written to `data/messages.jsonl` and pushed to `NOTIFY_WEBHOOK_URL`.                                    |
| `get_local_time` | Real time in your timezone, so it never guesses the date or your hours.                                                                                        |
| `transfer_call`  | SIP REFER to your real number. Only offered when `transfer.enabled` is set. If the transfer fails, the caller is handed back to the agent rather than dropped. |
| `end_call`       | Hangs up — after the goodbye has finished playing, not mid-sentence.                                                                                           |

## Deploying

Two supported targets. Full instructions in [docs/DEPLOYING.md](docs/DEPLOYING.md).

### Cloudflare Workers (recommended)

Always-on, free tier, permanent HTTPS URL, nothing to keep running on your own
machine. The webhook is a Worker; each live call runs in a **Durable Object**,
which is what lets a WebSocket stay open for the length of a phone call.

```bash
npx wrangler deploy
npx wrangler secret put XAI_API_KEY
npx wrangler secret put XAI_WEBHOOK_SECRET
npx wrangler secret put DASHBOARD_TOKEN     # guards /calls, /messages, /selftest
```

The agent config lives in KV under the key `agent.yaml`, so the persona,
greeting, knowledge and blocklist can be edited straight from the Cloudflare
dashboard — **no terminal, no redeploy**. An invalid edit is logged and the
Worker falls back to the bundled default rather than dropping calls.

`POST /selftest` (with the dashboard token) opens a real realtime session from
the Durable Object and reports what came back — the fastest way to confirm the
deployment can actually reach xAI.

### Node / Docker

Same code, same behaviour, if you would rather self-host.

```bash
docker build -t voice-agent .
docker run -p 8080:8080 --env-file .env \
  -v "$PWD/agent.yaml:/app/agent.yaml:ro" -v "$PWD/data:/app/data" voice-agent
```

## What it costs

- **Model:** ~$0.05–0.08 per audio minute (`grok-voice-think-fast-2.0`, which
  `grok-voice-latest` currently points at). A two-minute screening call is a
  handful of cents.
- **Telephony:** billed by xAI for a provisioned number, or by your own carrier
  for a BYO number.
- Realtime sessions are capped at **30 minutes**, and **100 concurrent** per
  team. `call.max_seconds` defaults to 10 minutes.

## Commands

```bash
npm run dev            # run with reload
npm start              # run the built server
npm run check          # format + lint + typecheck + test
npm test               # tests only
npm run build          # compile to dist/

npm run cli -- doctor                  # preflight everything
npm run cli -- voices                  # list voices
npm run cli -- numbers list
npm run cli -- numbers show        --id phone_xxx
npm run cli -- numbers register    --number +1555... --url https://…/webhooks/xai
npm run cli -- numbers set-webhook --id phone_xxx --url https://…/webhooks/xai
npm run cli -- numbers delete      --id phone_xxx
npm run cli -- simulate-call
```

## Security and privacy

- **Every webhook is verified** using Standard Webhooks v1 (HMAC-SHA256 over
  `{id}.{timestamp}.{body}`), with a replay window and a constant-time compare.
  Signature checking runs on the raw bytes, before the body is parsed. Unsigned
  mode is refused outright when `NODE_ENV=production`.
- **Secrets stay out of git.** `.env`, `agent.yaml` (it holds real phone
  numbers), and `data/` are all gitignored. Authorization and signature headers
  are redacted from logs.
- **Transcripts are personal data.** `data/*.jsonl` holds what callers said.
  `GET /calls` and `GET /messages` are not registered at all unless you set
  `DASHBOARD_TOKEN`.
- **Prompt injection is anticipated.** The persona explicitly instructs the
  agent to ignore instructions given by callers, never to impersonate a human,
  and never to commit to anything on your behalf.
- Set `agent.transcribe_caller: false` if you would rather not store what
  callers say. Recording and transcribing calls is regulated in many places —
  check your local two-party consent rules before pointing this at real people.

## Layout

The call logic is runtime-agnostic: signature verification uses Web Crypto and
the call bridge is written against the standard WebSocket event API, so the
same code drives a call on Node and inside a Durable Object.

```
src/                  shared core — runs on both Node and Workers
  config/             env + agent.yaml schemas (zod)
  webhooks/           Standard Webhooks verification, event parsing
  realtime/           call bridge, session builder, socket abstraction
  agent/              persona builder, tool definitions and dispatch
  storage/            CallStore interface + JSONL implementation
  xai/                REST client (call control + phone numbers)
  server.ts           Fastify app (Node)
  cli.ts              voice-agent CLI
worker/               Cloudflare Workers entry
  index.ts            webhook handler and read-only endpoints
  call-session.ts     Durable Object holding one call's WebSocket
  kv-store.ts         CallStore backed by Workers KV
tests/                134 tests, incl. a fake realtime server driving full calls
```

## License

MIT — see [LICENSE](LICENSE).
