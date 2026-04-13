// tradestation.js - Stratum Flow Scout v7.0
// Full Auth Code Flow via Railway browser endpoint
// Visit /ts-auth to authenticate one time
// Auto-refreshes every 20 minutes after that

var fetch = require('node-fetch');

var etTime = null;
try { etTime = require('./etTime'); } catch(e) {}

var TS_BASE     = 'https://api.tradestation.com/v3';
var TS_AUTH_URL = 'https://signin.tradestation.com/oauth/token';
var TS_LOGIN    = 'https://signin.tradestation.com/authorize';

function clientId()     { return process.env.TS_CLIENT_ID; }
function clientSecret() { return process.env.TS_CLIENT_SECRET; }
function redirectUri()  { return process.env.TS_REDIRECT_URI || 'https://flow-scout-production-f021.up.railway.app/ts-callback'; }

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
          scope:         'openid offline_access profile MarketData ReadAccount Trade OptionSpreads Matrix',
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
      // Only alert during market hours (9AM-4:30PM ET) to avoid false alarms
      var _et = etTime ? etTime.getETTime() : { hour: ((new Date().getUTCHours() - 4) + 24) % 24, min: new Date().getUTCMinutes(), total: 0 }; var etHourNow = _et.hour;
      var isDuringMarketHours = etHourNow >= 9 && etHourNow < 17;
      if (isDuringMarketHours) {
      // Post to Discord ONCE per hour max -- use strat-alerts not execute-now
      var now = Date.now();
      var lastAlert = global._lastTokenAlert || 0;
      var oneHour = 60 * 60 * 1000;
      if (now - lastAlert > oneHour) {
        global._lastTokenAlert = now;
        try {
          var webhook = process.env.DISCORD_STRAT_WEBHOOK ||
            process.env.DISCORD_EXECUTE_NOW_WEBHOOK ||
            'https://discord.com/api/webhooks/1489007440501538949/Lm7EAa9zEXG6Uh3gEG7Flnw378sMmmeupCHG2yLceDmHCQQZO5TI4Z3jkujQGaZdCWPx';
          await fetch(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: '```\n TS TOKEN NEEDS REFRESH\nFix: https://flow-scout-production.up.railway.app/ts-auth\n(This alert fires max once per hour)\n```',
              username: 'Stratum Token Monitor',
            }),
          });
        } catch(de) { /* discord alert failed -- not critical */ }
      }
      } // end isDuringMarketHours check
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
    scope:         'openid offline_access profile MarketData ReadAccount Trade OptionSpreads Matrix',
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
  _accessToken = null;
  _tokenExpiresAt = 0;
  console.log('[TS] Refresh token set + access token cleared -- will re-auth on next call');
}

async function exchangeCodeWithRedirect(code, redirect) {
  var res = await fetch(TS_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'authorization_code',
      client_id:     clientId(),
      client_secret: clientSecret(),
      code:          code,
      redirect_uri:  redirect,
    }),
  });
  return await res.json();
}

module.exports = { getLoginUrl: getLoginUrl, exchangeCode: exchangeCode, exchangeCodeWithRedirect: exchangeCodeWithRedirect, getAccessToken: getAccessToken, getPrice: getPrice, setRefreshToken: setRefreshToken };