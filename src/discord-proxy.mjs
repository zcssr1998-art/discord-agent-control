import { createRequire } from 'node:module';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { HttpsProxyAgent } from 'https-proxy-agent';

const require = createRequire(import.meta.url);

/**
 * Discord proxy support.
 *
 * Discord needs two different transports and they do NOT share a proxy setting:
 *
 *  1. REST (`discord.js` -> `@discordjs/rest` -> `undici.request`) honours the
 *     undici global dispatcher, so one `setGlobalDispatcher` covers it.
 *
 *  2. The Gateway WebSocket is a separate story. `@discordjs/ws` only uses the
 *     global `fetch`/`WebSocket` on Deno and Bun
 *     (`shouldUseGlobalFetchAndWebSocket()` returns false on Node), so on Node it
 *     always uses the `ws` package — which knows nothing about undici and has no
 *     proxy awareness of its own. `ws` does read `options.agent`, but
 *     `@discordjs/ws` does not forward an agent, so the constructor is wrapped.
 *
 * The `ws` wrapper is installed at module load time and the actual agent is
 * filled in later by `configureDiscordProxy()`. That ordering matters: ESM
 * evaluates `import './discord-proxy.mjs'` before `import 'discord.js'`, and
 * `@discordjs/ws` captures `require('ws').WebSocket` while its own module body
 * runs. Patching after discord.js has loaded would be too late.
 *
 * This matters in practice: on a machine where Clash/V2Ray runs in system-proxy
 * mode (no TUN adapter), every other app reaches Discord but Node does not,
 * because Node ignores the Windows system proxy entirely.
 */

let patchedClass = null;

function installWsPatch() {
  if (patchedClass) return patchedClass;
  const ws = require('ws');
  const Original = ws.WebSocket;
  if (Original.__dacProxyWrapper) {
    patchedClass = Original;
    return patchedClass;
  }
  class ProxiedWebSocket extends Original {
    constructor(address, protocols, options) {
      super(address, protocols, { ...(options ?? {}), agent: ProxiedWebSocket.proxyAgent });
    }
  }
  ProxiedWebSocket.__dacProxyWrapper = true;
  // `ws`'s module.exports IS the WebSocket class and `@discordjs/ws` reads the
  // `.WebSocket` self-reference, so assigning here is what takes effect.
  ws.WebSocket = ProxiedWebSocket;
  patchedClass = ProxiedWebSocket;
  return patchedClass;
}

// Patch immediately, with no agent yet. `agent: undefined` is exactly what `ws`
// does when no proxy is configured.
installWsPatch();

let active = null;

/**
 * Point both transports at `proxyUrl`.
 * Pass a falsy value (or 'off'/'direct') to disable.
 */
export function configureDiscordProxy(proxyUrl) {
  const wanted = String(proxyUrl ?? '').trim();
  if (!wanted || /^(off|none|direct|false|0)$/i.test(wanted)) return null;

  const restAgent = new ProxyAgent(wanted);
  setGlobalDispatcher(restAgent);
  installWsPatch().proxyAgent = new HttpsProxyAgent(wanted);
  active = { proxyUrl: wanted, restAgent };
  return active;
}

/** The agent to hand to `discord.js`'s `rest` option, if a proxy is active. */
export function discordRestAgent() {
  return active?.restAgent ?? null;
}

export function activeProxyUrl() {
  return active?.proxyUrl ?? null;
}
