// wpEntry.js -- Stratum WealthPrince 4HR Hammer/Shooter Scout
// -----------------------------------------------------------------
// Scans a watchlist of 4hr bar charts for WealthPrince setups:
//   - Hammer (bullish close, lower wick >= 2x body) touching 9/21 EMA fan -> CALL swing
//   - Shooter (bearish close, upper wick >= 2x body) touching 9/21 EMA fan -> PUT swing
// FTFC vetoed via morningBrief.checkFTFC when available. Auto-queues
// 14-21 DTE swings via brainEngine.bulkAddQueuedTrades.
// Safe to call every 4 hours from a cron. Never throws.
// -----------------------------------------------------------------

var fetch = require('node-fetch');
var fs = require('fs');
var ts = require('./tradestation');

// -----------------------------------------------------------------
// Dedup store
// -----------------------------------------------------------------
var STATE_DIR = process.env.STATE_DIR || '/tmp';
try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch(e) {}
var DEDUP_FILE = STATE_DIR + '/wp_dedup.json';
var DEDUP_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 hours
var dedup = {};
function loadDedup() {
  try {
    if (fs.existsSync(DEDUP_FILE)) {
      dedup = JSON.parse(fs.readFileSync(DEDUP_FILE, 'utf8')) || {};
    }
  } catch(e) { console.error('[WP] dedup load error:', e.message); }
}
function saveDedup() {
  try { fs.writeFileSync(DEDUP_FILE, JSON.stringify(dedup)); }
  catch(e) { console.error('[WP] dedup save error:', e.message); }
}
loadDedup();

function isDuped(ticker, direction) {
  var key = ticker + '_' + direction;
  var last = dedup[key];
  if (!last) return false;
  return (Date.now() - last) < DEDUP_WINDOW_MS;
}
function markDuped(ticker, direction) {
  dedup[ticker + '_' + direction] = Date.now();
  saveDedup();
}

// -----------------------------------------------------------------
// Watchlist
// -----------------------------------------------------------------
var DEFAULT_WATCHLIST = 'SPY,QQQ,NVDA,AAPL,MSFT,META,AMZN,TSLA,PLTR,AMD,MRVL,GOOGL,NFLX,AVGO,COIN,CRM,UBER,SHOP,NOW,HOOD,SOFI,MU,DKNG,RKLB,NET,PANW,CRWD,SNOW,WDAY,ARM,ANET,DELL,SMCI,MSTR,SMH,XBI,GDX,ARKK,IONQ,HIMS,RGTI,SOUN,SNAP,APP,AFRM,UPST,PYPL,RDDT,ROKU,SE,MARA,RIOT,LUNR,ACHR,LLY,UNH,V,MA,JPM,GS,BA,CAT,WMT,HD,COST,BABA';
function getWatchlist() {
  try { var rc = require('./runtimeConfig'); var v = rc.get('WP_WATCHLIST'); if (v) return v.split(',').map(function(s){return s.trim().toUpperCase();}).filter(Boolean); } catch(e){}
  var raw = process.env.WP_WATCHLIST || DEFAULT_WATCHLIST;
  return raw.split(',').map(function(s){ return s.trim().toUpperCase(); }).filter(Boolean);
}

// -----------------------------------------------------------------
// Fetch 4hr bars from TradeStation
// -----------------------------------------------------------------
async function fetch4hrBars(symbol, token) {
  try {
    var url = 'https://api.tradestation.com/v3/marketdata/barcharts/' + encodeURIComponent(symbol) +
              '?unit=Minute&interval=240&barsback=50&sessiontemplate=USEQPre';
    var res = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (!res.ok) {
      console.error('[WP] bars ' + symbol + ' ' + res.status);
      return null;
    }
    var json = await res.json();
    if (!json || !json.Bars || !Array.isArray(json.Bars)) return null;
    return json.Bars.map(function(b) {
      return {
        open:  parseFloat(b.Open),
        high:  parseFloat(b.High),
        low:   parseFloat(b.Low),
        close: parseFloat(b.Close),
        ts:    b.TimeStamp,
      };
    });
  } catch(e) {
    console.error('[WP] fetch4hrBars ' + symbol + ' error:', e.message);
    return null;
  }
}

// -----------------------------------------------------------------
// EMA calc (seed with SMA of first N bars)
// -----------------------------------------------------------------
function computeEMA(closes, period) {
  if (!closes || closes.length < period) return null;
  var alpha = 2 / (period + 1);
  var sum = 0;
  for (var i = 0; i < period; i++) sum += closes[i];
  var ema = sum / period;
  for (var j = period; j < closes.length; j++) {
    ema = closes[j] * alpha + ema * (1 - alpha);
  }
  return ema;
}

// -----------------------------------------------------------------
// Pattern detection on the last closed bar
// Returns { signal: 'HAMMER'|'SHOOTER'|null, bar, ema9, ema21 }
// -----------------------------------------------------------------
function detectPattern(bars) {
  if (!bars || bars.length < 25) return { signal: null };
  // Err toward closed bar -- use len-2 so we skip any still-forming bar
  var idx = bars.length - 2;
  var bar = bars[idx];
  if (!bar) return { signal: null };

  // EMAs computed on closes up to and including this bar
  var closes = bars.slice(0, idx + 1).map(function(b){ return b.close; });
  var ema9 = computeEMA(closes, 9);
  var ema21 = computeEMA(closes, 21);
  if (ema9 == null || ema21 == null) return { signal: null };

  var body = Math.abs(bar.close - bar.open);
  if (body <= 0) body = 0.0001; // avoid div-by-zero on doji
  var lowerWick = Math.min(bar.open, bar.close) - bar.low;
  var upperWick = bar.high - Math.max(bar.open, bar.close);
  var emaHigh = Math.max(ema9, ema21);
  var emaLow = Math.min(ema9, ema21);

  // HAMMER -> CALL
  var isHammerShape = lowerWick >= 2 * body && bar.close > bar.open;
  var hammerTouchesEma = bar.low <= emaHigh && bar.low >= emaLow * 0.99;
  if (isHammerShape && hammerTouchesEma) {
    return { signal: 'HAMMER', bar: bar, ema9: ema9, ema21: ema21 };
  }

  // SHOOTER -> PUT
  var isShooterShape = upperWick >= 2 * body && bar.close < bar.open;
  var shooterTouchesEma = bar.high >= emaLow && bar.high <= emaHigh * 1.01;
  if (isShooterShape && shooterTouchesEma) {
    return { signal: 'SHOOTER', bar: bar, ema9: ema9, ema21: ema21 };
  }

  return { signal: null, bar: bar, ema9: ema9, ema21: ema21 };
}

// -----------------------------------------------------------------
// FTFC veto via morningBrief.checkFTFC (if available)
// Returns true if we should SKIP the signal.
// -----------------------------------------------------------------
async function ftfcVetoes(ticker, direction, price, token) {
  try {
    var mb = require('./morningBrief');
    if (!mb || typeof mb.checkFTFC !== 'function') {
      console.log('[WP] FTFC unavailable, proceeding');
      return false;
    }
    var ftfc = await mb.checkFTFC(ticker, price, token);
    if (!ftfc || typeof ftfc !== 'object') return false;
    var bias = (ftfc.direction || ftfc.bias || '').toString().toLowerCase();
    if (!bias) return false;
    var wantBull = direction === 'CALLS';
    var isBull = /bull|up|long|call/.test(bias);
    var isBear = /bear|down|short|put/.test(bias);
    if (wantBull && isBear) {
      console.log('[WP] FTFC veto ' + ticker + ' (wanted CALLS, FTFC=' + bias + ')');
      return true;
    }
    if (!wantBull && isBull) {
      console.log('[WP] FTFC veto ' + ticker + ' (wanted PUTS, FTFC=' + bias + ')');
      return true;
    }
    return false;
  } catch(e) {
    console.log('[WP] FTFC unavailable, proceeding (' + e.message + ')');
    return false;
  }
}

// -----------------------------------------------------------------
// Pick swing expiration: Friday 2-3 weeks out (target ~17 DTE, 14-21 range)
// Returns { yyyymmdd, mmddyyyy, yymmdd }
// -----------------------------------------------------------------
function pickSwingExpiration() {
  var now = new Date();
  var target = new Date(now.getTime() + 17 * 24 * 60 * 60 * 1000); // ~17 days out
  // Walk forward to next Friday (day 5)
  var day = target.getDay();
  var add = (5 - day + 7) % 7;
  target.setDate(target.getDate() + add);
  // Clamp to 14-21 DTE window
  var dte = Math.floor((target - now) / (24*60*60*1000));
  if (dte < 14) target.setDate(target.getDate() + 7);
  if (dte > 21) target.setDate(target.getDate() - 7);
  var y = target.getFullYear();
  var m = String(target.getMonth() + 1).padStart(2, '0');
  var d = String(target.getDate()).padStart(2, '0');
  return {
    yyyymmdd: '' + y + m + d,
    mmddyyyy: m + '-' + d + '-' + y,
    yymmdd:   String(y).slice(2) + m + d,
  };
}

// -----------------------------------------------------------------
// Build queue item
// -----------------------------------------------------------------
function buildQueueItem(ticker, signal, bar, ema9, ema21) {
  var isCall = signal === 'HAMMER';
  var direction = isCall ? 'CALLS' : 'PUTS';
  var contractType = isCall ? 'Call' : 'Put';
  var price = bar.close;
  var strike = Math.round(price);
  var exp = pickSwingExpiration();
  var cp = isCall ? 'C' : 'P';
  var contractSymbol = ticker + ' ' + exp.yymmdd + cp + strike;
  var source = isCall ? 'WP_4HR_HAMMER' : 'WP_4HR_SHOOTER';

  return {
    ticker:         ticker,
    direction:      direction,
    triggerPrice:   isCall ? bar.high : bar.low,
    contractSymbol: contractSymbol,
    strike:         strike,
    expiration:     exp.mmddyyyy,
    contractType:   contractType,
    maxEntryPrice:  4.00,
    stopPct:        -0.30,
    targets:        [0.30, 0.75, 1.50],
    contracts:      2,
    management:     'WP',
    tradeType:      'SWING',
    // GRADE: WP 4hr hammer/shooter off 9/21 EMA fan is a textbook
    // higher-TF swing setup. Always A. (WP never auto-fires —
    // SWING trades always stage for manual review.)
    grade:          'A',
    source:         source,
    note:           '4hr ' + signal + ' ema9=' + ema9.toFixed(2) + ' ema21=' + ema21.toFixed(2) +
                    ' bar=' + JSON.stringify({ o: bar.open, h: bar.high, l: bar.low, c: bar.close }),
  };
}

// -----------------------------------------------------------------
// Discord confirm alert
// -----------------------------------------------------------------
async function postConfirmAlert(item, signal) {
  var webhookUrl = process.env.DISCORD_EXECUTE_NOW_WEBHOOK;
  if (!webhookUrl) return;
  try {
    var lines = [
      '🏰 WP 4HR ' + signal + ' — ' + item.ticker + ' ' + item.direction,
      '────────────────────────────────',
      'Trigger:  ' + (item.direction === 'CALLS' ? '≥ ' : '≤ ') + '$' + item.triggerPrice,
      'Contract: ' + item.contractSymbol + ' x' + item.contracts,
      'Max:      $' + item.maxEntryPrice.toFixed(2),
      'Stop:     ' + (item.stopPct * 100) + '%',
      'TP:       ' + item.targets.map(function(t){ return '+' + Math.round(t*100) + '%'; }).join(' / '),
      'Type:     SWING (' + item.expiration + ')',
      '────────────────────────────────',
      item.note,
    ].join('\n');
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Stratum WP Scout',
        content: '```\n' + lines + '\n```',
      }),
    });
  } catch(e) {
    console.error('[WP] postConfirmAlert error:', e.message);
  }
}

// -----------------------------------------------------------------
// MAIN: pollOnce
// -----------------------------------------------------------------
var _running = false;
async function pollOnce() {
  if (_running) return { ok: false, reason: 'already running', checked: 0, queued: 0, skipped: 0 };
  _running = true;

  var checked = 0;
  var queued = 0;
  var skipped = 0;

  try {
    var token;
    try {
      token = await ts.getAccessToken();
    } catch(e) {
      console.error('[WP] getAccessToken error:', e.message);
      return { ok: false, reason: 'no token', checked: 0, queued: 0, skipped: 0 };
    }
    if (!token) {
      return { ok: false, reason: 'no token', checked: 0, queued: 0, skipped: 0 };
    }

    var watchlist = getWatchlist();
    var newItems = [];

    for (var i = 0; i < watchlist.length; i++) {
      var ticker = watchlist[i];
      checked++;
      try {
        var bars = await fetch4hrBars(ticker, token);
        if (!bars || bars.length < 25) { skipped++; continue; }

        var result = detectPattern(bars);
        if (!result.signal) { skipped++; continue; }

        var direction = result.signal === 'HAMMER' ? 'CALLS' : 'PUTS';

        if (isDuped(ticker, direction)) {
          console.log('[WP] dedup skip ' + ticker + ' ' + direction);
          skipped++;
          continue;
        }

        var vetoed = await ftfcVetoes(ticker, direction, result.bar.close, token);
        if (vetoed) { skipped++; continue; }

        var item = buildQueueItem(ticker, result.signal, result.bar, result.ema9, result.ema21);
        newItems.push({ item: item, signal: result.signal });
        markDuped(ticker, direction);
        console.log('[WP] queued ' + ticker + ' ' + direction + ' ' + item.contractSymbol);
      } catch(e) {
        console.error('[WP] ' + ticker + ' error:', e.message);
        skipped++;
      }
    }

    if (newItems.length > 0) {
      try {
        var be = require('./brainEngine');
        if (be && be.bulkAddQueuedTrades) {
          be.bulkAddQueuedTrades(newItems.map(function(x){ return x.item; }), { replaceAll: false });
          queued = newItems.length;
        } else {
          console.error('[WP] brainEngine.bulkAddQueuedTrades not found');
        }
      } catch(e) {
        console.error('[WP] queue push error:', e.message);
      }

      for (var k = 0; k < newItems.length; k++) {
        await postConfirmAlert(newItems[k].item, newItems[k].signal);
      }
    }

    return { ok: true, checked: checked, queued: queued, skipped: skipped };
  } catch(e) {
    console.error('[WP] pollOnce error:', e.message);
    return { ok: false, reason: e.message, checked: checked, queued: queued, skipped: skipped };
  } finally {
    _running = false;
  }
}

module.exports = {
  pollOnce: pollOnce,
  run: pollOnce,
  // exported for testing
  detectPattern: detectPattern,
  computeEMA: computeEMA,
  pickSwingExpiration: pickSwingExpiration,
  buildQueueItem: buildQueueItem,
};
