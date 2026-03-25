// discordBot.js — Stratum Flow Scout v6.1
// Discord slash command: /validate <idea>
// Uses Discord REST API directly — no discord.js package required
// Registers commands on startup, listens via interaction endpoint
// -----------------------------------------------------------------
// SETUP REQUIRED (one time):
// 1. discord.com/developers/applications -> New Application -> Bot
// 2. Copy Bot Token -> DISCORD_BOT_TOKEN Railway env var
// 3. Copy Application ID -> DISCORD_CLIENT_ID Railway env var
// 4. Right click your Discord server -> Copy Server ID -> DISCORD_GUILD_ID
// 5. OAuth2 -> URL Generator -> scopes: bot + applications.commands
//    Permissions: Send Messages -> invite bot to your server
// 6. Set Railway public domain as interactions endpoint URL:
//    https://flow-scout-production.up.railway.app/interactions
// -----------------------------------------------------------------

const fetch        = require('node-fetch');
const ideaValidator = require('./ideaValidator');

const BOT_TOKEN   = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID   = process.env.DISCORD_CLIENT_ID;
const GUILD_ID    = process.env.DISCORD_GUILD_ID;
const CONVICTION_WEBHOOK = process.env.DISCORD_CONVICTION_WEBHOOK_URL;

const DISCORD_API = 'https://discord.com/api/v10';

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
          type:        3, // STRING
          name:        'idea',
          description: 'Paste trade idea e.g. "MSTR 136P 3/27 bearish stop 138.72 target 127.45"',
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
          type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
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

// -- HANDLE SLASH COMMAND -----------------------------------------
async function handleValidateCommand(interaction) {
  const idea = interaction.data?.options?.find(function(o) { return o.name === 'idea'; })?.value || '';

  if (!idea) {
    await respondToInteraction(interaction.id, interaction.token, 'Please provide a trade idea.');
    return;
  }

  console.log('[BOT] /validate received:', idea);

  // Acknowledge immediately — validation takes a few seconds
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

// -- HANDLE INCOMING INTERACTION (from Express route) -------------
async function handleInteraction(body) {
  // Ping (type 1) — Discord verification
  if (body.type === 1) {
    return { type: 1 };
  }

  // Slash command (type 2)
  if (body.type === 2) {
    if (body.data?.name === 'validate') {
      // Handle async — don't wait for response
      handleValidateCommand(body).catch(console.error);
      // Return deferred response
      return { type: 5 }; // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
    }
  }

  return { type: 1 };
}

// -- STARTUP ------------------------------------------------------
function startDiscordBot() {
  if (!BOT_TOKEN || !CLIENT_ID || !GUILD_ID) {
    console.log('[BOT] Discord env vars not set -- bot not started');
    console.log('[BOT] Set DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID in Railway');
    return;
  }
  registerCommands();
  console.log('[BOT] Discord bot initialized OK -- /interactions endpoint ready');
}

module.exports = { startDiscordBot, handleInteraction };
