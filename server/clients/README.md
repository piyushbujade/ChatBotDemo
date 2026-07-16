# Client configs

Each file in this folder is one cold-email lead's chatbot config. `default.json` is the fallback used when no `client` link parameter is given, or when the given one doesn't match a file.

## Schema

```json
{
  "businessName": "Acme Dental",
  "greeting": "Hi! Ask me about Acme Dental's hours, pricing, services, or anything else.",
  "persona": "You are a friendly, concise support assistant for Acme Dental, a family dental clinic. Answer clearly in 1-3 sentences unless more detail is truly needed.",
  "businessHours": {
    "days": ["mon", "tue", "wed", "thu", "fri"],
    "startTime": "09:00",
    "endTime": "17:00",
    "slotMinutes": 60
  },
  "faq": [
    { "keywords": ["hours", "open"], "answer": "..." }
  ]
}
```

- `businessName` — shown in the chat header/greeting.
- `greeting` — the bot's first message, shown when the page loads.
- `persona` — short system-prompt description of the business and tone.
- `businessHours` — drives the simulated appointment calendar (see `server/calendar.js`). `days` uses lowercase 3-letter weekday codes (`mon`..`sun`); `startTime`/`endTime` are 24-hour `HH:MM`; `slotMinutes` is the interval between bookable slots. Optional — configs that omit it fall back to `default.json`'s hours.
- `faq` — array of `{ keywords: [...], answer: "..." }` entries, scored by keyword overlap against each user message (see `server/rag.js`).

## Creating a new client

1. Paste the business's website/info into a conversation with Claude and ask it to draft a config matching the schema above.
2. Save it as `server/clients/<slug>.json` — lowercase letters, numbers, and hyphens only (e.g. `acme-dental.json`).
3. Send that lead: `http://localhost:3000/?client=<slug>` (swap in the deployed URL once hosted).

`acme-dental.json` in this folder is a throwaway example proving multi-tenant switching works — delete it once you start adding real clients.
