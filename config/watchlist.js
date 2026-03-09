// ─── STRATUM FLOW SCOUT — WATCHLIST ───────────────────────────────

const WATCHLIST = {
  // MEGA TECH
  NVDA:  { category: 'TECH',       minPremium: 100000, priority: 'HIGH' },
  META:  { category: 'TECH',       minPremium: 75000,  priority: 'HIGH' },
  GOOGL: { category: 'TECH',       minPremium: 75000,  priority: 'HIGH' },
  AMZN:  { category: 'TECH',       minPremium: 75000,  priority: 'HIGH' },
  MSFT:  { category: 'TECH',       minPremium: 75000,  priority: 'HIGH' },
  AMD:   { category: 'SEMIS',      minPremium: 50000,  priority: 'HIGH' },
  MRVL:  { category: 'SEMIS',      minPremium: 30000,  priority: 'MEDIUM' },

  // BROAD MARKET ETFs
  SPY:   { category: 'ETF',        minPremium: 200000, priority: 'HIGH' },
  QQQ:   { category: 'ETF',        minPremium: 150000, priority: 'HIGH' },
  IWM:   { category: 'ETF',        minPremium: 75000,  priority: 'HIGH' },

  // FINANCIALS
  JPM:   { category: 'FINANCIALS', minPremium: 75000,  priority: 'HIGH' },
  GS:    { category: 'FINANCIALS', minPremium: 50000,  priority: 'MEDIUM' },
  BAC:   { category: 'FINANCIALS', minPremium: 50000,  priority: 'MEDIUM' },
  WFC:   { category: 'FINANCIALS', minPremium: 50000,  priority: 'MEDIUM' },

  // DEFENSIVES
  KO:    { category: 'DEFENSIVE',  minPremium: 25000,  priority: 'MEDIUM' },
  PEP:   { category: 'DEFENSIVE',  minPremium: 25000,  priority: 'MEDIUM' },

  // BIOTECH
  MRNA:  { category: 'BIOTECH',    minPremium: 50000,  priority: 'MEDIUM' },

  // ENERGY
  GUSH:  { category: 'ENERGY',     minPremium: 15000,  priority: 'HIGH' },

  // VOLATILITY / MOMENTUM
  TSLA:  { category: 'MOMENTUM',   minPremium: 100000, priority: 'HIGH' },
  UVXY:  { category: 'FEAR',       minPremium: 20000,  priority: 'MEDIUM' },
};

const ALERT_WEIGHTS = {
  'Urgent Repeater':  1.0,
  'Sizable Sweep':    0.9,
  'Large Block':      0.85,
  'Unusual Activity': 0.75,
  'Momentum Alert':   0.7,
  'default':          0.5,
};

const TIME_WEIGHTS = [
  { start: '10:00', end: '11:30', weight: 1.0,  label: 'PRIMARY WINDOW'   },
  { start: '15:00', end: '15:45', weight: 0.9,  label: 'POWER HOUR'       },
  { start: '13:00', end: '15:00', weight: 0.75, label: 'SECONDARY WINDOW' },
  { start: '09:30', end: '10:00', weight: 0.6,  label: 'OPENING RANGE'    },
  { start: '11:30', end: '13:00', weight: 0.2,  label: 'LUNCH CHOP'       },
];

module.exports = { WATCHLIST, ALERT_WEIGHTS, TIME_WEIGHTS };
