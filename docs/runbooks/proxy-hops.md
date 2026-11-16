# Procedure: measuring TRUSTED_PROXY_HOPS (P10)

From P4/P5: a wrong value puts every visitor in one rate-limit bucket (shared
NAT) or splits one visitor across many. It must be measured on a real Render
deploy, not guessed — and never on the local stack (direct loopback has no
proxy hops). Request logs carry no IP by design, so the signal is the
observable bucketing behavior in `rate_limit_buckets` (service-role SQL on
the staging project).

## How the derivation works (`api/src/lib/client-ip.ts`)

- `hops = 0`: the socket address (the edge proxy). `X-Forwarded-For` ignored.
- `hops = n`: the nth address from the right of the header. Fewer than `n`
  entries, or any invalid trusted entry → socket address.
- Each proxy in front appends the address it received the connection from.

With a one-entry probe header `X-Forwarded-For: <marker>` and L real
appending proxies, the chain is `[marker, r1..rL]`. Sweeping hops from 0
upwards, the two markers stay together until exactly `hops = L+1`, where the
marker itself is picked and they separate; beyond that the chain is too short
and they merge again. So: **correct value = smallest separating hops − 1.**

## Steps (staging, before client go-live)

1. Deploy `ragbot-api` to the Render staging service behind its real route
   (Render proxy + any CDN in front). Start with `TRUSTED_PROXY_HOPS=0`.
2. From one outside machine, send one `POST /v1/sessions`
   `{"bot_slug": "<staging-bot>"}` with `X-Forwarded-For: 203.0.113.7`
   (TEST-NET-3, never a real visitor). Count fresh preflight buckets:
   `select count(*) from public.rate_limit_buckets
      where window_start > now() - interval '2 minutes';` → C1.
3. Send one more with `X-Forwarded-For: 203.0.113.8` and count again → C2.
   Markers separated iff C2 > C1.
4. Raise `TRUSTED_PROXY_HOPS` by one, redeploy, repeat steps 2–3 (bucket rows
   from earlier rounds age out; keep the 2-minute window). The smallest hops
   value that separates the markers, minus one, is the measured value.
   Expected shape: separation at 2 → set 1 (Render alone); with a CDN in
   front, separation at 3 → set 2.
5. If nothing separates through hops = 4, the edge strips or overwrites the
   header: do not guess — keep 0, keep `SESSION_PREFLIGHT_PER_IP_LIMIT` well
   above per-bot limits, and escalate (per-IP limits cannot isolate visitors
   on that route).
6. Set the measured value in Render env, redeploy, re-run once to confirm
   the markers separate at measured + 1, and record the value per client in
   the handover.

## Guardrails

- The value is 0–10 and required; the API refuses to start without it.
- Re-measure after any change in front of the API (CDN added/removed,
  Render region move).
- Never trust more hops than measured: over-trusting lets a visitor spoof
  `X-Forwarded-For` into someone else's bucket. Under-trusting merges all
  visitors into the proxy's bucket and the per-IP limits throttle everyone.
- Markers stay in documentation ranges (203.0.113.0/24). Buckets expire on
  their own; no cleanup beyond the normal purge job.
