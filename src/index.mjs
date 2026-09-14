import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { ApprovalManager } from './approval-manager.mjs';
import { createHookServer, ensureHookSecret } from './hook-server.mjs';
import { StateStore } from './state.mjs';
import { DiscordControlPlane } from './discord-ui.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const config = loadConfig();
const state = new StateStore(path.join(root, 'data', 'state.json'));
const approvals = new ApprovalManager({ timeoutMs: config.approvalTimeoutMs });
const secret = ensureHookSecret();
const hookServer = createHookServer({ config, approvalManager: approvals, secret });

hookServer.listen(config.approvalPort, config.approvalHost, async () => {
  console.log(`[hook] listening at http://${config.approvalHost}:${config.approvalPort}/pre-tool-use`);
  const discord = new DiscordControlPlane({ config, state, approvalManager: approvals });
  await discord.start();
  console.log('[discord] control plane ready');
});
