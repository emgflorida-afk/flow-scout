// =============================================================================
// PUBLIC.COM BROKER INTEGRATION (May 1 2026 — v6 PM)
//
// JS client for Public's REST API. Mirrors the official Python SDK structure
// (PublicDotCom/publicdotcom-py) so future maintenance maps cleanly.
//
// Public is a CASH ACCOUNT — no PDT restrictions. AB uses this for day-trade
// activity when TS Titan margin would PDT-flag him. Account size $500-1000 cap.
//
// Env vars (already on Railway):
//   PUBLIC_API_KEY     — bearer token  (32-char alphanumeric)
//   PUBLIC_ACCOUNT_ID  — account number (e.g. "5OF64813")
//
// Public API base:        https://api.public.com/userapigateway/trading
// Auth:                   Authorization: Bearer <PUBLIC_API_KEY>
// Order placement URL:    POST /{ACCOUNT_ID}/order   ← account ID is in path
// Order cancellation:     DELETE /orders/{order_id}
// Symbol format:          OPRA without spaces — "AAPL251024C00110000"
//                          (TS uses "AAPL 251024C00110000" with a space)
// =============================================================================

var fetch = (typeof globalThis.fetch === 'function') ? globalThis.fetch : require('node-fetch');
var crypto = require('crypto');

var BASE_URL = process.env.PUBLIC_API_BASE || 'https://api.public.com/userapigateway/trading';
var AUTH_URL = process.env.PUBLIC_AUTH_URL || 'https://api.public.com/userapiauthservice/personal/access-tokens';

// =============================================================================
// AUTH FLOW (May 1 2026)
// =============================================================================
// Public uses a 2-step auth: API SECRET KEY exchanged for short-lived ACCESS
// TOKEN at /userapiauthservice/personal/access-tokens. Token is then used as
// Bearer in subsequent API calls. We cache the token in-memory and refresh
// before expiry (default 1440 min validity, 5-min safety margin).
// =============================================================================

var _cachedToken = null;
var _tokenExpiresAt = 0;
var TOKEN_VALIDITY_MIN = parseInt(process.env.PUBLIC_TOKEN_VALIDITY || '1440');   // 24h
var TOKEN_SAFETY_MS = 5 * 60 * 1000;   // refresh 5 min before expiry

async function getAccessToken() {
  if (_cachedToken && Date.now() < _tokenExpiresAt) return _cachedToken;
  var secret = process.env.PUBLIC_API_KEY;
  if (!secret) throw new Error('PUBLIC_API_KEY missing');
  var r = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: secret, validityInMinutes: TOKEN_VALIDITY_MIN }),
  });
  if (!r.ok) {
    var t = '';
    try { t = await r.text(); } catch(e) {}
    throw new Error('public-auth-' + r.status + ' ' + t.slice(0, 200));
  }
  var data = await r.json();
  if (!data || !data.accessToken) throw new Error('public-auth: no accessToken in response');
  _cachedToken = data.accessToken;
  _tokenExpiresAt = Date.now() + (TOKEN_VALIDITY_MIN * 60 * 1000) - TOKEN_SAFETY_MS;
  return _cachedToken;
}

async function getAuth() {
  var accountId = process.env.PUBLIC_ACCOUNT_ID;
  if (!accountId) throw new Error('PUBLIC_ACCOUNT_ID missing');
  var token = await getAccessToken();
  return {
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    accountId: accountId,
  };
}

function makeOrderId() {
  // Public requires a UUID-ish unique order_id per call
  return crypto.randomUUID
    ? crypto.randomUUID()
    : ('xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx').replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
}

// =============================================================================
// SYMBOL FORMAT HELPERS
// =============================================================================
// TS Titan format:    "AAPL 251024C00110000"  (space)
// Public format:      "AAPL251024C00110000"   (no space)
// Both: OPRA spec — UNDERLYING + YYMMDD + C/P + 8-digit strike (×1000)

function tsSymbolToPublic(tsSymbol) {
  if (!tsSymbol) return null;
  return String(tsSymbol).replace(/\s+/g, '');
}

function publicSymbolToTs(pubSymbol) {
  if (!pubSymbol) return null;
  // Insert space before the 6-digit date
  var m = String(pubSymbol).match(/^([A-Z]+)(\d{6}[CP]\d+)$/);
  return m ? m[1] + ' ' + m[2] : pubSymbol;
}

// =============================================================================
// ACCOUNT / PORTFOLIO
// =============================================================================
async function getAccount() {
  var a = await getAuth();
  var r = await fetch(BASE_URL + '/account', { headers: a.headers });
  if (!r.ok) {
    var t = '';
    try { t = await r.text(); } catch(e) {}
    throw new Error('public-getAccount-' + r.status + ' ' + t.slice(0, 120));
  }
  return await r.json();
}

async function getAccounts() {
  var a = await getAuth();
  var r = await fetch(BASE_URL + '/accounts', { headers: a.headers });
  if (!r.ok) throw new Error('public-getAccounts-' + r.status);
  return await r.json();
}

async function getPortfolio() {
  var a = await getAuth();
  var r = await fetch(BASE_URL + '/portfolio-v2?accountId=' + encodeURIComponent(a.accountId), { headers: a.headers });
  if (!r.ok) {
    var t = '';
    try { t = await r.text(); } catch(e) {}
    throw new Error('public-getPortfolio-' + r.status + ' ' + t.slice(0, 120));
  }
  return await r.json();
}

// =============================================================================
// MARKET DATA
// =============================================================================
async function getQuotes(symbols) {
  if (!Array.isArray(symbols)) symbols = [symbols];
  var a = await getAuth();
  var body = {
    instruments: symbols.map(function(s) {
      // If symbol contains a space or has the OPRA pattern, treat as OPTION
      var clean = tsSymbolToPublic(s);
      var isOption = /\d{6}[CP]\d+/.test(clean);
      return { symbol: clean, type: isOption ? 'OPTION' : 'EQUITY' };
    }),
  };
  var r = await fetch(BASE_URL + '/quotes', {
    method: 'POST',
    headers: a.headers,
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    var t = '';
    try { t = await r.text(); } catch(e) {}
    throw new Error('public-getQuotes-' + r.status + ' ' + t.slice(0, 120));
  }
  return await r.json();
}

async function getOptionExpirations(underlyingSymbol) {
  var a = await getAuth();
  var r = await fetch(BASE_URL + '/option-expirations', {
    method: 'POST',
    headers: a.headers,
    body: JSON.stringify({
      instrument: { symbol: underlyingSymbol, type: 'EQUITY' },
    }),
  });
  if (!r.ok) throw new Error('public-getOptionExpirations-' + r.status);
  return await r.json();
}

async function getOptionChain(underlyingSymbol, expirationDate) {
  var a = await getAuth();
  var r = await fetch(BASE_URL + '/option-chain', {
    method: 'POST',
    headers: a.headers,
    body: JSON.stringify({
      instrument: { symbol: underlyingSymbol, type: 'EQUITY' },
      expirationDate: expirationDate,
    }),
  });
  if (!r.ok) throw new Error('public-getOptionChain-' + r.status);
  return await r.json();
}

// =============================================================================
// ORDER PLACEMENT
// =============================================================================
//
// Mirrors the Python SDK schema. Fields:
//   symbol         : OPRA option symbol or equity ticker
//   instrumentType : "OPTION" or "EQUITY" (default OPTION if symbol matches OPRA)
//   side           : "BUY" or "SELL"
//   quantity       : integer count (string in payload per SDK convention)
//   orderType      : "LIMIT" | "MARKET" | "STOP" | "STOP_LIMIT"
//   limitPrice     : required for LIMIT (string with 2 decimals)
//   stopPrice      : required for STOP / STOP_LIMIT
//   timeInForce    : "DAY" | "GTC" | default DAY
//   openCloseInd   : "OPEN" or "CLOSE" — required for options orders
//
async function placeOrder(opts) {
  if (!opts || !opts.symbol) throw new Error('placeOrder: symbol required');
  if (!opts.side)            throw new Error('placeOrder: side required (BUY/SELL)');
  if (!opts.quantity)        throw new Error('placeOrder: quantity required');

  var a = await getAuth();
  var symbol = tsSymbolToPublic(opts.symbol);
  var isOption = /\d{6}[CP]\d+/.test(symbol);
  var instrumentType = opts.instrumentType || (isOption ? 'OPTION' : 'EQUITY');
  var orderType = (opts.orderType || 'LIMIT').toUpperCase();
  var orderSide = String(opts.side).toUpperCase();
  var openClose = (opts.openCloseIndicator || (orderSide === 'BUY' ? 'OPEN' : 'CLOSE')).toUpperCase();

  var payload = {
    orderId: opts.orderId || makeOrderId(),
    instrument: { symbol: symbol, type: instrumentType },
    orderSide: orderSide,
    orderType: orderType,
    expiration: { timeInForce: (opts.timeInForce || 'DAY').toUpperCase() },
    quantity: String(opts.quantity),
  };

  if (orderType === 'LIMIT' || orderType === 'STOP_LIMIT') {
    if (opts.limitPrice == null) throw new Error('placeOrder: limitPrice required for LIMIT/STOP_LIMIT');
    payload.limitPrice = Number(opts.limitPrice).toFixed(2);
  }
  if (orderType === 'STOP' || orderType === 'STOP_LIMIT') {
    if (opts.stopPrice == null) throw new Error('placeOrder: stopPrice required for STOP/STOP_LIMIT');
    payload.stopPrice = Number(opts.stopPrice).toFixed(2);
  }
  if (instrumentType === 'OPTION') {
    payload.openCloseIndicator = openClose;
  }

  var url = BASE_URL + '/' + encodeURIComponent(a.accountId) + '/order';
  var r = await fetch(url, {
    method: 'POST',
    headers: a.headers,
    body: JSON.stringify(payload),
  });
  var bodyText = '';
  try { bodyText = await r.text(); } catch(e) {}
  if (!r.ok) {
    return {
      ok: false,
      status: r.status,
      error: bodyText.slice(0, 500),
      requestPayload: payload,
    };
  }
  try {
    return Object.assign({ ok: true, requestPayload: payload }, JSON.parse(bodyText));
  } catch (e) {
    return { ok: true, status: r.status, raw: bodyText.slice(0, 500), requestPayload: payload };
  }
}

// =============================================================================
// PRE-FLIGHT (validate without placing)
// =============================================================================
async function preflightOrder(opts) {
  // Same payload as placeOrder but uses the preflight-single-leg endpoint
  if (!opts || !opts.symbol) throw new Error('preflightOrder: symbol required');
  var a = await getAuth();
  var symbol = tsSymbolToPublic(opts.symbol);
  var isOption = /\d{6}[CP]\d+/.test(symbol);
  var instrumentType = opts.instrumentType || (isOption ? 'OPTION' : 'EQUITY');
  var orderType = (opts.orderType || 'LIMIT').toUpperCase();

  var payload = {
    instrument: { symbol: symbol, type: instrumentType },
    orderSide: String(opts.side).toUpperCase(),
    orderType: orderType,
    expiration: { timeInForce: (opts.timeInForce || 'DAY').toUpperCase() },
    quantity: String(opts.quantity),
  };
  if (orderType === 'LIMIT' || orderType === 'STOP_LIMIT') payload.limitPrice = Number(opts.limitPrice).toFixed(2);
  if (orderType === 'STOP'  || orderType === 'STOP_LIMIT') payload.stopPrice  = Number(opts.stopPrice).toFixed(2);
  if (instrumentType === 'OPTION') payload.openCloseIndicator = (opts.openCloseIndicator || (String(opts.side).toUpperCase() === 'BUY' ? 'OPEN' : 'CLOSE'));

  var url = BASE_URL + '/orders/preflight-single-leg';
  var r = await fetch(url, { method: 'POST', headers: a.headers, body: JSON.stringify(payload) });
  var t = '';
  try { t = await r.text(); } catch(e) {}
  if (!r.ok) return { ok: false, status: r.status, error: t.slice(0, 500), requestPayload: payload };
  try { return Object.assign({ ok: true, requestPayload: payload }, JSON.parse(t)); }
  catch (e) { return { ok: true, raw: t, requestPayload: payload }; }
}

// =============================================================================
// CANCEL / GET ORDER
// =============================================================================
async function cancelOrder(orderId) {
  if (!orderId) throw new Error('cancelOrder: orderId required');
  var a = await getAuth();
  var r = await fetch(BASE_URL + '/orders/' + encodeURIComponent(orderId) + '?accountId=' + encodeURIComponent(a.accountId), {
    method: 'DELETE',
    headers: a.headers,
  });
  var t = '';
  try { t = await r.text(); } catch(e) {}
  if (!r.ok) return { ok: false, status: r.status, error: t.slice(0, 500) };
  try { return Object.assign({ ok: true }, JSON.parse(t)); }
  catch (e) { return { ok: true, raw: t }; }
}

async function getOrder(orderId) {
  var a = await getAuth();
  var r = await fetch(BASE_URL + '/orders/' + encodeURIComponent(orderId) + '?accountId=' + encodeURIComponent(a.accountId), {
    headers: a.headers,
  });
  if (!r.ok) {
    var t = '';
    try { t = await r.text(); } catch(e) {}
    throw new Error('public-getOrder-' + r.status + ' ' + t.slice(0, 120));
  }
  return await r.json();
}

// =============================================================================
// DIAGNOSTIC — verify auth + connectivity
// =============================================================================
async function ping() {
  try {
    var a = await getAuth();
    var data = await getAccount();
    return {
      ok: true,
      accountId: a.accountId,
      auth: 'configured',
      sample: data,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  ping: ping,
  getAccount: getAccount,
  getAccounts: getAccounts,
  getPortfolio: getPortfolio,
  getQuotes: getQuotes,
  getOptionExpirations: getOptionExpirations,
  getOptionChain: getOptionChain,
  placeOrder: placeOrder,
  preflightOrder: preflightOrder,
  cancelOrder: cancelOrder,
  getOrder: getOrder,
  // helpers
  tsSymbolToPublic: tsSymbolToPublic,
  publicSymbolToTs: publicSymbolToTs,
  makeOrderId: makeOrderId,
};
