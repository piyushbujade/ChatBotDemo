# Project Notes

## Stage 1: Local Chatbot Demo (Website Widget) — verified locally ✅

**Goal:** Real, working chatbot on the website widget panel, tested fully on localhost. WhatsApp/Instagram are visual skins only, no backend. Node.js + Express server calling the Anthropic API. Simple keyword-matching RAG.

**Built so far:**
- `server/package.json` — express, @anthropic-ai/sdk, dotenv (+ nodemon as dev dep)
- `server/.env.example` — `ANTHROPIC_API_KEY`, `PORT` (copy to `.env` and fill in your real key; `.env` is gitignored)
- `server/knowledge/faq.js` — placeholder FAQ content (hours, pricing, services, contact, location, booking, refunds, payment, human handoff). *(Superseded in Stage 2 — moved to `server/clients/default.json`; see below.)*
- `server/rag.js` — `findRelevantFaq(message)`: simple keyword-overlap scoring against the FAQ list, no embeddings/external deps. *(Signature changed in Stage 2 to accept the FAQ list as a parameter.)*
- `server/index.js` — Express app: serves `demo/` as static, `POST /api/chat` builds a system prompt (persona + matched FAQ context) and calls Anthropic Messages API, model `claude-haiku-4-5-20251001` (cheapest capable Claude model, picked for cost during local testing).
- `demo/index.html` — single page, 3 tabs: **Website Widget** (fully functional chat UI wired to `/api/chat`), **WhatsApp** (static visual skin, pre-scripted messages, input disabled), **Instagram** (same, IG DM visual skin, input disabled).

**Decisions made:**
- Model: Anthropic Claude Haiku 4.5, not OpenAI — user asked about a cheaper option, confirmed staying on Anthropic per CLAUDE.md's explicit instruction rather than switching providers.
- Knowledge base: generic placeholder business FAQ (not a specific real business) — easy to swap later.

## Resolved blockers (historical)
- **Node.js too old:** machine originally had Node v15.14.0; Anthropic SDK requires Node 18+ (`node:fs` import failure). User upgraded to **Node v24.18.0** — resolved, clean `npm install` with no engine warnings.
- **API key placement mistake:** user initially pasted their real Anthropic API key into `server/.env.example` (not gitignored) instead of `server/.env` (gitignored). Caught and corrected — key now lives only in `.env`; `.env.example` restored to a blank template. **Note for future stages:** double-check `.env.example` never contains a real secret before any commit/push.

## Verification results
- Server starts cleanly: `Chatbot demo server running at http://localhost:3000`, no missing-key warning.
- `POST /api/chat` tested via curl:
  - FAQ-matching message ("what are your hours?") → correct grounded answer from `faq.js` content.
  - Unrelated message ("write me a haiku about coffee") → sensible general Claude reply, no FAQ forced in.
- Manual browser check by user: widget UI confirmed working. Feedback: WhatsApp/Instagram should share the live conversation and be interactive too, not static — "visual skins" was meant to describe look, not behavior. → led to Stage 1b below.

## Stage 1b: Interactive WhatsApp/Instagram skins — done ✅

**Change:** `demo/index.html` refactored so all three panels (Website Widget, WhatsApp, Instagram) share one conversation. Server code (`index.js`, `rag.js`, `knowledge/faq.js`) untouched — same `/api/chat` endpoint and contract.
- Single shared `history` array; `renderAll()` re-renders it into all three panels' message containers each time it changes, mapping role → the correct CSS bubble class per skin (widget: `msg user`/`msg bot`; WhatsApp: `wa-bubble out`/`wa-bubble in`; Instagram: `ig-bubble out`/`ig-bubble in`).
- All three inputs/send buttons now call the same shared `sendMessage()` — removed the `disabled` attributes and `cursor:not-allowed` styling that made WhatsApp/Instagram non-functional. Only one `/api/chat` request fires per message regardless of which panel it was sent from.
- Removed the static pre-scripted example messages that used to be hardcoded into the WhatsApp/Instagram panels; they now start from the same shared greeting as the widget.
- Updated on-page copy (subtitle + skin-note lines) to say these are the same chatbot with a different look, not disconnected mockups.
- Updated `CLAUDE.md` to match this behavior — WhatsApp/Instagram are now documented as interactive skins sharing the widget's backend, still not integrated with real WhatsApp Business/Instagram Graph APIs.

**Manual browser check:** confirmed by user — shared history across tabs, all three inputs working, single network call per message.

## Stage 2: Multi-tenant client configs + abuse limits — done ✅

**Goal:** each cold-email lead gets a unique link (`?client=<slug>`) that loads a config tailored to their business, plus limits so no one can spam the chat and burn the Anthropic API budget.

**Built:**
- `server/clients/` — replaces `server/knowledge/faq.js` (deleted). Each file is one client's config: `{ businessName, greeting, persona, faq: [...] }`. `default.json` holds the old generic placeholder content as the fallback. `acme-dental.json` is a throwaway test fixture with clearly different content, proving multi-tenant switching works — delete once real client configs exist. `README.md` documents the schema and the "paste business info to Claude, save as `<slug>.json`" authoring workflow.
- `server/rag.js` — `findRelevantFaq(message)` → `findRelevantFaq(message, faqList)`, now scores against whichever client's FAQ was loaded instead of one hardcoded file.
- `server/index.js`:
  - `loadClientConfig(clientId)` — validates against `/^[a-z0-9-]{1,64}$/`, blocks path traversal, falls back to `default.json` on any invalid/missing/unparseable id.
  - New `GET /api/client-config?client=<id>` → `{ businessName, greeting }` for the frontend to personalize on load.
  - `POST /api/chat` now takes `clientId` in the body; builds the system prompt from that client's `persona` + FAQ matches.
  - Abuse limits (defaults; overridable via `.env` — see `.env.example`): per-IP throttle via `express-rate-limit` (15 requests/15min), per-client daily cap via an in-memory `Map` (30 messages/day, resets on restart, no DB), message length guard (max 500 chars).
- `demo/index.html` — reads `?client=` from the URL on load, fetches `/api/client-config`, updates the widget/WhatsApp/Instagram header text + greeting to the business name, and sends `clientId` on every `/api/chat` call.

**Verification (all passed via curl):**
- Default vs `acme-dental` return different, correctly-scoped FAQ answers (different hours, pricing, etc.).
- `/api/client-config` returns correct data for `default` and `acme-dental`; falls back cleanly to `default` for a nonexistent client id and for a path-traversal attempt (`..%2F..%2Fserver%2Findex`) — no crash, no file leakage.
- Message >500 chars → `400` with a clear error.
- 16th `/api/chat` request from the same IP within 15 minutes → `429` from the per-IP limiter.
- With `PER_CLIENT_DAILY_MAX` temporarily set to 2: 3rd message to `acme-dental` → `429` daily-limit message; `default` client's counter confirmed independent (unaffected by acme-dental's cap).

**Manual browser check:** confirmed by user — header/greeting personalize correctly for `?client=acme-dental` across all three tabs.

**Stage 2 fully verified — ready to move to Stage 3 (appointment booking + notifications) once planned.**

## Stage 3: Appointment booking + business notifications — built, pending manual browser check

**Goal:** the chatbot can check and book appointments via real Claude tool use, only within the current week, scoped per client — plus a live calendar + notifications panel on the page.

**Built:**
- `server/clients/*.json` — added `businessHours: { days, startTime, endTime, slotMinutes }` to the config schema (`default.json`: Mon–Fri 9–5 hourly; `acme-dental.json`: Mon–Fri 8–5 hourly). Documented in `server/clients/README.md`. Configs that omit it fall back to the same default.
- `server/calendar.js` (new) — in-memory, per-client, current-week-only calendar. `ensureCalendar` generates/regenerates the week's slots from `businessHours`; `checkAvailability`/`bookAppointment` validate against the current week, already-booked slots, and already-past times; `logActivity`/`getActivity` maintain a per-client activity log (capped 50 entries, newest first).
- `server/bookingIntent.js` (new) — `detectBookingIntent(message, history)`, same keyword-overlap style as `rag.js`, checking the current message plus recent history so an in-progress booking flow ("yes", "Thursday") keeps tools enabled.
- `server/index.js`:
  - Two tool schemas (`check_availability`, `book_appointment`) attached to `/api/chat` **only** when `detectBookingIntent` trips — plain FAQ turns are unchanged from Stage 2, no extra tokens.
  - Manual bounded tool-use loop (max 4 iterations): call → execute any `tool_use` blocks against `calendar.js` → send `tool_result`s back → repeat until a final text reply.
  - New `GET /api/calendar?client=<id>` (public-facing: availability only, no customer names) and `GET /api/activity?client=<id>` (business-facing: includes customer names, simulating what the business owner would see).
- `demo/index.html` — added "This Week's Availability" (calendar grid) and "Business Notifications" (activity feed) cards, always visible below the chat tabs regardless of skin. Both refresh after every chat exchange and poll every 8s.

**Bug found & fixed during verification:** `calendar.js`'s original `formatDate()` used `date.toISOString().slice(0,10)`, which converts to UTC — on a UTC+5:30 (IST) machine this shifted every date back by one day (e.g. local Monday showed as Sunday's date), and the same pattern existed in `server/index.js` for the daily-message-cap key and the "today's date" told to Claude. Fixed by switching to a local-timezone `formatDate()` (using `getFullYear()`/`getMonth()`/`getDate()`) exported from `calendar.js` and reused in both `index.js` spots. Confirmed fixed — calendar now correctly shows today (2026-07-13, Monday) as the first day.

**Verification (all passed via curl):**
- FAQ-only message → `bookingTools=false` logged, unchanged Stage 2 behavior.
- "I'd like to book an appointment" → Claude asks for day/time/name conversationally (not scripted); "what's available this week?" → correctly calls `check_availability`, returns real per-day open slots.
- Full booking (day + time + name in one message) → confirmed, `GET /api/calendar` shows the slot `booked: true`, `GET /api/activity` shows `"Jane Doe booked an appointment on 2026-07-14 at 09:00."`.
- Double-booking the same slot → rejected gracefully, Claude offers alternative times from the tool's error response.
- Booking a date outside the current week (next Monday) → rejected, Claude explains only the current week is bookable.
- `default` and `acme-dental` confirmed fully independent: different business hours (9–5 vs 8–5), separate calendars, separate activity logs (`default`'s stayed empty throughout).

**Manual browser check:** confirmed by user — calendar grid and notifications panel render correctly, update live after a booking, and stay visible across all three skin tabs.

**Stage 3 fully verified — the app is now feature-complete for the local demo (Stages 1–3). Next up is Stage 4 (hosting), not started, needs explicit go-ahead.**

## Stage 4: Hosting on Render (free tier) — live ✅

**Live URL:** https://chatbot-demo-oyvg.onrender.com — this + `?client=<slug>` is what goes in cold emails going forward.

**Goal:** get the verified local demo behind a public URL on Render's free tier, per CLAUDE.md.

**Built:**
- Root-level `.gitignore` (`server/node_modules/`, `server/.env`, `.claude/`).
- `server/package.json` — added `"engines": { "node": ">=18" }` to pin a compatible Node version on Render's build image.
- `render.yaml` (project root) — Render Blueprint: `rootDir: server`, `buildCommand: npm install`, `startCommand: node index.js`, free plan, `ANTHROPIC_API_KEY` set with `sync: false` so it's entered via the Render dashboard and never stored in the repo.
- Local git repo initialized at project root, first commit reviewed file-by-file before staging (confirmed `server/.env` and `node_modules/` excluded, `.env.example` stays blank) — pushed to a private GitHub repo (`github.com/piyushbujade/ChatBotDemo`), then deployed via Render's Blueprint flow.

**🚧 Production bug found & fixed:** immediately after first deploy, the live site was flapping — roughly 40% of *all* requests (including the plain static homepage) returned a platform-level `404 no-server` from Render's edge, completely at random. Diagnosed via the user pulling Render's live logs (I have no dashboard/log access), which showed:
```
ValidationError: The 'X-Forwarded-For' header is set but the Express 'trust proxy' setting is false (default)...
code: 'ERR_ERL_UNEXPECTED_X_FORWARDED_FOR'
```
`express-rate-limit` v7 refuses to run behind a reverse proxy (Render + its Cloudflare edge, which set `X-Forwarded-For` on every request) unless Express's `trust proxy` is configured. The error was an unhandled rejection inside the rate-limiter middleware, which **crashed the entire Node process on every `/api/chat` request** — explaining why even unrelated routes failed intermittently (they were caught in the crash/restart cycle, not broken themselves). Fixed with one line in `server/index.js`: `app.set("trust proxy", true)`, right after the `app` is created. Committed, pushed, Render auto-redeployed. Verified fixed: 5 consecutive rapid `/api/chat` calls all succeeded post-fix (would have crashed the old code almost immediately).

**Verification (against the live URL, post-fix):**
- Default vs `acme-dental` FAQ answers correctly differ.
- `/api/client-config` personalizes correctly.
- `/api/calendar` generates the correct current week.
- `/api/activity` correctly empty on a fresh deploy (in-memory, as designed).
- Booking flow initiates correctly ("I want to book an appointment" → asks for day/time naturally).

**Known limitations (by design, not bugs):**
- Render free tier spins down after ~15 min idle; first request after that takes ~30-50s to cold-start. A cold-emailed lead's first message might feel slow.
- All in-memory state (daily message counts, calendar bookings, activity log) resets on every restart/redeploy — same "no persistence" design as local, just triggered more often by Render's free-tier idling.
- New client configs must be committed + pushed to `server/clients/` (not just saved locally) for leads to get personalized links in production.

**Explicit stop point:** this stage ends here. Upgrading to an isolated per-client paid instance (per CLAUDE.md) is out of scope until someone pays.

## Post-Stage-4 fix: raw markdown showing in chat bubbles

**Bug:** Claude occasionally wrote markdown (`**bold**`) in replies, but the chat UI renders messages as plain text (`div.textContent`, by design — avoids any risk of rendering raw HTML from the model). Result: literal `**` asterisks visible in the bubble instead of bold text.

**Options considered:** (1) instruct Claude to never use markdown, plain text only; (2) render markdown client-side into safe HTML (escape-then-convert, to avoid a prompt-injection-driven XSS path). Discussed the tradeoff with the user — richer formatting vs. more code/new attack surface. **Decision: option 1** — simplest, zero new code surface, no XSS risk to reason about, matches the "simple to start" approach.

**Fix:** added one line to the system prompt in `server/index.js` (always included, not just when booking tools are active): *"Reply in plain text only — no markdown. Never use **bold**, _italics_, backticks, bullet points with - or *, or # headers; the chat widget displays raw text, so markdown symbols would show up literally instead of being formatted."*

**Verified locally:** re-tested the exact question that previously produced `**bold**` (acme-dental hours) 3x — clean every time. Also tested a booking-rejection reply and a multi-topic FAQ answer (services + payment, the kind of question that invites bullet lists) — no markdown in either. Pushed to production.
