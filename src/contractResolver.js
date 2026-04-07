// contractResolver.js - Stratum Flow Scout v7.5
// CHAIN HIERARCHY: TradeStation → Public.com → Polygon
// Falls back to next source if chain returns 404 or empty
// -----------------------------------------------------------------

const fetch = require('node-fetch');

const MODES = {
  DAY: {
    label: 'DAY TRADE', minPremium: 0.30, maxPremium: 1.50,
    minDTE: 0, maxDTE: 2, stopPct: 0.35, t1Pct: 0.25, maxRisk: 120,
  },
  SWING: {
    label: 'SWING TRADE', minPremium: 0.50, maxPremium: 2.40,
    minDTE: 5, maxDTE: 14, stopPct: 0.40, t1Pct: 0.30, maxRisk: 140,
  },
};

const MIN_PREMIUM = 0.30;
const MAX_PREMIUM = 2.40;

const WATCHLIST = new Set([
  'SPY','QQQ','IWM','NVDA','TSLA','META','GOOGL',
  'AMZN','MSFT','AMD','JPM','GS','BAC','WFC',
  'MRNA','MRVL','GUSH','UVXY','KO','PEP'
]);

const T1_TARGETS = {
  TSLA: 0.50, COIN: 0.50, NVDA: 0.50, MRVL: 0.50,
  AAPL: 0.40, AMZN: 0.40, MSFT: 0.40, GOOGL: 0.40,
};
function getT1Target(ticker) { return T1_TARGETS[ticker] || 0.30; }

// -- TRADESTATION TOKEN -------------------------------------------
async function getTSToken() {
  try {
    var ts = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) { console.error('[TS] getAccessToken returned null'); return null; }
    return token;
  } catch(e) { console.error('[TS] Token error:', e.message); return null; }
}

function getTSBase()       { return 'https://api.tradestation.com/v3'; }
function getTSBaseOrders() {
  return process.env.SIM_MODE === 'true'
    ? 'https://sim-api.tradestation.com/v3'
    : 'https://api.tradestation.com/v3';
}

// -- GET STOCK PRICE ----------------------------------------------
async function getPrice(ticker, token) {
  try {
    console.log('[PRICE] Fetching', ticker);
    if (!token) return null;
    var res = await fetch(getTSBase() + '/marketdata/quotes/' + ticker, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    var data = await res.json();
    var quotes = data.Quotes || data.quotes || (Array.isArray(data) ? data : [data]);
    var q = quotes[0];
    if (!q) return null;
    var price = parseFloat(q.Last || q.Bid || q.Ask || 0);
    if (price > 0) { console.log('[PRICE] ' + ticker + ' $' + price + ' - TradeStation'); return price; }
    return null;
  } catch(e) { console.error('[PRICE] Error:', e.message); return null; }
}

// -- GET PDH/PDL --------------------------------------------------
async function getLVLs(ticker, token) {
  try {
    console.log('[LVL] Fetching bars for', ticker);
    if (!token) return null;
    var res = await fetch(
      getTSBase() + '/marketdata/barcharts/' + ticker +
      '?unit=Daily&interval=1&barsback=3&sessiontemplate=Default',
      { headers: { 'Authorization': 'Bearer ' + token } }
    );
    var data = await res.json();
    var bars = data.Bars || data.bars || [];
    console.log('[LVL] Bars returned:', bars.length);
    if (bars.length < 2) return null;
    bars.sort(function(a,b){ return new Date(a.TimeStamp)-new Date(b.TimeStamp); });
    var prev = bars[bars.length-2];
    var curr = bars[bars.length-1];
    var pdh=parseFloat(prev.High), pdl=parseFloat(prev.Low), pdc=parseFloat(prev.Close);
    console.log('[LVL] ' + ticker + ' PDH:$'+pdh+' PDL:$'+pdl+' PDC:$'+pdc);
    return { pdh, pdl, pdc, todayOpen:parseFloat(curr.Open),
      callEntry:pdh, putEntry:pdl, callStop:pdl, putStop:pdh };
  } catch(e) { console.error('[LVL] Error for',ticker,':',e.message); return null; }
}

// -- GET EXPIRATIONS ----------------------------------------------
async function getExpirations(ticker, token) {
  try {
    console.log('[EXPIRY] Fetching for', ticker);
    if (!token) return [];
    var url = getTSBase() + '/marketdata/options/expirations/' + ticker;
    var res  = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    console.log('[EXPIRY] HTTP status:', res.status);
    var data = await res.json();
    var exps = data.Expirations || data.expirations || [];
    console.log('[EXPIRY] Raw count:', exps.length);
    if (!exps.length) return [];
    var mapped = exps.map(function(e){
      var dateStr = (e.Date||e.date||'').slice(0,10);
      var dte = dateStr ? Math.ceil((new Date(dateStr+'T16:00:00-04:00') - new Date()) / (1000*60*60*24)) : 0;
      return { date:dateStr, dte:Math.max(0,dte), type:e.Type||'Weekly' };
    }).filter(function(e){ return e.date && e.dte >= 0; });
    console.log('[EXPIRY] Valid:', mapped.length, mapped.slice(0,3).map(function(e){ return e.date+'('+e.dte+'DTE)'; }).join(', '));
    return mapped;
  } catch(e) { console.error('[EXPIRY] Error:', e.message); return []; }
}

function selectExpiry(expirations, mode) {
  var config = MODES[mode] || MODES.SWING;
  var valid = expirations.filter(function(e){ return e.dte>=config.minDTE && e.dte<=config.maxDTE; });
  if (valid.length > 0) { console.log('[EXPIRY] Selected:',valid[0].date+'('+valid[0].dte+'DTE)'); return valid[0]; }
  var future = expirations.filter(function(e){ return e.dte>0; });
  if (future.length > 0) { console.log('[EXPIRY] Fallback:',future[0].date+'('+future[0].dte+'DTE)'); return future[0]; }
  if (expirations.length > 0) { console.log('[EXPIRY] Emergency:',expirations[0].date); return expirations[0]; }
  return null;
}

function formatExpiry(dateStr) {
  if (!dateStr) return null;
  var p = dateStr.split('-');
  return p.length !== 3 ? dateStr : p[1]+'-'+p[2]+'-'+p[0];
}

// -- GET OPTION CHAIN: TRADESTATION (source 1) --------------------
async function getChainTS(ticker, expiry, type, price, token) {
  try {
    console.log('[CHAIN-TS] Fetching', ticker, type, expiry);
    var optType = type === 'call' ? 'Call' : 'Put';
    // TS v3 option chains are STREAMING only — /stream/options/chains/
    var url = getTSBase() + '/marketdata/stream/options/chains/' + ticker
      + '?expiration=' + formatExpiry(expiry)
      + '&optionType=' + optType
      + '&strikeProximity=6&enableGreeks=true';
    if (price) url += '&priceCenter=' + Math.round(price);

    var controller = new AbortController();
    var timeout = setTimeout(function(){ controller.abort(); }, 8000);

    var res = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token },
      signal: controller.signal
    });
    console.log('[CHAIN-TS] HTTP status:', res.status);
    if (!res.ok) {
      clearTimeout(timeout);
      console.error('[CHAIN-TS] Failed:', res.status);
      return [];
    }

    // SSE stream — collect JSON objects from response body
    var text = await res.text();
    clearTimeout(timeout);

    var chain = [];
    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.startsWith(':') || line === 'event: snapshot' || line === 'event: heartbeat') continue;
      if (line.startsWith('data:')) line = line.slice(5).trim();
      if (!line || line === '') continue;
      try {
        var obj = JSON.parse(line);
        if (obj && (obj.Legs || obj.legs || obj.Delta !== undefined)) {
          chain.push(obj);
        }
      } catch(e) { /* skip non-JSON lines */ }
    }

    console.log('[CHAIN-TS] ' + ticker + ' ' + type + ' ' + expiry + ' - ' + chain.length + ' contracts (stream)');
    if (!chain.length) console.error('[CHAIN-TS] Empty stream. Lines:', lines.length);
    return chain;
  } catch(e) {
    if (e.name === 'AbortError') {
      console.log('[CHAIN-TS] Stream timeout — collected data processed');
      return [];
    }
    console.error('[CHAIN-TS] Error:', e.message);
    return [];
  }
}

// -- GET OPTION CHAIN: PUBLIC.COM (source 2) ----------------------
async function getChainPublic(ticker, expiry, type, price) {
  try {
    console.log('[CHAIN-PUB] Fetching', ticker, type, expiry);
    var apiKey = process.env.PUBLIC_API_KEY;
    if (!apiKey) { console.log('[CHAIN-PUB] No PUBLIC_API_KEY'); return []; }

    // Public.com options chain -- POST with JSON body per API docs
    var url = 'https://api.public.com/userapigateway/marketdata/' + (process.env.PUBLIC_ACCOUNT_ID || '5OF64813') + '/option-chain';
    var body = JSON.stringify({
      instrument: { symbol: ticker, type: 'EQUITY' },
      expirationDate: expiry
    });

    var res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: body
    });
    console.log('[CHAIN-PUB] HTTP status:', res.status);
    if (!res.ok) { console.log('[CHAIN-PUB] Failed:', res.status); return []; }

    var data = await res.json();
    var contracts = data.contracts || data.options || data.results || data || [];
    if (!Array.isArray(contracts)) { console.log('[CHAIN-PUB] Unexpected format'); return []; }

    // Normalize to TS format
    var normalized = contracts.map(function(c) {
      var bid = parseFloat(c.bid || c.bid_price || 0);
      var ask = parseFloat(c.ask || c.ask_price || 0);
      var mid = (bid + ask) / 2;
      var strike = parseFloat(c.strike || c.strike_price || 0);
      var sym = ticker + ' ' + expiry.replace(/-/g,'').slice(2) + (type==='call'?'C':'P') + strike;
      return {
        Bid: bid, Ask: ask, Mid: mid,
        Volume: parseInt(c.volume || 0),
        DailyOpenInterest: parseInt(c.open_interest || c.openInterest || 0),
        Delta: parseFloat(c.greeks && c.greeks.delta || c.delta || 0),
        Theta: parseFloat(c.greeks && c.greeks.theta || c.theta || 0),
        ImpliedVolatility: parseFloat(c.implied_volatility || c.iv || 0),
        ProbabilityITM: parseFloat(c.probability_itm || 0),
        Legs: [{ Symbol: sym, StrikePrice: String(strike) }],
        _source: 'public'
      };
    }).filter(function(c){ return c.Bid > 0 || c.Ask > 0; });

    console.log('[CHAIN-PUB] ' + ticker + ' ' + type + ' ' + expiry + ' - ' + normalized.length + ' contracts');
    return normalized;
  } catch(e) { console.error('[CHAIN-PUB] Error:', e.message); return []; }
}

// -- GET OPTION CHAIN: POLYGON (source 3) -------------------------
async function getChainPolygon(ticker, expiry, type, price) {
  try {
    console.log('[CHAIN-POL] Fetching', ticker, type, expiry);
    var apiKey = process.env.POLYGON_API_KEY;
    if (!apiKey) { console.log('[CHAIN-POL] No POLYGON_API_KEY'); return []; }

    var optType = type === 'call' ? 'call' : 'put';
    var url = 'https://api.polygon.io/v3/snapshot/options/' + ticker
      + '?expiration_date=' + expiry
      + '&contract_type=' + optType
      + '&limit=25'
      + '&apiKey=' + apiKey;
    if (price) url += '&strike_price_gte=' + Math.round(price*0.9) + '&strike_price_lte=' + Math.round(price*1.1);

    var res  = await fetch(url);
    console.log('[CHAIN-POL] HTTP status:', res.status);
    if (!res.ok) { console.log('[CHAIN-POL] Failed:', res.status); return []; }

    var data = await res.json();
    var results = data.results || [];

    // Normalize to TS format
    var normalized = results.map(function(r) {
      var d = r.details || {};
      var q = r.day || {};
      var g = r.greeks || {};
      var bid = parseFloat(r.last_quote && r.last_quote.bid || 0);
      var ask = parseFloat(r.last_quote && r.last_quote.ask || 0);
      var mid = parseFloat(r.last_trade && r.last_trade.price || (bid+ask)/2);
      var strike = parseFloat(d.strike_price || 0);
      var sym = ticker + ' ' + expiry.replace(/-/g,'').slice(2) + (type==='call'?'C':'P') + strike;
      return {
        Bid: bid, Ask: ask, Mid: mid,
        Volume: parseInt(q.volume || r.open_interest || 0),
        DailyOpenInterest: parseInt(r.open_interest || 0),
        Delta: parseFloat(g.delta || 0),
        Theta: parseFloat(g.theta || 0),
        ImpliedVolatility: parseFloat(r.implied_volatility || 0),
        ProbabilityITM: Math.abs(parseFloat(g.delta || 0)),
        Legs: [{ Symbol: sym, StrikePrice: String(strike) }],
        _source: 'polygon'
      };
    }).filter(function(c){ return c.Bid > 0 || c.Ask > 0; });

    console.log('[CHAIN-POL] ' + ticker + ' ' + type + ' ' + expiry + ' - ' + normalized.length + ' contracts');
    return normalized;
  } catch(e) { console.error('[CHAIN-POL] Error:', e.message); return []; }
}

// -- GET OPTION CHAIN WITH FALLBACK HIERARCHY ---------------------
async function getOptionChain(ticker, expiry, type, price, token) {
  // Source 1: TradeStation
  var chain = await getChainTS(ticker, expiry, type, price, token);
  if (chain.length > 0) return chain;

  // Source 2: Public.com
  console.log('[CHAIN] TS failed -- trying Public.com...');
  chain = await getChainPublic(ticker, expiry, type, price);
  if (chain.length > 0) return chain;

  // Source 3: Polygon
  console.log('[CHAIN] Public failed -- trying Polygon...');
  chain = await getChainPolygon(ticker, expiry, type, price);
  if (chain.length > 0) return chain;

  console.error('[CHAIN] All sources failed for', ticker, expiry, type);
  return [];
}

// -- PARSE CONTRACT -----------------------------------------------
function parseContract(c, expiry, type) {
  try {
    var legs=c.Legs||c.legs||[], leg=legs[0]||{};
    var symbol=leg.Symbol||leg.symbol||'';
    var strike=parseFloat(leg.StrikePrice||leg.strikePrice||0);
    var bid=parseFloat(c.Bid||c.bid||0), ask=parseFloat(c.Ask||c.ask||0);
    var mid=parseFloat(c.Mid||c.mid||((bid+ask)/2));
    if (!symbol||strike<=0||mid<=0) return null;
    if (ask>0) {
      var sp=(ask-bid)/ask;
      var thresh=ask<0.50?0.40:ask<1.50?0.30:0.25;
      if (sp>thresh) return null;
    }
    return { symbol, strike, bid, ask, mid,
      volume:parseInt(c.Volume||c.volume||0), openInterest:parseInt(c.DailyOpenInterest||0),
      delta:parseFloat(c.Delta||c.delta||0), theta:parseFloat(c.Theta||c.theta||0),
      iv:parseFloat(c.ImpliedVolatility||0), probITM:parseFloat(c.ProbabilityITM||0),
      expiry, type, source:c._source||'ts',
      high:parseFloat(c.High||0), low:parseFloat(c.Low||0), open:parseFloat(c.Open||0) };
  } catch(e) { return null; }
}

// -- ENTRY MODE ---------------------------------------------------
function getEntryMode(confluence, strategy) {
  var score=parseInt((confluence||'0').split('/')[0])||0;
  var isORB=(strategy||'').toUpperCase().includes('ORB')||(strategy||'').toUpperCase().includes('3-2-2');
  return (score>=5||isORB) ? 'BREAKOUT' : 'RETRACEMENT';
}

// -- SELECT BEST CONTRACT -----------------------------------------
function selectBestContract(contracts, price, config, lvls, type) {
  if (!contracts||!contracts.length) return null;
  var candidates=contracts.filter(function(c){
    return c && c.mid>=config.minPremium && c.mid<=config.maxPremium && Math.abs(c.delta)>=0.15;
  });
  if (!candidates.length) {
    candidates=contracts.filter(function(c){ return c&&c.mid>=config.minPremium&&c.mid<=config.maxPremium; });
  }
  if (!candidates.length) {
    console.error('[SELECT] No candidates. Range:$'+config.minPremium+'-$'+config.maxPremium,
      'Mids:',contracts.slice(0,5).map(function(c){return c?'$'+c.mid:'null';}).join(', '));
    return null;
  }
  var scored=candidates.map(function(c){
    var score=0, abs=Math.abs(c.delta), dist=Math.abs(c.strike-price)/price;
    if (abs>=0.35&&abs<=0.55) score+=3; else if (abs>=0.25) score+=1;
    if (dist<0.01) score+=3; else if (dist<0.03) score+=2; else if (dist<0.05) score+=1;
    if (c.volume>1000) score+=2; else if (c.volume>500) score+=1;
    if (c.openInterest>5000) score+=2; else if (c.openInterest>1000) score+=1;
    if (c.ask>0){var sp=(c.ask-c.bid)/c.ask; if(sp<0.05)score+=2; else if(sp<0.10)score+=1;}
    if (lvls) {
      if (type==='call'&&Math.abs(c.strike-lvls.pdh)/lvls.pdh<0.02) score+=2;
      if (type==='put' &&Math.abs(c.strike-lvls.pdl)/lvls.pdl<0.02) score+=2;
    }
    return {contract:c, score};
  });
  scored.sort(function(a,b){return b.score-a.score;});
  var best=scored[0].contract;
  console.log('[SELECT] '+best.symbol+' strike:$'+best.strike+' mid:$'+best.mid+' delta:'+best.delta.toFixed(2)+' score:'+scored[0].score+' source:'+best.source);
  return best;
}

function calcDTE(dateStr) {
  if (!dateStr) return 0;
  return Math.max(0,Math.ceil((new Date(dateStr+'T16:00:00-04:00')-new Date())/(1000*60*60*24)));
}

function getTimeContext() {
  var now=new Date(), etH=((now.getUTCHours()-4)+24)%24, etM=now.getUTCMinutes(), t=etH*60+etM;
  if (t<9*60+30)  return {window:'PREMARKET',ok:false};
  if (t<9*60+45)  return {window:'EARLY',ok:false};
  if (t>=15*60+30) return {window:'LATE',ok:false};
  if (t>=16*60)   return {window:'CLOSED',ok:false};
  return {window:'OPEN',ok:true};
}

// -- RESOLVE CONTRACT (MAIN) --------------------------------------
async function resolveContract(ticker, type, tradeType, signalMeta) {
  type=(type||'call').toLowerCase();
  tradeType=(tradeType||'SWING').toUpperCase();
  signalMeta=signalMeta||{};
  var mode=tradeType.includes('DAY')?'DAY':'SWING';
  var config=MODES[mode];
  console.log('[RESOLVE] '+ticker+' '+type+' '+mode);

  var token=await getTSToken();
  if (!token) { console.error('[RESOLVE] No TS token -- aborting'); return null; }
  console.log('[RESOLVE] Token OK');

  var price=await getPrice(ticker, token);
  if (!price) { console.error('[RESOLVE] No price for',ticker); return null; }

  var lvls=await getLVLs(ticker, token);
  if (!lvls) console.log('[RESOLVE] No LVL data -- continuing without LVL filter');

  var entryMode=getEntryMode(signalMeta.confluence, signalMeta.strategy);
  console.log('[ENTRY MODE] '+entryMode+' | confluence:'+(signalMeta.confluence||'N/A'));

  if (lvls) {
    if (type==='call') {
      var dPDH=(price-lvls.pdh)/lvls.pdh;
      console.log('[LVL] CALL | Price:$'+price+' PDH:$'+lvls.pdh+' dist:'+(dPDH*100).toFixed(1)+'%');
      if (dPDH<-0.03&&entryMode==='BREAKOUT') {
        var r='Price $'+price+' is '+(Math.abs(dPDH)*100).toFixed(1)+'% below PDH $'+lvls.pdh;
        console.log('[LVL] BLOCKED --',r); return {blocked:true,reason:r,lvls};
      }
    } else {
      var dPDL=(lvls.pdl-price)/lvls.pdl;
      console.log('[LVL] PUT | Price:$'+price+' PDL:$'+lvls.pdl+' dist:'+(dPDL*100).toFixed(1)+'%');
      if (dPDL<-0.03&&entryMode==='BREAKOUT') {
        var r2='Price $'+price+' is above PDL $'+lvls.pdl;
        console.log('[LVL] BLOCKED --',r2); return {blocked:true,reason:r2,lvls};
      }
    }
  }

  var expirations=await getExpirations(ticker, token);
  if (!expirations.length) { console.error('[RESOLVE] No expirations for',ticker); return null; }

  var expiryObj=selectExpiry(expirations, mode);
  if (!expiryObj) { console.error('[RESOLVE] No expiry found'); return null; }

  var expiry=expiryObj.date, dte=expiryObj.dte;
  var rawChain=await getOptionChain(ticker, expiry, type, price, token);

  if (!rawChain.length) {
    var remaining=expirations.filter(function(e){ return e.date > expiry && e.dte > 0; });
    for (var i=0; i<Math.min(remaining.length,3); i++) {
      console.log('[RESOLVE] Retrying expiry', remaining[i].date+'('+remaining[i].dte+'DTE)');
      expiry  = remaining[i].date;
      dte     = remaining[i].dte;
      rawChain = await getOptionChain(ticker, expiry, type, price, token);
      if (rawChain.length) break;
    }
  }

  if (!rawChain.length) { console.error('[RESOLVE] No chain found for',ticker,type); return null; }

  var contracts=rawChain.map(function(c){return parseContract(c,expiry,type);}).filter(Boolean);
  console.log('[RESOLVE] Parsed contracts:',contracts.length);
  if (!contracts.length) { console.error('[RESOLVE] No parseable contracts'); return null; }

  var best=selectBestContract(contracts, price, config, lvls, type);
  if (!best) { console.error('[RESOLVE] No contract passed selection'); return null; }

  var t1Pct=getT1Target(ticker), stopPct=config.stopPct;
  var entryPrice=entryMode==='BREAKOUT'?best.ask:parseFloat((best.ask*0.875).toFixed(2));
  var underlyingStop=null, optionStopPct=stopPct;

  if (lvls) {
    underlyingStop=type==='call'?lvls.callStop:lvls.putStop;
    var dist=Math.abs(price-underlyingStop);
    var estLoss=dist*Math.abs(best.delta);
    optionStopPct=Math.min(0.50,Math.max(0.20,estLoss/best.mid));
    console.log('[DYNAMIC STOP] dist:$'+dist.toFixed(2)+' delta:'+best.delta.toFixed(2)+' estLoss:$'+estLoss.toFixed(2)+' stopPct:'+(optionStopPct*100).toFixed(0)+'%');
  }

  var optionStop=parseFloat((best.mid*(1-optionStopPct)).toFixed(2));
  var t1Price=parseFloat((best.mid*(1+t1Pct)).toFixed(2));
  var qty=best.mid<=1.20?2:1;
  var timeCtx=getTimeContext();

  console.log('[OPRA] '+ticker+' '+best.symbol+' $'+best.strike+' mid:$'+best.mid+' '+dte+'DTE entry:'+entryMode+' T1:+'+(t1Pct*100).toFixed(0)+'% source:'+best.source);

  return {
    symbol:best.symbol, mid:best.mid, bid:best.bid, ask:best.ask,
    strike:best.strike, expiry, mode, dte, price,
    delta:best.delta, theta:best.theta, iv:best.iv,
    probITM:Math.round(best.probITM*100),
    volume:best.volume, openInterest:best.openInterest,
    lvls, underlyingStop, entryMode, entryPrice,
    optionStop, optionStopPct:Math.round(optionStopPct*100),
    t1Price, t1Pct:Math.round(t1Pct*100),
    qty, timeCtx, wideSpread:(best.ask-best.bid)/best.ask>0.15,
    source:best.source,
  };
}

// -- RESOLVE WITH SPECIFIC EXPIRY ---------------------------------
async function resolveContractWithExpiry(ticker, type, expiry) {
  try {
    var token=await getTSToken();
    if (!token) return null;
    var price=await getPrice(ticker, token);
    if (!price) return null;
    var rawChain=await getOptionChain(ticker, expiry, type, price, token);
    if (!rawChain.length) return null;
    var contracts=rawChain.map(function(c){return parseContract(c,expiry,type);}).filter(Boolean);
    if (!contracts.length) return null;
    var best=selectBestContract(contracts, price, MODES.SWING, null, type);
    if (!best) return null;
    return { symbol:best.symbol, mid:best.mid, bid:best.bid, ask:best.ask,
      strike:best.strike, expiry, mode:'SWING', dte:calcDTE(expiry),
      price, delta:best.delta, probITM:Math.round(best.probITM*100), source:best.source };
  } catch(e) { console.error('[RESOLVE EXPIRY] Error:',e.message); return null; }
}

// -- PARSE OPRA ---------------------------------------------------
function parseOPRA(opraSymbol) {
  try {
    var raw=(opraSymbol||'').trim().replace(/^O:/,'');
    var tsMatch=raw.match(/^([A-Z]+)\s+(\d{6})([CP])(\d+(?:\.\d+)?)$/);
    if (tsMatch) {
      var ds=tsMatch[2];
      return { ticker:tsMatch[1], expiry:'20'+ds.slice(0,2)+'-'+ds.slice(2,4)+'-'+ds.slice(4,6),
        type:tsMatch[3]==='C'?'call':'put', strike:parseFloat(tsMatch[4]), symbol:raw };
    }
    var opraMatch=raw.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
    if (opraMatch) {
      var ds2=opraMatch[2], whole=parseInt(opraMatch[4].slice(0,5),10), dec=parseInt(opraMatch[4].slice(5),10);
      var strike=dec===0?whole:parseFloat(whole+'.'+String(dec).replace(/0+$/,''));
      return { ticker:opraMatch[1], expiry:'20'+ds2.slice(0,2)+'-'+ds2.slice(2,4)+'-'+ds2.slice(4,6),
        type:opraMatch[3]==='C'?'call':'put', strike, symbol:opraMatch[1]+' '+ds2+opraMatch[3]+strike };
    }
    return null;
  } catch(e) { return null; }
}

// -- POSITION SIZING ----------------------------------------------
function calculatePositionSize(premium, mode, accountSize) {
  if (!mode) mode='SWING'; if (!accountSize) accountSize=6400;
  var config=MODES[mode]||MODES.SWING;
  if (!premium||premium<=0) return {viable:false,reason:'No premium'};
  if (premium>MAX_PREMIUM)  return {viable:false,reason:'Over $2.40 max'};
  if (premium<config.minPremium) return {viable:false,reason:'Under min'};
  var contracts=premium<=1.20?2:1;
  var stopPrice=parseFloat((premium*(1-config.stopPct)).toFixed(2));
  var t1Price=parseFloat((premium*(1+config.t1Pct)).toFixed(2));
  var stopLoss=parseFloat((premium*config.stopPct*100*contracts).toFixed(0));
  var t1Profit=parseFloat(((t1Price-premium)*100*contracts).toFixed(0));
  var totalCost=parseFloat((premium*100*contracts).toFixed(0));
  var riskPct=parseFloat((stopLoss/accountSize*100).toFixed(1));
  return {viable:true,mode,contracts,premium,totalCost,stopPrice,t1Price,stopLoss,t1Profit,riskPct};
}

// -- GET OPTION SNAPSHOT ------------------------------------------
async function getOptionSnapshot(tsSymbol) {
  try {
    var token=await getTSToken();
    if (!token) return null;
    var res=await fetch(getTSBase()+'/marketdata/quotes/'+encodeURIComponent(tsSymbol),
      { headers:{'Authorization':'Bearer '+token} });
    var data=await res.json();
    var quotes=data.Quotes||data.quotes||(Array.isArray(data)?data:[data]);
    var q=quotes[0]; if (!q) return null;
    return { symbol:tsSymbol, bid:parseFloat(q.Bid||0), ask:parseFloat(q.Ask||0),
      mid:parseFloat(q.Last||((parseFloat(q.Bid||0)+parseFloat(q.Ask||0))/2)),
      volume:parseInt(q.Volume||0), openInterest:parseInt(q.DailyOpenInterest||0) };
  } catch(e) { return null; }
}

module.exports = {
  parseOPRA, resolveContract, resolveContractWithExpiry,
  getOptionSnapshot, getPrice, getLVLs, getEntryMode,
  calculatePositionSize, getTimeContext, getT1Target,
  WATCHLIST, MIN_PREMIUM, MAX_PREMIUM, MODES,
};
