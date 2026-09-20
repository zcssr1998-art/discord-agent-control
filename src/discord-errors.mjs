/**
 * Turn Discord's terse errors into something the user can act on.
 *
 * The two failures that actually happen in practice are a blocked network
 * (discord.com unreachable because Node ignores the Windows system proxy) and a
 * disabled privileged intent. Both otherwise surface as one opaque line.
 */

const INTENT_HINT =
  'Discord rejected the requested intents: the bot needs the PRIVILEGED "Message Content Intent". '
  + 'Fix it in the Discord Developer Portal -> your application -> Bot -> Privileged Gateway Intents '
  + '-> enable "Message Content Intent" -> Save. Without it, message text arrives empty and tasks cannot be read.';

const NETWORK_HINT =
  'This looks like a network/proxy problem reaching discord.com. Node ignores the Windows system proxy, '
  + 'so if Clash/V2Ray runs in system-proxy mode set DISCORD_PROXY in .env (e.g. DISCORD_PROXY=http://127.0.0.1:7897). '
  + 'Use DISCORD_PROXY=off to force a direct connection.';

const TOKEN_HINT =
  'Check DISCORD_TOKEN in .env: the token may have been reset in the Developer Portal. '
  + 'Run `npm run doctor:discord` for a full diagnosis.';

/** @returns {string} a hint sentence to append to the raw error. */
export function explainDiscordLoginError(message) {
  const m = String(message ?? '');
  if (/disallowed intents/i.test(m)) return INTENT_HINT;
  if (/timeout|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|network|connect|socket hang up/i.test(m)) return NETWORK_HINT;
  if (/401|unauthorized|invalid token|tokeninvalid|an invalid token/i.test(m)) return TOKEN_HINT;
  return 'Run `npm run doctor:discord` for a full diagnosis.';
}

/** True when the failure is specifically a disabled privileged intent. */
export function isIntentError(message) {
  return /disallowed intents/i.test(String(message ?? ''));
}

/**
 * P0 uptime: true when the failure looks like a network/proxy problem rather
 * than an auth/config problem. Only network failures may trigger the
 * stale-proxy direct fallback; a bad token must never be retried as "direct".
 */
export function isNetworkError(message) {
  return /timeout|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|network|connect|socket hang up|fetch failed|getaddrinfo|proxy|tunnel/i.test(String(message ?? ''));
}
