#!/usr/bin/env node
/**
 * P2.2.6 K7 real Discord command-schema doctor.
 *
 * Logs in with the bot token, FETCHES the actual registered application
 * commands back from Discord and compares them to the desired schema produced
 * by the running source tree. This is the objective proof that the remote
 * schema matches the code (never a local-constant check).
 *
 * It never prints the token. Exit 0 only when the fetched schema matches; a
 * mismatch prints the offending commands/fields.
 *
 *   node scripts/command-schema-doctor.mjs
 */
// First import on purpose: it wraps the `ws` WebSocket constructor before
// discord.js is evaluated (see src/discord-proxy.mjs).
import '../src/discord-proxy.mjs';

import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { resolveDiscordProxy } from '../src/win-env.mjs';
import { configureDiscordProxy } from '../src/discord-proxy.mjs';
import { verifyApplicationCommands } from '../src/commands.mjs';

const token = process.env.DISCORD_TOKEN;
const failures = [];
function line(ok, label, detail = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

if (!token) {
  console.log('FAIL  DISCORD_TOKEN is not set');
  process.exit(1);
}

const proxy = await resolveDiscordProxy(process.env.DISCORD_PROXY);
if (proxy.proxyUrl) configureDiscordProxy(proxy.proxyUrl);

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

try {
  await client.login(token);
  const application = client.application ?? (await client.application?.fetch?.()) ?? null;
  const result = await verifyApplicationCommands({
    application,
    guildId: process.env.DISCORD_COMMANDS_GUILD_ID || null,
    logger: console,
  });

  line(Boolean(application), 'application resolved');
  line(result.workTaskMaxLength === 6000, '/work task max_length == 6000', `got ${result.workTaskMaxLength}`);
  line(Boolean(result.ok), 'fetched Discord command schema matches desired', `${result.mismatches?.length || 0} mismatch(es)`);
  if (result.error) console.log(`     error: ${result.error}`);
  for (const mismatch of (result.mismatches ?? []).slice(0, 8)) {
    console.log(`     mismatch: ${mismatch.command} · ${mismatch.field}`);
  }
} catch (error) {
  line(false, 'login / fetch-back', error?.message || String(error));
} finally {
  await client.destroy().catch(() => {});
}

process.exit(failures.length ? 1 : 0);
