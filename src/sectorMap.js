// sectorMap.js — Ticker → Sector lookup for scanner color coding
// -----------------------------------------------------------------
// Apr 24 2026 — fix for scanner.html expecting r.sector but
// stratumScanner.js never populating it.
//
// Sector names match the colorMap in scanner.html sectorHtml()
// so new entries MUST use these canonical values:
//   Technology | Healthcare | Financial Services | Consumer Cyclical
//   Consumer Defensive | Energy | Industrials | Communication Services
//   Basic Materials | Real Estate | Utilities | ETF
// -----------------------------------------------------------------

var SECTOR_MAP = {
  // Indices / Broad ETFs
  'SPY': 'ETF', 'QQQ': 'ETF', 'IWM': 'ETF', 'DIA': 'ETF',
  // Sector ETFs
  'SMH': 'Technology', 'XLK': 'Technology', 'SOXL': 'Technology',
  'XLF': 'Financial Services', 'KRE': 'Financial Services',
  'XLV': 'Healthcare', 'LABU': 'Healthcare',
  'XLE': 'Energy',
  'XLP': 'Consumer Defensive',
  'XLY': 'Consumer Cyclical',
  'XLU': 'Utilities',
  'XLB': 'Basic Materials',
  'XLI': 'Industrials',
  'XLRE': 'Real Estate',

  // Mega cap tech
  'AAPL': 'Technology', 'MSFT': 'Technology', 'NVDA': 'Technology',
  'AMZN': 'Consumer Cyclical', 'GOOGL': 'Communication Services',
  'META': 'Communication Services', 'TSLA': 'Consumer Cyclical',
  'AVGO': 'Technology', 'ORCL': 'Technology', 'NFLX': 'Communication Services',
  'ADBE': 'Technology', 'CRM': 'Technology', 'AMD': 'Technology', 'INTC': 'Technology',

  // Growth / momentum
  'MU': 'Technology', 'MSTR': 'Technology', 'COIN': 'Financial Services',
  'PLTR': 'Technology', 'ARM': 'Technology', 'PANW': 'Technology',
  'CRWD': 'Technology', 'SNOW': 'Technology', 'WDAY': 'Technology',
  'NOW': 'Technology', 'SHOP': 'Technology', 'UBER': 'Industrials',
  'ABNB': 'Consumer Cyclical', 'HOOD': 'Financial Services',
  'SOFI': 'Financial Services', 'DKNG': 'Consumer Cyclical',
  'ANET': 'Technology', 'DELL': 'Technology', 'SMCI': 'Technology',
  'AMAT': 'Technology', 'LRCX': 'Technology', 'KLAC': 'Technology',
  'MRVL': 'Technology', 'QCOM': 'Technology', 'TSM': 'Technology', 'ASML': 'Technology',

  // John VIP watchlist
  'BABA': 'Consumer Cyclical', 'CRWV': 'Technology',

  // Financials
  'JPM': 'Financial Services', 'BAC': 'Financial Services', 'GS': 'Financial Services',
  'MS': 'Financial Services', 'WFC': 'Financial Services', 'C': 'Financial Services',
  'BLK': 'Financial Services', 'SCHW': 'Financial Services', 'V': 'Financial Services',
  'MA': 'Financial Services', 'PYPL': 'Financial Services', 'AXP': 'Financial Services',
  'PNC': 'Financial Services', 'FITB': 'Financial Services', 'CB': 'Financial Services',

  // Healthcare
  'UNH': 'Healthcare', 'JNJ': 'Healthcare', 'LLY': 'Healthcare',
  'PFE': 'Healthcare', 'ABBV': 'Healthcare', 'MRK': 'Healthcare',
  'TMO': 'Healthcare', 'ABT': 'Healthcare', 'DHR': 'Healthcare',
  'AMGN': 'Healthcare', 'REGN': 'Healthcare', 'BMY': 'Healthcare',
  'GILD': 'Healthcare', 'CVS': 'Healthcare', 'HCA': 'Healthcare',
  'CI': 'Healthcare', 'DXCM': 'Healthcare',

  // Consumer
  'WMT': 'Consumer Defensive', 'HD': 'Consumer Cyclical', 'COST': 'Consumer Defensive',
  'NKE': 'Consumer Cyclical', 'MCD': 'Consumer Cyclical', 'SBUX': 'Consumer Cyclical',
  'DIS': 'Communication Services', 'LOW': 'Consumer Cyclical', 'TGT': 'Consumer Defensive',
  'PG': 'Consumer Defensive', 'KO': 'Consumer Defensive', 'PEP': 'Consumer Defensive',
  'CL': 'Consumer Defensive', 'PM': 'Consumer Defensive', 'MO': 'Consumer Defensive',
  'KHC': 'Consumer Defensive',

  // Industrials
  'CAT': 'Industrials', 'DE': 'Industrials', 'BA': 'Industrials',
  'GE': 'Industrials', 'LMT': 'Industrials', 'RTX': 'Industrials',
  'NOC': 'Industrials', 'GD': 'Industrials', 'HON': 'Industrials',
  'UPS': 'Industrials', 'FDX': 'Industrials', 'CSX': 'Industrials', 'UNP': 'Industrials',

  // Materials / Energy
  'PSX': 'Energy', 'FCX': 'Basic Materials', 'SRE': 'Utilities',
  'XOM': 'Energy', 'CVX': 'Energy', 'COP': 'Energy', 'OXY': 'Energy',

  // REITs / Utilities
  'AMT': 'Real Estate', 'CCI': 'Real Estate', 'O': 'Real Estate',
  'PLD': 'Real Estate', 'SPG': 'Real Estate',
  'NEE': 'Utilities', 'DUK': 'Utilities', 'SO': 'Utilities', 'AEP': 'Utilities',

  // Communications / Other
  'CSCO': 'Technology', 'T': 'Communication Services', 'VZ': 'Communication Services',
  'CMCSA': 'Communication Services', 'ROKU': 'Communication Services',
  'SE': 'Communication Services', 'SPOT': 'Communication Services',

  // Other common scanner targets
  'DHT': 'Energy', 'SOUN': 'Technology', 'IONQ': 'Technology',
  'ARKK': 'ETF', 'UPST': 'Financial Services', 'APP': 'Communication Services',
  'SNAP': 'Communication Services', 'RDDT': 'Communication Services',
  'RKLB': 'Industrials', 'LUNR': 'Industrials', 'AFRM': 'Financial Services',
  'HIMS': 'Healthcare', 'TLT': 'ETF', 'UVXY': 'ETF',
};

function getSector(ticker) {
  if (!ticker) return null;
  return SECTOR_MAP[String(ticker).toUpperCase()] || null;
}

module.exports = {
  getSector: getSector,
  SECTOR_MAP: SECTOR_MAP,
};
