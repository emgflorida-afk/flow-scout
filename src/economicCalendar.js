// economicCalendar.js — Stratum Flow Scout
// PURPOSE: Detect high-impact economic events
// On CPI/NFP/FOMC days → delay entries, reduce size, add warnings
// ─────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');

// ── IMPACT LEVELS ────────────────────────────────────────────────
const IMPACT = {
  HIGH:   'HIGH',   // CPI, NFP, FOMC — delay entries to 11AM
  MEDIUM: 'MEDIUM', // PPI, retail sales — caution, normal window
  LOW:    'LOW',    // minor data — no change
};

// ── KEYWORDS THAT SIGNAL HIGH IMPACT ─────────────────────────────
const HIGH_IMPACT_KEYWORDS = [
  'CPI', 'Consumer Price Index',
  'NFP', 'Non-Farm Payroll', 'Nonfarm',
  'FOMC', 'Federal Reserve', 'Fed Rate', 'Interest Rate Decision',
  'GDP', 'Gross Domestic Product',
  'PCE', 'Personal Consumption',
  'Unemployment Rate', 'Jobs Report',
  'PPI', 'Producer Price Index',
];

// ── FETCH TODAY'S EVENTS FROM NASDAQ ─────────────────────────────
async function fetchEconomicEvents() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const url   = `https://api.nasdaq.com/api/calendar/economicevents?date=${today}`;

    const res  = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const data = await res.json();

    const rows = data?.data?.rows || [];
    return rows.map(row => ({
      time:   row.time   || '',
      name:   row.name   || row.eventName || '',
      impact: row.importance || '',
      actual: row.actual || '',
      forecast: row.consensus || '',
    }));
  } catch (err) {
    console.error('[CALENDAR] Fetch failed:', err.message);
    return [];
  }
}

// ── ANALYZE TODAY'S EVENTS ────────────────────────────────────────
async function getTodayImpact() {
  const events = await fetchEconomicEvents();
  const highEvents = [];

  for (const event of events) {
    const nameUpper = event.name.toUpperCase();
    const isHigh = HIGH_IMPACT_KEYWORDS.some(kw => nameUpper.includes(kw.toUpperCase()));
    if (isHigh) {
      highEvents.push(event);
    }
  }

  if (highEvents.length === 0) {
    return {
      hasHighImpact: false,
      events:        [],
      warning:       null,
      entryRule:     'Normal — trade 10AM–11:30AM and 3PM–3:45PM',
      alertPrefix:   '',
    };
  }

  const names = highEvents.map(e => e.name).join(', ');

  return {
    hasHighImpact: true,
    events:        highEvents,
    warning:       `⚠️ HIGH IMPACT EVENT TODAY: ${names}`,
    entryRule:     '🔴 DELAY entries until 11AM — let whipsaw settle first',
    alertPrefix:   `🗓️ ${names} DAY — `,
  };
}

// ── FORMAT FOR MORNING BRIEF ─────────────────────────────────────
async function getCalendarBriefLine() {
  const impact = await getTodayImpact();

  if (!impact.hasHighImpact) {
    return {
      line:          '📅 No major economic events today',
      hasHighImpact: false,
      entryRule:     impact.entryRule,
    };
  }

  const eventNames = impact.events.map(e => e.name).join(' + ');
  return {
    line:          `🔴 HIGH IMPACT: ${eventNames} — Wait until 11AM for entries`,
    hasHighImpact: true,
    entryRule:     impact.entryRule,
    events:        impact.events,
  };
}

// ── SHOULD BLOCK ALERT ────────────────────────────────────────────
// Returns true if we should block/delay an alert due to calendar
async function shouldBlockAlert() {
  const impact = await getTodayImpact();
  if (!impact.hasHighImpact) return { block: false };

  // Check current time — block alerts before 11AM on high impact days
  const now = new Date();
  const etHour = now.getUTCHours() - 4; // UTC-4 for ET (adjust for DST)
  const etMin  = now.getUTCMinutes();
  const etTime = etHour + etMin / 60;

  if (etTime < 11.0) {
    return {
      block:   true,
      reason:  `High impact event day — waiting until 11AM ET (now ${etHour}:${String(etMin).padStart(2,'0')} ET)`,
      events:  impact.events,
    };
  }

  return { block: false, warning: impact.warning };
}

module.exports = {
  getTodayImpact,
  getCalendarBriefLine,
  shouldBlockAlert,
};
