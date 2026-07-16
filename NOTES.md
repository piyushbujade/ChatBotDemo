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

## Stage 4 (not started): Hosting
Render free tier for the cold-email demo link. Do not touch until the app is fully verified locally and the user explicitly says to move to hosting. Upgrade to isolated per-client instance only once someone pays.
