// ─── OPRA SYMBOL PARSER ────────────────────────────────────────────
// Converts "O:AMD251205P00205000" → { ticker: 'AMD', expiry: '2025-12-05', type: 'PUT', strike: 205 }

function parseOPRA(symbol) {
  try {
    const raw = symbol.startsWith('O:') ? symbol.slice(2) : symbol;
    const match = raw.match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
    if (!match) return null;

    const [, ticker, yy, mm, dd, typeChar, strikeRaw] = match;
    const year  = 2000 + parseInt(yy);
    const month = parseInt(mm);
    const day   = parseInt(dd);
    const strike = parseInt(strikeRaw) / 1000;
    const type  = typeChar === 'C' ? 'CALL' : 'PUT';

    const expDate = new Date(year, month - 1, day);
    const today   = new Date();
    today.setHours(0, 0, 0, 0);
    const dte = Math.round((expDate - today) / (1000 * 60 * 60 * 24));

    return {
      ticker, strike, type,
      expiry: `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`,
      expiryLabel: expDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      dte,
      is0DTE: dte === 0,
      isWeekly: dte >= 1 && dte <= 5,
      isSwing: dte > 5 && dte <= 45,
      raw: symbol
    };
  } catch (err) {
    return null;
  }
}

function formatStrike(strike) {
  return strike % 1 === 0 ? `$${strike}` : `$${strike.toFixed(2)}`;
}

function formatPremium(premium) {
  if (premium >= 1_000_000) return `$${(premium / 1_000_000).toFixed(1)}M`;
  if (premium >= 1_000)     return `$${(premium / 1_000).toFixed(0)}K`;
  return `$${premium}`;
}

module.exports = { parseOPRA, formatStrike, formatPremium };
