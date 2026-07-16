// Lightweight keyword check (same style as rag.js) deciding whether to
// attach the booking tool schemas to a /api/chat request. Keeps plain
// FAQ turns free of tool-schema token overhead.

const BOOKING_KEYWORDS = [
  "book", "booking", "appointment", "schedule", "available",
  "availability", "slot", "reschedule", "reserve", "reservation", "meeting"
];

const HISTORY_LOOKBACK = 4;

function mentionsBooking(text) {
  const lower = text.toLowerCase();
  return BOOKING_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function detectBookingIntent(message, history) {
  if (mentionsBooking(message)) return true;

  const recent = Array.isArray(history) ? history.slice(-HISTORY_LOOKBACK) : [];
  return recent.some((entry) => entry && typeof entry.content === "string" && mentionsBooking(entry.content));
}

module.exports = { detectBookingIntent };
