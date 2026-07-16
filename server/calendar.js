// Simulated, per-client, current-week-only appointment calendar.
// In-memory only — clears on server restart, regenerates automatically
// when the current week changes. No persistence, matches the rest of
// this demo's "simple to start" approach.

const WEEKDAY_CODES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const DEFAULT_BUSINESS_HOURS = {
  days: ["mon", "tue", "wed", "thu", "fri"],
  startTime: "09:00",
  endTime: "17:00",
  slotMinutes: 60
};

const calendars = new Map(); // clientId -> { weekKey, days: [{date, slots}] }
const activityLogs = new Map(); // clientId -> entries[] (newest first)
const MAX_ACTIVITY_ENTRIES = 50;

// Local-date formatting (not toISOString, which converts to UTC and can
// shift the date by one day for timezones ahead of UTC, e.g. IST).
function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function timeToMinutes(time) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTime(minutes) {
  const h = String(Math.floor(minutes / 60)).padStart(2, "0");
  const m = String(minutes % 60).padStart(2, "0");
  return `${h}:${m}`;
}

function getCurrentWeekMonday(reference = new Date()) {
  const d = new Date(reference);
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function generateSlots(businessHours) {
  const slots = [];
  const start = timeToMinutes(businessHours.startTime);
  const end = timeToMinutes(businessHours.endTime);
  for (let t = start; t < end; t += businessHours.slotMinutes) {
    slots.push({ time: minutesToTime(t), booked: false, bookedBy: null });
  }
  return slots;
}

function generateWeekDays(monday, businessHours) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    const code = WEEKDAY_CODES[d.getDay()];
    if (!businessHours.days.includes(code)) continue;
    days.push({ date: formatDate(d), slots: generateSlots(businessHours) });
  }
  return days;
}

function ensureCalendar(clientId, businessHours) {
  const hours = businessHours || DEFAULT_BUSINESS_HOURS;
  const monday = getCurrentWeekMonday();
  const weekKey = formatDate(monday);

  const existing = calendars.get(clientId);
  if (existing && existing.weekKey === weekKey) {
    return existing;
  }

  const cal = { weekKey, days: generateWeekDays(monday, hours) };
  calendars.set(clientId, cal);
  return cal;
}

function isInPast(dateStr, timeStr) {
  const slotDate = new Date(`${dateStr}T${timeStr}:00`);
  return slotDate.getTime() < Date.now();
}

function checkAvailability(clientId, businessHours, dateStr) {
  const cal = ensureCalendar(clientId, businessHours);

  if (!dateStr) {
    const summary = cal.days.map((day) => {
      const open = day.slots.filter((s) => !s.booked && !isInPast(day.date, s.time));
      const times = open.slice(0, 4).map((s) => s.time).join(", ");
      return `${day.date}: ${open.length > 0 ? times : "fully booked"}`;
    });
    return { isError: false, content: `Availability this week:\n${summary.join("\n")}` };
  }

  const day = cal.days.find((d) => d.date === dateStr);
  if (!day) {
    const validDates = cal.days.map((d) => d.date).join(", ");
    return {
      isError: true,
      content: `${dateStr} is not bookable — only this current week is available (${validDates}).`
    };
  }

  const open = day.slots.filter((s) => !s.booked && !isInPast(day.date, s.time));
  if (open.length === 0) {
    return { isError: false, content: `No open slots on ${dateStr} — it's fully booked or already passed.` };
  }
  return { isError: false, content: `Available on ${dateStr}: ${open.map((s) => s.time).join(", ")}` };
}

function bookAppointment(clientId, businessHours, dateStr, timeStr, name) {
  const cal = ensureCalendar(clientId, businessHours);

  const day = cal.days.find((d) => d.date === dateStr);
  if (!day) {
    const validDates = cal.days.map((d) => d.date).join(", ");
    return {
      isError: true,
      content: `${dateStr} is not bookable — only this current week is available (${validDates}).`
    };
  }

  const slot = day.slots.find((s) => s.time === timeStr);
  if (!slot) {
    return { isError: true, content: `${timeStr} is not a valid slot time on ${dateStr}.` };
  }
  if (isInPast(dateStr, timeStr)) {
    return { isError: true, content: `${dateStr} ${timeStr} has already passed.` };
  }
  if (slot.booked) {
    const open = day.slots.filter((s) => !s.booked && !isInPast(day.date, s.time)).map((s) => s.time);
    return {
      isError: true,
      content: `That slot just got taken. Other options on ${dateStr}: ${open.length > 0 ? open.join(", ") : "none left today"}.`
    };
  }

  slot.booked = true;
  slot.bookedBy = name;
  logActivity(clientId, `${name} booked an appointment on ${dateStr} at ${timeStr}.`);

  return { isError: false, content: `Booked! ${name} is confirmed for ${dateStr} at ${timeStr}.` };
}

function logActivity(clientId, message) {
  const entries = activityLogs.get(clientId) || [];
  entries.unshift({ message, timestamp: new Date().toISOString() });
  if (entries.length > MAX_ACTIVITY_ENTRIES) entries.length = MAX_ACTIVITY_ENTRIES;
  activityLogs.set(clientId, entries);
}

function getActivity(clientId) {
  return activityLogs.get(clientId) || [];
}

module.exports = {
  DEFAULT_BUSINESS_HOURS,
  ensureCalendar,
  checkAvailability,
  bookAppointment,
  logActivity,
  getActivity,
  formatDate
};
