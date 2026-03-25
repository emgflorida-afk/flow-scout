// discordBot.js — Stratum Flow Scout v6.1
// Discord slash command: /validate <idea>
// Uses Discord REST API directly -- no discord.js package required
// Includes proper Ed25519 signature verification for Discord endpoint validation
// Env vars read at runtime to avoid Railway timing issues
// -----------------------------------------------------------------

const fetch         = require('node-fetch');
const crypto        = require('crypto');
const ideaValidator = require('./ideaValidator');

const DISCORD_API = 'https://discord.com/api/v10';

// Read env vars at runtime inside functions -- avoids Railway load order issues
function getBotToken()          { return process.env.DISCORD_BOT_TOKEN; }
function getClientId()          { return process.env.DISCORD_CLIENT_ID; }
function getGuildId()           { return process.env.DISCORD_GUILD_ID; }
function getPublicKey()         { return process.env.DISCORD_PUBLIC_KEY; }
function getConvictionWebhook() { return process.env.DISCORD_CONVICTION_WEBHOOK_URL; }

// -- VERIFY DISCORD SIGNATURE -------------------------------------
function verifyDiscordSignature(rawBody, signature, timestamp) {
  try {
    const publicKey = getPublicKey();
    if (!publicKey) {
      console.log('[BOT] No DISCORD_PUBLIC_KEY -- skipping verification');
      return true;
    }
    const message = Buffer.from(timestamp + rawBody);
    const sig     = Buffer.from(signature, 'hex');
    const key     = Buffer.from(publicKey, 'hex');
    const keyObj  = crypto.createPublicKey({
      key:    Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key]),
      format: 'der',
      type:   'spki',
    });
    return crypto.verify(null, message, keyObj, sig);
  } catch (err) {
    console.error('[BOT] Signature verification error:', err.message);
    return false;
  }
}

// -- REGISTER SLASH COMMANDS --------------------------------------
async function registerCommands() {
  const botToken = getBotToken();
  const clientId = getClientId();
  const guildId  = getGuildId();

  if (!botToken || !clientId || !guildId) {
    console.log('[BOT] Missing env vars -- skipping slash command registration');
    console.log('[BOT] BOT_TOKEN:', botToken ? 'set' : 'MISSING');
    console.log('[BOT] CLIENT_ID:', clientId ? 'set' : 'MISSING');
    console.log('[BOT] GUILD_ID:',  guildId  ? 'set' : 'MISSING');
    return;
  }

  const commands = [
    {
      name:        'validate',
      description: 'Validate a trade idea through Stratum scoring',
      options: [
        {
          type:        3,
          name:        'idea',
          description: 'e.g. "MSTR 136P 3/27 bearish stop 138.72 target 127.45"',
          required:    true,
        },
      ],
    },
  ];

  try {
    const res = await fetch(
      DISCORD_API + '/applications/' + clientId + '/guilds/' + guildId + '/commands',
      {
        method:  'PUT',
        headers: {
          'Authorization': 'Bot ' + botToken,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify(commands),
      }
    );
    if (res.ok) {
      console.log('[BOT] Slash commands registered OK');
    } else {
      const err = await res.text();
      console.error('[BOT] Command registration failed:', err);
    }
  } catch (err) {
    console.error('[BOT] Registration error:', err.message);
  }
}

// -- RESPOND TO INTERACTION ---------------------------------------
async function respondToInteraction(interactionId, interactionToken, content) {
  try {
    await fetch(
      DISCORD_API + '/interactions/' + interactionId + '/' + interactionToken + '/callback',
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ type: 4, data: { content } }),
      }
    );
  } catch (err) {
    console.error('[BOT] Respond error:', err.message);
  }
}

// -- EDIT INTERACTION RESPONSE ------------------------------------
async function editInteractionResponse(interactionToken, content) {
  const clientId = getClientId();
  try {
    await fetch(
      DISCORD_API + '/webhooks/' + clientId + '/' + interactionToken + '/messages/@original',
      {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ content }),
      }
    );
  } catch (err) {
    console.error('[BOT] Edit response error:', err.message);
  }
}

// -- HANDLE VALIDATE COMMAND --------------------------------------
async function handleValidateCommand(interaction) {
  const idea = interaction.data && interaction.data.options
    ? (interaction.data.options.find(function(o) { return o.name === 'idea'; }) || {}).value || ''
    : '';

  if (!idea) {
    await respondToInteraction(interaction.id, interaction.token, 'Please provide a trade idea.');
    return;
  }

  console.log('[BOT] /validate received:', idea);

  await respondToInteraction(
    interaction.id,
    interaction.token,
    'Validating: *' + idea + '*\nRunning Stratum scoring...'
  );

  try {
    const result = await ideaValidator.validateAndPost(idea, getConvictionWebhook());

    if (!result || result.error) {
      await editInteractionResponse(
        interaction.token,
        'Could not parse trade idea. Try: `TICKER STRIKE P/C EXPIRY` e.g. `MSTR 136P 3/27 bearish`'
      );
      return;
    }

    await editInteractionResponse(
      interaction.token,
      'Validation complete for **' + result.ticker + '** ' + (result.direction || '').toUpperCase() + '\n' +
      'Score: **' + result.score + '/5** -- ' + result.verdict + '\n' +
      'Full card posted to #conviction-trades'
    );
  } catch (err) {
    console.error('[BOT] Validation error:', err.message);
    await editInteractionResponse(interaction.token, 'Validation failed -- check Railway logs');
  }
}

// -- HANDLE INCOMING INTERACTION ----------------------------------
async function handleInteraction(req, res) {
  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];
  const rawBody   = JSON.stringify(req.body);

  if (signature && timestamp) {
    const valid = verifyDiscordSignature(rawBody, signature, timestamp);
    if (!valid) {
      console.log('[BOT] Invalid signature -- rejected');
      return res.status(401).send('Invalid signature');
    }
  }

  const body = req.body;

  if (body.type === 1) {
    console.log('[BOT] Discord ping verified OK');
    return res.json({ type: 1 });
  }

  if (body.type === 2 && body.data && body.data.name === 'validate') {
    res.json({ type: 5 });
    handleValidateCommand(body).catch(console.error);
    return;
  }

  return res.json({ type: 1 });
}

// -- STARTUP ------------------------------------------------------
function startDiscordBot() {
  const botToken = getBotToken();
  const clientId = getClientId();
  const guildId  = getGuildId();

  if (!botToken || !clientId || !guildId) {
    console.log('[BOT] Discord env vars not set -- bot not started');
    console.log('[BOT] BOT_TOKEN:', botToken ? 'set' : 'MISSING');
    console.log('[BOT] CLIENT_ID:', clientId ? 'set' : 'MISSING');
    console.log('[BOT] GUILD_ID:',  guildId  ? 'set' : 'MISSING');
    return;
  }

  registerCommands();
  console.log('[BOT] Discord bot initialized OK -- /interactions endpoint ready');
}

module.exports = { startDiscordBot, handleInteraction };
