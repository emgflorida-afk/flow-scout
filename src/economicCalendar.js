// economicCalendar.js — Stratum Flow Scout
// UPDATED: Deduplication, earnings calendar, better event formatting
// PURPOSE: Detect high-impact economic events + earnings on watchlist
// ─────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');

// ── HIGH IMPACT KEYWORDS ──────────────────────────────────────────
const HIGH_IMPACT_KEYWORDS = [
  'CPI', 'Consumer Price Index',
  'NFP', 'Non-Farm Payroll', 'Nonfarm',
  'FOMC', 'Federal Reserve', 'Fed Rate', 'Interest Rate Decision',
  'GDP', 'Gross Domestic Product',
  'PCE', 'Personal Consumption',
  'Unemployment Rate', 'Jobs Report',
  'PPI', 'Producer Price Index',
];

// ── WATCHLIST FOR EARNINGS CHECK ─────────────────────────────────
const EARNINGS_WATCHLIST = [
  'SPY','QQQ','IWM','NVDA','TSLA','META','GOOGL','AMZN',
  'MSFT','AMD','JPM','GS','BAC','WFC','MRNA','MRVL',
  'GUSH','UVXY','KO','PEP'
];

// ── FETCH TODAY'S ECONOMIC EVENTS ────────────────────────────────
async function fetchEconomicEvents(date) {
  try {
    const dateStr = date || new Date().toISOString().slice(0, 10);
    const url = `https://api.nasdaq.com/api/calendar/economicevents?date=${dateStr}`;
    const res  = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await res.json();
    const rows = data?.data?.rows || [];

    // DEDUP — collapse events sharing the same root keyword
    const seen    = new Set();
    const keysSeen = new Set();
    return rows
      .map(row => ({
        time:     row.time        || '',
        name:     row.name        || row.eventName || '',
        impact:   row.importance  || '',
        actual:   row.actual      || '',
        forecast: row.consensus   || '',
      }))
      .filter(e => {
        if (!e.name) return false;
        // Exact dedup first
        const exact = e.name.trim().toUpperCase();
        if (seen.has(exact)) return false;
        seen.add(exact);
        // Keyword dedup — collapse "German CPI", "Core CPI", "CPI Index" → one CPI entry
        const rootKey = HIGH_IMPACT_KEYWORDS.find(kw => exact.includes(kw.toUpperCase()));
        if (rootKey) {
          if (keysSeen.has(rootKey.toUpperCase())) return false;
          keysSeen.add(rootKey.toUpperCase());
        }
        return true;
      });
  } catch (err) {
    console.error('[CALENDAR] Fetch failed:', err.message);
    return [];
  }
}

// ── FETCH EARNINGS (TODAY + TOMORROW) ────────────────────────────
async function fetchEarnings() {
  try {
    const results = { today: [], tomorrow: [] };

    for (const offset of [0, 1]) {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      const dateStr = d.toISOString().slice(0, 10);
      const label   = offset === 0 ? 'today' : 'tomorrow';

      const url  = `https://api.nasdaq.com/api/calendar/earnings?date=${dateStr}`;
      const res  = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const data = await res.json();
      const rows = data?.data?.rows || [];

      // Filter to only watchlist tickers
      const hits = rows
        .filter(r => {
          const sym = (r.symbol || r.ticker || '').toUpperCase().trim();
          return EARNINGS_WATCHLIST.includes(sym);
        })
        .map(r => ({
          ticker: (r.symbol || r.ticker || '').toUpperCase(),
          time:   r.time || r.marketTime || '',   // BMO = before market, AMC = after
          eps:    r.epsForecast || r.estimate || '',
        }));

      results[label] = hits;
    }

    return results;
  } catch (err) {
    console.error('[EARNINGS] Fetch failed:', err.message);
    return { today: [], tomorrow: [] };
  }
}

// ── ANALYZE TODAY'S EVENTS ────────────────────────────────────────
async function getTodayImpact() {
  const events = await fetchEconomicEvents();
  const highEvents = [];

  for (const event of events) {
    const nameUpper = event.name.toUpperCase();
    const isHigh = HIGH_IMPACT_KEYWORDS.some(kw => nameUpper.includes(kw.toUpperCase()));
    if (isHigh) highEvents.push(event);
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
    warning:       `⚠️ HIGH IMPACT TODAY: ${names}`,
    entryRule:     '🔴 DELAY entries until 11AM — let whipsaw settle first',
    alertPrefix:   `🗓️ ${names} DAY — `,
  };
}

// ── FORMAT FOR MORNING BRIEF ──────────────────────────────────────
async function getCalendarBriefLine() {
  const [impact, earnings] = await Promise.all([
    getTodayImpact(),
    fetchEarnings(),
  ]);

  const lines = [];

  // Economic events
  if (!impact.hasHighImpact) {
    lines.push('📅 No major economic events today');
  } else {
    // Clean list — deduplicated, one per line if multiple
    const eventNames = impact.events.map(e => e.name).join(' + ');
    lines.push(`🔴 HIGH IMPACT: ${eventNames}`);
    lines.push(`   Wait until 11AM for entries`);
  }

  // Earnings — today
  if (earnings.today.length > 0) {
    const list = earnings.today.map(e => {
      const timing = e.time.toLowerCase().includes('before') ? '(BMO)'
                   : e.time.toLowerCase().includes('after')  ? '(AMC)'
                   : '';
      return `${e.ticker}${timing ? ' ' + timing : ''}`;
    }).join(', ');
    lines.push(`💰 Earnings TODAY: ${list} — avoid holding through print`);
  }

  // Earnings — tomorrow (heads up)
  if (earnings.tomorrow.length > 0) {
    const list = earnings.tomorrow.map(e => e.ticker).join(', ');
    lines.push(`📆 Earnings TOMORROW: ${list} — heads up`);
  }

  return {
    line:          lines.join('\n'),
    hasHighImpact: impact.hasHighImpact,
    entryRule:     impact.entryRule,
    events:        impact.events,
    earnings,
  };
}

// ── SHOULD BLOCK ALERT ────────────────────────────────────────────
async function shouldBlockAlert() {
  const impact = await getTodayImpact();
  if (!impact.hasHighImpact) return { block: false };

  const now    = new Date();
  const etHour = now.getUTCHours() - 4;
  const etMin  = now.getUTCMinutes();
  const etTime = etHour + etMin / 60;

  if (etTime < 11.0) {
    return {
      block:  true,
      reason: `High impact event — waiting until 11AM ET (now ${etHour}:${String(etMin).padStart(2,'0')} ET)`,
      events: impact.events,
    };
  }

  return { block: false, warning: impact.warning };
}

module.exports = {
  getTodayImpact,
  getCalendarBriefLine,
  shouldBlockAlert,
  fetchEarnings,
};
