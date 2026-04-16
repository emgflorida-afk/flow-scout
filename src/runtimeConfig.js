// runtimeConfig.js -- Stratum v7.5
// -----------------------------------------------------------------
// Hot-swappable runtime config. Persisted to STATE_DIR so it survives
// redeploys. Scouts call runtimeConfig.get('CASEY_WATCHLIST') and get
// the hot value if set, otherwise falls back to process.env, otherwise
// returns null (so the scout uses its hardcoded default).
//
// Set via: POST /api/config { key: 'CASEY_WATCHLIST', value: 'SPY,...' }
// Get via: GET  /api/config
// Delete:  POST /api/config/delete { key: 'CASEY_WATCHLIST' }
// -----------------------------------------------------------------

var fs = require('fs');
var STATE_DIR = process.env.STATE_DIR || '/tmp';
try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch(e) {}
var CONFIG_FILE = STATE_DIR + '/runtime_config.json';

var config = {};

function load() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
    }
  } catch(e) { console.error('[RTCONFIG] load:', e.message); config = {}; }
}

function save() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); }
  catch(e) { console.error('[RTCONFIG] save:', e.message); }
}

load();

module.exports = {
  // Get: hot config > env var > null
  get: function(key) {
    if (config[key] !== undefined) return config[key];
    if (process.env[key] !== undefined) return process.env[key];
    return null;
  },

  // Set a runtime override
  set: function(key, value) {
    config[key] = value;
    save();
    return { key: key, value: value };
  },

  // Delete a runtime override (falls back to env/default)
  del: function(key) {
    delete config[key];
    save();
    return { key: key, deleted: true };
  },

  // Get all overrides
  getAll: function() {
    return Object.assign({}, config);
  },

  // Bulk set
  setMany: function(obj) {
    Object.keys(obj).forEach(function(k) { config[k] = obj[k]; });
    save();
    return Object.assign({}, config);
  },
};
