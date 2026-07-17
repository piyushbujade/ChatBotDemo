require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const rateLimit = require("express-rate-limit");
const Anthropic = require("@anthropic-ai/sdk");
const { findRelevantFaq } = require("./rag");
const { detectBookingIntent } = require("./bookingIntent");
const calendar = require("./calendar");

const app = express();
// Render sits in front of this app as a single reverse-proxy hop and sets
// X-Forwarded-For on every request. Without any trust proxy setting,
// express-rate-limit throws on that header and crashes the process (see
// NOTES.md Stage 4). `true` "fixed" that but trusts every hop
// unconditionally, letting a client spoof X-Forwarded-For to fake any IP
// and bypass the per-IP rate limit entirely — express-rate-limit flags
// this itself (ERR_ERL_PERMISSIVE_TRUST_PROXY). `1` trusts exactly one
// hop, which is correct for Render's setup.
app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;
const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOOL_ITERATIONS = 4;

const CLIENTS_DIR = path.join(__dirname, "clients");
const CLIENT_ID_PATTERN = /^[a-z0-9-]{1,64}$/;
const MAX_MESSAGE_LENGTH = Number(process.env.MAX_MESSAGE_LENGTH) || 500;
const PER_IP_WINDOW_MS = Number(process.env.PER_IP_WINDOW_MS) || 15 * 60 * 1000;
const PER_IP_MAX_REQUESTS = Number(process.env.PER_IP_MAX_REQUESTS) || 15;
const PER_CLIENT_DAILY_MAX = Number(process.env.PER_CLIENT_DAILY_MAX) || 30;

const BOOKING_TOOLS = [
  {
    name: "check_availability",
    description: "Check open appointment slots for this business. Only the next 7 days from today are bookable (weekends excluded). Omit 'date' to get a summary across all upcoming bookable days.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date to check in YYYY-MM-DD format, must be within the next 7 days. Optional." }
      }
    }
  },
  {
    name: "book_appointment",
    description: "Book an appointment slot. Only call this after the user has confirmed a specific date and time that you've verified is available, and you have their name.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD, must be within the next 7 days from today" },
        time: { type: "string", description: "24-hour HH:MM matching one of the business's slot times" },
        name: { type: "string", description: "Customer's name for the booking" }
      },
      required: ["date", "time", "name"]
    }
  }
];

app.use(express.json());
app.use(express.static(path.join(__dirname, "../demo")));

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// In-memory per-client daily message counts. Resets on server restart —
// fine for a low-traffic cold-email demo, no DB needed.
const clientDailyCounts = new Map();

function loadClientConfig(clientId) {
  const isValidId = typeof clientId === "string" && CLIENT_ID_PATTERN.test(clientId);
  const targetId = isValidId ? clientId : "default";

  try {
    const filePath = path.join(CLIENTS_DIR, `${targetId}.json`);
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (targetId === "default") {
      throw err;
    }
    return loadClientConfig("default");
  }
}

function checkClientDailyLimit(clientId) {
  const today = calendar.formatDate(new Date());
  const key = `${clientId}:${today}`;
  const count = clientDailyCounts.get(key) || 0;

  if (count >= PER_CLIENT_DAILY_MAX) {
    return false;
  }

  clientDailyCounts.set(key, count + 1);
  return true;
}

function executeTool(clientId, businessHours, toolName, input) {
  console.log(`[tool] ${toolName} input=${JSON.stringify(input)}`);
  if (toolName === "check_availability") {
    const result = calendar.checkAvailability(clientId, businessHours, input.date);
    console.log(`[tool] check_availability result=${JSON.stringify(result)}`);
    return result;
  }
  if (toolName === "book_appointment") {
    const result = calendar.bookAppointment(clientId, businessHours, input.date, input.time, input.name);
    console.log(`[tool] book_appointment result=${JSON.stringify(result)}`);
    return result;
  }
  return { isError: true, content: `Unknown tool: ${toolName}` };
}

const chatRateLimiter = rateLimit({
  windowMs: PER_IP_WINDOW_MS,
  max: PER_IP_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many messages sent too quickly. Please wait a bit and try again." }
});

app.get("/api/client-config", (req, res) => {
  const clientId = typeof req.query.client === "string" ? req.query.client : "";
  const config = loadClientConfig(clientId);
  res.json({ businessName: config.businessName, greeting: config.greeting });
});

app.get("/api/calendar", (req, res) => {
  const clientId = typeof req.query.client === "string" && CLIENT_ID_PATTERN.test(req.query.client)
    ? req.query.client
    : "default";
  const config = loadClientConfig(clientId);
  res.json(calendar.getPublicCalendar(clientId, config.businessHours));
});

app.get("/api/activity", (req, res) => {
  const clientId = typeof req.query.client === "string" && CLIENT_ID_PATTERN.test(req.query.client)
    ? req.query.client
    : "default";
  res.json({ events: calendar.getActivity(clientId) });
});

app.post("/api/chat", chatRateLimiter, async (req, res) => {
  if (!anthropic) {
    return res.status(500).json({
      error: "Server is missing ANTHROPIC_API_KEY. Add it to server/.env and restart."
    });
  }

  const { message, history, clientId } = req.body;
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "Request must include a 'message' string." });
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Message is too long (max ${MAX_MESSAGE_LENGTH} characters).` });
  }

  const resolvedClientId = typeof clientId === "string" && CLIENT_ID_PATTERN.test(clientId)
    ? clientId
    : "default";

  if (!checkClientDailyLimit(resolvedClientId)) {
    return res.status(429).json({
      error: "This chatbot demo has reached its daily message limit. Please check back tomorrow or reach out directly."
    });
  }

  const config = loadClientConfig(resolvedClientId);
  const businessHours = config.businessHours || calendar.DEFAULT_BUSINESS_HOURS;
  const faqMatches = findRelevantFaq(message, config.faq);

  const messages = Array.isArray(history)
    ? history.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    : [];
  messages.push({ role: "user", content: message });

  const useBookingTools = detectBookingIntent(message, messages.slice(0, -1));
  console.log(`[chat] client=${resolvedClientId} bookingTools=${useBookingTools}`);

  const systemPrompt = [
    config.persona,
    "Reply in plain text only — no markdown. Never use **bold**, _italics_, backticks, bullet points with - or *, or # headers; the chat widget displays raw text, so markdown symbols would show up literally instead of being formatted.",
    faqMatches.length > 0
      ? `Relevant business FAQ info that may help answer this message:\n- ${faqMatches.join("\n- ")}`
      : "No specific FAQ entry matched this message — answer helpfully using general knowledge, and offer to connect the user with a human for anything business-specific you can't confirm.",
    useBookingTools
      ? `Today's date is ${calendar.formatDate(new Date())}. Bookable dates and their weekdays are exactly:\n${calendar.getBookableDatesWithWeekdays(businessHours).map((d) => `- ${d}`).join("\n")}\nWhen the user refers to a day by weekday name (e.g. "Monday") or a relative term ("today", "tomorrow"), look up its exact date in this list yourself — do not compute or guess it. Do not trust your own sense of what date a weekday falls on; use only this list. You have no way of knowing which dates or times are bookable, or why one isn't, except by calling check_availability or book_appointment — never state, imply, or invent a reason a date/time is unavailable unless it is exactly what the tool told you. For any date or time the user mentions, immediately call check_availability or book_appointment with the exact YYYY-MM-DD from the list above, then relay exactly what the tool returns, whether it succeeds or fails.`
      : null
  ].filter(Boolean).join("\n\n");

  try {
    const requestParams = {
      model: MODEL,
      max_tokens: 400,
      system: systemPrompt,
      messages
    };
    if (useBookingTools) {
      requestParams.tools = BOOKING_TOOLS;
    }

    let response = await anthropic.messages.create(requestParams);
    let iterations = 0;

    while (response.stop_reason === "tool_use" && iterations < MAX_TOOL_ITERATIONS) {
      messages.push({ role: "assistant", content: response.content });

      const toolResults = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          const result = executeTool(resolvedClientId, businessHours, block.name, block.input);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result.content,
            is_error: result.isError
          });
        }
      }
      messages.push({ role: "user", content: toolResults });

      response = await anthropic.messages.create({ ...requestParams, messages });
      iterations++;
    }

    const reply = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    res.json({ reply });
  } catch (err) {
    console.error("Anthropic API error:", err.message);
    res.status(502).json({ error: "The chatbot service is temporarily unavailable. Please try again shortly." });
  }
});

app.listen(PORT, () => {
  console.log(`Chatbot demo server running at http://localhost:${PORT}`);
  if (!anthropic) {
    console.warn("WARNING: ANTHROPIC_API_KEY not set — /api/chat will return an error until it is.");
  }
});
