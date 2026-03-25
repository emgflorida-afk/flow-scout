// discordBot.js — Stratum Flow Scout v6.1
// Discord slash command: /validate <idea>
// Paste any trade idea → Stratum scores it → posts to #conviction-trades
// -----------------------------------------------------------------
// SETUP REQUIRED (one time):
// 1. Go to https://discord.com/developers/applications
// 2. Create new application → Bot → copy token → DISCORD_BOT_TOKEN env var
// 3. OAuth2 → URL Generator → scopes: bot, applications.commands
// 4. Bot permissions: Send Messages, Use Slash Commands
// 5. Add bot to your server via generated URL
// 6. Copy your server ID → DISCORD_GUILD_ID env var
// -----------------------------------------------------------------

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const ideaValidator = require('./ideaValidator');

const CONVICTION_WEBHOOK = process.env.DISCORD_CONVICTION_WEBHOOK_URL;
const BOT_TOKEN           = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID            = process.env.DISCORD_GUILD_ID;
const CLIENT_ID           = process.env.DISCORD_CLIENT_ID;

// -- REGISTER SLASH COMMAND ---------------------------------------
async function registerCommands() {
  if (!BOT_TOKEN || !CLIENT_ID || !GUILD_ID) {
    console.log('[BOT] Missing DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID or DISCORD_GUILD_ID — skipping slash command registration');
    return;
  }

  const commands = [
    new SlashCommandBuilder()
      .setName('validate')
      .setDescription('Validate a trade idea through Stratum scoring')
      .addStringOption(function(opt) {
        return opt
          .setName('idea')
          .setDescription('Paste the trade idea e.g. "MSTR 136P 3/27 bearish stop 138.72 target 127.45"')
          .setRequired(true);
      })
      .toJSON(),
  ];

  try {
    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('[BOT] Slash commands registered OK');
  } catch (err) {
    console.error('[BOT] Command registration error:', err.message);
  }
}

// -- START BOT ----------------------------------------------------
function startDiscordBot() {
  if (!BOT_TOKEN) {
    console.log('[BOT] No DISCORD_BOT_TOKEN — bot not started');
    return;
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once('ready', function() {
    console.log('[BOT] Discord bot online as ' + client.user.tag + ' OK');
    registerCommands();
  });

  client.on('interactionCreate', async function(interaction) {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'validate') return;

    const idea = interaction.options.getString('idea');
    console.log('[BOT] /validate received:', idea);

    // Acknowledge immediately — validation takes a few seconds
    await interaction.reply({ content: 'Validating: *' + idea + '*\nRunning Stratum scoring...', ephemeral: false });

    try {
      const result = await ideaValidator.validateAndPost(idea, CONVICTION_WEBHOOK);

      if (result.error) {
        await interaction.editReply('Could not parse trade idea. Try format: `TICKER STRIKE P/C EXPIRY` e.g. `MSTR 136P 3/27 bearish`');
        return;
      }

      await interaction.editReply(
        'Validation complete for **' + result.ticker + '** ' + result.direction.toUpperCase() + '\n' +
        'Score: **' + result.score + '/5** — ' + result.verdict + '\n' +
        'Full card posted to #conviction-trades'
      );
    } catch (err) {
      console.error('[BOT] Validation error:', err.message);
      await interaction.editReply('Validation failed — check Railway logs');
    }
  });

  client.login(BOT_TOKEN).catch(function(err) {
    console.error('[BOT] Login error:', err.message);
  });

  return client;
}

module.exports = { startDiscordBot };
