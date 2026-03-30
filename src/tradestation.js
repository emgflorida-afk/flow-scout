// tradestation.js - Stratum Flow Scout v7.0
// Full Auth Code Flow via Railway browser endpoint
// Visit /ts-auth to authenticate one time
// Auto-refreshes every 20 minutes after that

var fetch = require('node-fetch');

var TS_BASE     = 'https://api.tradestation.com/v3';
var TS_AUTH_URL = 'https://signin.tradestation.com/oauth/token';
var TS_LOGIN    = 'https://signin.tradestation.com/authorize';

function clientId()     { return process.env.TS_CLIENT_ID; }
function clientSecret() { return process.env.TS_CLIENT_SECRET; }
function redirectUri()  { return 'https://flow-scout-production.up.railway.app/ts-callback'; }

var _accessToken    = null;
var _refreshToken   = null;
var _tokenExpiresAt = 0;

function getRefreshToken() {
  return _refreshToken || process.env.TS_REFRESH_TOKEN || null;
}

async function getAccessToken() {
  if (_accessToken && Date.now() < _tokenExpiresAt - 60000) return _accessToken;
  var rt = getRefreshToken();
  if (rt) {
    try {
      var res = await fetch(TS_AUTH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type:    'refresh_token',
          client_id:     clientId(),
          client_secret: clientSecret(),
          refresh_token: rt,
        }),
      });
      var data = await res.json();
      if (data.access_token) {
        _accessToken    = data.access_token;
        _tokenExpiresAt = Date.now() + (data.expires_in * 1000);
        if (data.refresh_token) _refreshToken = data.refresh_token;
        console.log('[TS] Token refreshed OK');
        return _accessToken;
      }
      console.error('[TS] Refresh failed:', data.error_description || data.error);
    } catch(e) { console.error('[TS] Refresh error:', e.message); }
  }
  console.log('[TS] No token -- visit /ts-auth to authenticate');
  return null;
}

async function exchangeCode(code) {
  var res = await fetch(TS_AUTH_URL, {
    method: 'POST',
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

function getLoginUrl() {
  var params = new URLSearchParams({
    response_type: 'code',
    client_id:     clientId(),
    redirect_uri:  redirectUri(),
    audience:      'https://api.tradestation.com',
    scope:         'openid offline_access profile MarketData ReadAccount Trade',
  });
  return TS_LOGIN + '?' + params.toString();
}

async function getPrice(ticker) {
  try {
    var token = await getAccessToken();
    if (!token) return null;
    var res = await fetch(TS_BASE + '/marketdata/quotes/' + ticker, {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (!res.ok) return null;
    var data  = await res.json();
    var quote = Array.isArray(data && data.Quotes) ? data.Quotes[0] : null;
    var price = parseFloat((quote && (quote.Last || quote.Close)) || 0);
    if (price) { console.log('[TS PRICE] ' + ticker + ' $' + price); return price; }
    return null;
  } catch(e) { console.error('[TS PRICE] Error:', e.message); return null; }
}

function setRefreshToken(token) {
  _refreshToken = token;
  console.log('[TS] Refresh token set in memory');
}

module.exports = { getLoginUrl: getLoginUrl, exchangeCode: exchangeCode, getAccessToken: getAccessToken, getPrice: getPrice, setRefreshToken: setRefreshToken };