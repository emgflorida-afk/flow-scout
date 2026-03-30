// tradestation.js — Stratum Flow Scout v6.1
// Full Auth Code Flow handled via Railway web endpoint
// One-time setup: visit /ts-auth in browser to authenticate
// After that: auto-refreshes silently forever
// Priority: TradeStation → Public.com → Polygon
// -----------------------------------------------------------------

const fetch = require('node-fetch');

const TS_BASE     = 'https://api.tradestation.com/v3';
const TS_AUTH_URL = 'https://signin.tradestation.com/oauth/token';
const TS_LOGIN    = 'https://signin.tradestation.com/authorize';

function clientId()    { return process.env.TS_CLIENT_ID; }
function clientSecret(){ return process.env.TS_CLIENT_SECRET; }
function redirectUri() {
  return 'https://flow-scout-production.up.railway.app/ts-callback';
}

// In-memory token store
let _accessToken    = null;
let _refreshToken   = process.env.TS_REFRESH_TOKEN || null;
let _tokenExpiresAt = 0;

// -- GET ACCESS TOKEN ---------------------------------------------
async function getAccessToken() {
  if (_accessToken && Date.now() < _tokenExpiresAt - 60000) return _accessToken;

  if (_refreshToken) {
    try {
      const res = await fetch(TS_AUTH_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type:    'refresh_token',
          client_id:     clientId(),
          client_secret: clientSecret(),
          refresh_token: _refreshToken,
        }),
      });
      const data = await res.json();
      if (data.access_token) {
        _accessToken    = data.access_token;
        _tokenExpiresAt = Date.now() + (data.expires_in * 1000);
        if (data.refresh_token) _refreshToken = data.refresh_token;
        console.log('[TS] Token refreshed OK ✅');
        return _accessToken;
      }
      console.error('[TS] Refresh failed:', data.error_description || data.error);
    } catch (err) {
      console.error('[TS] Refresh error:', err.message);
    }
  }

  console.log('[TS] No valid token -- visit https://flow-scout-production.up.railway.app/ts-auth');
  return null;
}

// -- EXCHANGE AUTH CODE -------------------------------------------
async function exchangeCode(code) {
  const res = await fetch(TS_AUTH_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'authorization_code',
      client_id:     clientId(),
      client_secret: clientSecret(),
      code:          code,
      redirect_uri:  redirectUri(),
    }),
  });
  return await res.json();
}

// -- BUILD LOGIN URL ----------------------------------------------
function getLoginUrl() {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     clientId(),
    redirect_uri:  redirectUri(),
    audience:      'https://api.tradestation.com',
    scope:         'openid offline_access profile MarketData ReadAccount Trade',
  });
  return TS_LOGIN + '?' + params.toString();
}

// -- GET PRICE ----------------------------------------------------
async function getPrice(ticker) {
  try {
    const token = await getAccessToken();
    if (!token) return null;
    const res   = await fetch(TS_BASE + '/marketdata/quotes/' + ticker, {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (!res.ok) return null;
    const data  = await res.json();
    const quote = Array.isArray(data?.Quotes) ? data.Quotes[0] : null;
    const price = parseFloat(quote?.Last || quote?.Close || 0);
    if (price) { console.log('[PRICE] ' + ticker + ' $' + price + ' — TradeStation ✅'); return price; }
    return null;
  } catch (err) { console.error('[TS PRICE] Error:', err.message); return null; }
}

// -- GET OPTION EXPIRATIONS ---------------------------------------
async function getExpirations(ticker) {
  try {
    const token = await getAccessToken();
    if (!token) return [];
    const res   = await fetch(TS_BASE + '/marketdata/options/expirations/' + ticker, {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const exps = (data?.Expirations || []).map(e => e.Date || e.ExpirationDate).filter(Boolean);
    if (exps.length) console.log('[TS EXPIRY] ' + ticker + ': ' + exps.slice(0,4).join(', ') + ' ✅');
    return exps;
  } catch (err) { console.error('[TS EXPIRY] Error:', err.message); return []; }
}

// -- GET OPTION CHAIN ---------------------------------------------
async function getOptionChain(ticker, expiry, optionType) {
  try {
    const token = await getAccessToken();
    if (!token) return [];
    const type  = optionType === 'put' ? 'Put' : 'Call';
    const url   = TS_BASE + '/marketdata/options/chains/' + ticker +
      '?expiration=' + expiry + '&optionType=' + type + '&strikeProximity=10';
    const res   = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    if (!res.ok) return [];
    const data    = await res.json();
    const options = data?.Legs || data?.Options || [];
    console.log('[TS CHAIN] ' + ticker + ' ' + type + ' ' + expiry + ' — ' + options.length + ' contracts ✅');
    return options;
  } catch (err) { console.error('[TS CHAIN] Error:', err.message); return []; }
}

// -- GET GREEKS ---------------------------------------------------
async function getGreeks(opraSymbols) {
  try {
    if (!opraSymbols?.length) return {};
    const token   = await getAccessToken();
    if (!token) return {};
    const symbols = opraSymbols.join(',');
    const res     = await fetch(TS_BASE + '/marketdata/quotes/' + encodeURIComponent(symbols), {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (!res.ok) return {};
    const data  = await res.json();
    const items = Array.isArray(data?.Quotes) ? data.Quotes : [];
    const map   = {};
    for (const item of items) {
      const symbol = item?.Symbol;
      if (!symbol) continue;
      map[symbol] = {
        delta:             parseFloat(item.Delta             || 0),
        gamma:             parseFloat(item.Gamma             || 0),
        theta:             parseFloat(item.Theta             || 0),
        vega:              parseFloat(item.Vega              || 0),
        impliedVolatility: parseFloat(item.ImpliedVolatility || 0),
        bid:               parseFloat(item.Bid               || 0),
        ask:               parseFloat(item.Ask               || 0),
        last:              parseFloat(item.Last              || 0),
        openInterest:      parseInt(item.OpenInterest        || 0),
      };
    }
    console.log('[TS GREEKS] ' + Object.keys(map).length + ' contracts ✅');
    return map;
  } catch (err) { console.error('[TS GREEKS] Error:', err.message); return {}; }
}

function setRefreshToken(token) {
  _refreshToken = token;
  console.log('[TS] Refresh token updated in memory ✅');
}

module.exports = { getLoginUrl, exchangeCode, getAccessToken, getPrice, getExpirations, getOptionChain, getGreeks, setRefreshToken };
