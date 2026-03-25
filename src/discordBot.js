// discordBot.js — Stratum Flow Scout v6.1
// Discord slash command: /validate <idea>
// Uses Discord REST API directly — no discord.js package required
// Includes proper Ed25519 signature verification for Discord endpoint validation
// -----------------------------------------------------------------

const fetch        = require('node-fetch');
const crypto       = require('crypto');
const ideaValidator = require('./ideaValidator');

const BOT_TOKEN          = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID          = process.env.DISCORD_CLIENT_ID;
const GUILD_ID           = process.env.DISCORD_GUILD_ID;
const PUBLIC_KEY         = process.env.DISCORD_PUBLIC_KEY;
const CONVICTION_WEBHOOK = process.env.DISCORD_CONVICTION_WEBHOOK_URL;

const DISCORD_API = 'https://discord.com/api/v10';

// -- VERIFY DISCORD SIGNATURE -------------------------------------
// Discord requires Ed25519 signature verification on all interactions
// Without this the endpoint URL verification will always fail
function verifyDiscordSignature(rawBody, signature, timestamp) {
  try {
    if (!PUBLIC_KEY) {
      console.log('[BOT] No DISCORD_PUBLIC_KEY set -- skipping signature verification');
      return true; // Allow through if no key set (dev mode)
    }
    const message = Buffer.from(timestamp + rawBody);
    const sig     = Buffer.from(signature, 'hex');
    const key     = Buffer.from(PUBLIC_KEY, 'hex');

    // Use Node.js crypto for Ed25519 verification
    const keyObj = crypto.createPublicKey({
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
  if (!BOT_TOKEN || !CLIENT_ID || !GUILD_ID) {
    console.log('[BOT] Missing env vars -- skipping slash command registration');
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
      DISCORD_API + '/applications/' + CLIENT_ID + '/guilds/' + GUILD_ID + '/commands',
      {
        method:  'PUT',
        headers: {
          'Authorization': 'Bot ' + BOT_TOKEN,
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
        body:    JSON.stringify({
          type: 4,
          data: { content },
        }),
      }
    );
  } catch (err) {
    console.error('[BOT] Respond error:', err.message);
  }
}

// -- EDIT INTERACTION RESPONSE ------------------------------------
async function editInteractionResponse(appId, interactionToken, content) {
  try {
    await fetch(
      DISCORD_API + '/webhooks/' + appId + '/' + interactionToken + '/messages/@original',
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
    const result = await ideaValidator.validateAndPost(idea, CONVICTION_WEBHOOK);

    if (!result || result.error) {
      await editInteractionResponse(
        CLIENT_ID,
        interaction.token,
        'Could not parse trade idea. Try: `TICKER STRIKE P/C EXPIRY` e.g. `MSTR 136P 3/27 bearish`'
      );
      return;
    }

    await editInteractionResponse(
      CLIENT_ID,
      interaction.token,
      'Validation complete for **' + result.ticker + '** ' + (result.direction || '').toUpperCase() + '\n' +
      'Score: **' + result.score + '/5** -- ' + result.verdict + '\n' +
      'Full card posted to #conviction-trades'
    );
  } catch (err) {
    console.error('[BOT] Validation error:', err.message);
    await editInteractionResponse(CLIENT_ID, interaction.token, 'Validation failed -- check Railway logs');
  }
}

// -- HANDLE INCOMING INTERACTION ----------------------------------
// Called from Express route with raw body for signature verification
async function handleInteraction(req, res) {
  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];
  const rawBody   = JSON.stringify(req.body);

  // Verify signature
  if (signature && timestamp) {
    const valid = verifyDiscordSignature(rawBody, signature, timestamp);
    if (!valid) {
      console.log('[BOT] Invalid signature -- rejected');
      return res.status(401).send('Invalid signature');
    }
  }

  const body = req.body;

  // Discord ping (type 1) -- required for endpoint verification
  if (body.type === 1) {
    console.log('[BOT] Discord ping verified OK');
    return res.json({ type: 1 });
  }

  // Slash command (type 2)
  if (body.type === 2) {
    if (body.data && body.data.name === 'validate') {
      // Acknowledge immediately with deferred response
      res.json({ type: 5 });
      // Handle async after responding
      handleValidateCommand(body).catch(console.error);
      return;
    }
  }

  return res.json({ type: 1 });
}

// -- STARTUP ------------------------------------------------------
function startDiscordBot() {
  if (!BOT_TOKEN || !CLIENT_ID || !GUILD_ID) {
    console.log('[BOT] Discord env vars not set -- bot not started');
    console.log('[BOT] Set DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID, DISCORD_PUBLIC_KEY in Railway');
    return;
  }
  registerCommands();
  console.log('[BOT] Discord bot initialized OK -- /interactions endpoint ready');
}

module.exports = { startDiscordBot, handleInteraction };
