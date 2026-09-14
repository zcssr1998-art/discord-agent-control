#!/usr/bin/env node
/**
 * Discord connectivity doctor.
 *
 * Run this before the first real smoke test. It never prints the token, and it
 * tells you exactly what is missing instead of failing later inside the bridge.
 *
 *   node scripts/discord-doctor.mjs
 *   node scripts/discord-doctor.mjs --send-test-dm
 */
import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, PermissionFlagsBits } from 'discord.js';

const sendTestDm = process.argv.includes('--send-test-dm');
const token = process.env.DISCORD_TOKEN;
const ownerId = process.env.DISCORD_OWNER_ID;

const problems = [];
function line(ok, label, detail = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

if (!token) problems.push('DISCORD_TOKEN is not set');
if (!ownerId) problems.push('DISCORD_OWNER_ID is not set');
line(Boolean(token), 'DISCORD_TOKEN present');
line(Boolean(ownerId), 'DISCORD_OWNER_ID present');

if (problems.length) {
  console.log('\nFix .env first (copy .env.example to .env), then re-run.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

try {
  await client.login(token);
  line(true, 'login succeeded', `bot = ${client.user.tag} (${client.user.id})`);

  const me = await client.user.fetch(true);
  line(me.bot, 'account is a bot account');

  const invite = client.generateInvite({
    scopes: ['bot'],
    permissions: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.EmbedLinks,
    ],
  });
  console.log(`\nInvite URL (only needed if the bot is not in your server yet):\n${invite}`);

  const guilds = [...client.guilds.cache.values()];
  console.log(`\nGuilds: ${guilds.length}`);
  for (const g of guilds) {
    const channel = g.channels.cache.find((c) => c.isTextBased?.() && c.permissionsFor?.(client.user)?.has('SendMessages'));
    console.log(`  - ${g.name} (${g.id})${channel ? ` -> can post in #${channel.name} (${channel.id})` : ' -> no writable text channel found'}`);
  }

  const owner = await client.users.fetch(ownerId).catch(() => null);
  line(Boolean(owner), 'owner user resolved', owner ? `${owner.tag} (${owner.id})` : 'check DISCORD_OWNER_ID');
  if (!owner) problems.push('DISCORD_OWNER_ID does not resolve to a Discord user');

  const sharedGuild = guilds.find((g) => g.members.cache.has(ownerId));
  line(Boolean(sharedGuild) || Boolean(owner), 'owner can be reached',
    sharedGuild ? `shares guild "${sharedGuild.name}"` : 'no shared guild cached — the bot must share a server with you for DMs to work');

  if (sendTestDm && owner) {
    await owner.send('discord-agent-control doctor: DM channel works. You can reply here to drive the agent.');
    line(true, 'test DM sent to owner');
  } else {
    console.log('\nTip: re-run with --send-test-dm to prove the DM channel works.');
  }

  console.log('\nReminder: the bot needs the MESSAGE CONTENT INTENT enabled in the Discord Developer Portal, otherwise message text arrives empty.');
  if (problems.length) {
    console.log('\nProblems:');
    for (const p of problems) console.log(` - ${p}`);
  }
  process.exit(problems.length ? 1 : 0);
} catch (error) {
  line(false, 'login failed', error?.message || String(error));
  console.log('\nCommon causes: wrong/rotated token, or the token was reset in the Developer Portal.');
  process.exit(1);
} finally {
  await client.destroy().catch(() => {});
}
