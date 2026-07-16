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
// Render (and its Cloudflare edge) sits in front of this app and sets
// X-Forwarded-For on every request. Without this, express-rate-limit
// throws on that header and crashes the process — see NOTES.md Stage 4.
app.set("trust proxy", true);

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
    description: "Check open appointment slots for this business. Only the current week (Mon-Fri) is bookable. Omit 'date' to get a summary across the whole week.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date to check in YYYY-MM-DD format, must be within the current week. Optional." }
      }
    }
  },
  {
    name: "book_appointment",
    description: "Book an appointment slot. Only call this after the user has confirmed a specific date and time that you've verified is available, and you have their name.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD, must be within the current week" },
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
  if (toolName === "check_availability") {
    return calendar.checkAvailability(clientId, businessHours, input.date);
  }
  if (toolName === "book_appointment") {
    return calendar.bookAppointment(clientId, businessHours, input.date, input.time, input.name);
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
  const cal = calendar.ensureCalendar(clientId, config.businessHours);

  const days = cal.days.map((day) => ({
    date: day.date,
    slots: day.slots.map((s) => ({ time: s.time, booked: s.booked }))
  }));
  res.json({ days });
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
    faqMatches.length > 0
      ? `Relevant business FAQ info that may help answer this message:\n- ${faqMatches.join("\n- ")}`
      : "No specific FAQ entry matched this message — answer helpfully using general knowledge, and offer to connect the user with a human for anything business-specific you can't confirm.",
    useBookingTools
      ? `Today's date is ${calendar.formatDate(new Date())}. You can check and book appointments using the available tools, but only within the current week (Monday-Friday). If asked about a date outside this week, explain that only this week is bookable.`
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
