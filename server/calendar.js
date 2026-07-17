// Simulated, per-client, rolling-window appointment calendar: bookable
// days are the next WINDOW_DAYS_AHEAD calendar days from today (inclusive),
// filtered to the business's open days. E.g. if today is Saturday, the
// window still reaches forward into next week's business days instead of
// going empty — a fixed Mon-Sun calendar week would do that. In-memory
// only — clears on server restart; per-day slots persist across the daily
// window recompute so existing bookings aren't lost as the window rolls
// forward, and stale (past) days are pruned.

const WEEKDAY_CODES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WINDOW_DAYS_AHEAD = 7; // today + this many days, inclusive

const DEFAULT_BUSINESS_HOURS = {
  days: ["mon", "tue", "wed", "thu", "fri"],
  startTime: "09:00",
  endTime: "17:00",
  slotMinutes: 60
};

const calendarDays = new Map(); // clientId -> Map<dateStr, slots[]>
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

function generateSlots(businessHours) {
  const slots = [];
  const start = timeToMinutes(businessHours.startTime);
  const end = timeToMinutes(businessHours.endTime);
  for (let t = start; t < end; t += businessHours.slotMinutes) {
    slots.push({ time: minutesToTime(t), booked: false, bookedBy: null });
  }
  return slots;
}

// The bookable date strings for today's rolling window, filtered to the
// business's open weekdays. Pure function of "today" — does not touch
// any stored state.
function getWindowDates(businessHours, reference = new Date()) {
  const start = new Date(reference);
  start.setHours(0, 0, 0, 0);

  const dates = [];
  for (let i = 0; i <= WINDOW_DAYS_AHEAD; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const code = WEEKDAY_CODES[d.getDay()];
    if (!businessHours.days.includes(code)) continue;
    dates.push(formatDate(d));
  }
  return dates;
}

function ensureCalendar(clientId, businessHours) {
  const hours = businessHours || DEFAULT_BUSINESS_HOURS;
  if (!calendarDays.has(clientId)) calendarDays.set(clientId, new Map());
  const dayMap = calendarDays.get(clientId);

  const windowDates = getWindowDates(hours);

  // Create slots for any window date we haven't seen yet — existing days
  // (including any bookings on them) are left untouched.
  for (const dateStr of windowDates) {
    if (!dayMap.has(dateStr)) {
      dayMap.set(dateStr, generateSlots(hours));
    }
  }

  // Prune days that have fallen out of the window (yesterday and older)
  // so this doesn't grow unbounded over a long-running process.
  const todayStr = formatDate(new Date());
  for (const dateStr of dayMap.keys()) {
    if (dateStr < todayStr) dayMap.delete(dateStr);
  }

  return { days: windowDates.map((dateStr) => ({ date: dateStr, slots: dayMap.get(dateStr) })) };
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
    return { isError: false, content: `Upcoming availability:\n${summary.join("\n")}` };
  }

  const day = cal.days.find((d) => d.date === dateStr);
  if (!day) {
    const validDates = cal.days.map((d) => d.date).join(", ");
    return {
      isError: true,
      content: `${dateStr} is not bookable — only these upcoming dates are available (${validDates}).`
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
      content: `${dateStr} is not bookable — only these upcoming dates are available (${validDates}).`
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
