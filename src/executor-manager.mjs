import { spawn } from 'node:child_process';
import { buildSpawnPlan, ClaudeRunner } from './claude-runner.mjs';
import { stripPaidCredentials } from './backend.mjs';
import { PROTOCOL, TRANSPORT, openCodeGoTransport } from './provider-manager.mjs';
import { EVENT_KIND } from './event-presenter.mjs';
import { CompatGateway } from './compat-gateway.mjs';
import { ADAPTER, ADAPTER_LABEL } from './protocol-adapters/anthropic-to-openai-chat.mjs';

const SAFE_ENV = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'USERPROFILE', 'HOME',
  'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'TEMP', 'TMP',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'APPROVAL_HOST', 'APPROVAL_PORT',
  'CLAUDE_CONFIG_DIR', 'LANG', 'LANGUAGE',
];

function isolatedBase(env, bridgeEnv) {
  const result = {};
  for (const name of SAFE_ENV) if (env[name] !== undefined) result[name] = env[name];
  return { ...result, ...bridgeEnv };
}

function defaultVersionProbe(command) {
  return new Promise((resolve) => {
    let plan;
    try { plan = buildSpawnPlan(command, ['--version']); } catch { resolve(null); return; }
    const child = spawn(plan.file, plan.args, {
      shell: plan.shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: isolatedBase(process.env, {}),
    });
    let output = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* done */ } resolve(null); }, 5000);
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? output.trim().split(/\r?\n/)[0] || 'installed' : null);
    });
  });
}

export function normalizeExecutorEvent(event) {
  if (!event || event.kind) return event;
  if (event.type === 'tool') {
    const name = event.tool?.name || '';
    const command = event.tool?.input?.command || '';
    let kind = EVENT_KIND.ANALYZE;
    if (/^(Glob|Grep|WebSearch)$/.test(name)) kind = EVENT_KIND.SEARCH;
    else if (/^(Read|NotebookRead)$/.test(name)) kind = EVENT_KIND.READ;
    else if (name === 'Write') kind = EVENT_KIND.WRITE;
    else if (/^(Edit|NotebookEdit)$/.test(name)) kind = EVENT_KIND.EDIT;
    else if (/^(WebFetch)$/.test(name) || /\b(curl|wget|Invoke-WebRequest|iwr)\b/i.test(command)) kind = EVENT_KIND.NETWORK;
    else if (/\b(npm|pnpm|yarn)\s+(test|run\s+(test|lint|check|build))\b/i.test(command)) kind = EVENT_KIND.TEST;
    else if (/^\s*git\b/i.test(command)) kind = EVENT_KIND.GIT;
    else if (/^(Bash|Shell|PowerShell)$/.test(name)) kind = EVENT_KIND.SHELL;
    return { ...event, kind };
  }
  if (event.type === 'retry') return { ...event, kind: EVENT_KIND.NETWORK };
  return { ...event, kind: EVENT_KIND.ANALYZE };
}

export class ExecutorManager {
  constructor({
    workbuddyCommand, workbuddyEnv = process.env, bridgeEnv = {}, env = process.env,
    probeVersion = defaultVersionProbe, RunnerClass = ClaudeRunner,
  }) {
    this.env = env;
    this.workbuddyEnv = { ...workbuddyEnv };
    this.bridgeEnv = bridgeEnv;
    this.probeVersion = probeVersion;
    this.RunnerClass = RunnerClass;
    this.executors = new Map([
      ['workbuddy', {
        id: 'workbuddy', displayName: 'WorkBuddy', command: workbuddyCommand,
        capabilities: ['stream-json', 'tools', 'permission-hook', 'sessions', 'model-override'],
        supportedProtocols: [PROTOCOL.WORKBUDDY], supportedTransports: [],
        adapterReady: true, normalizeEvent: normalizeExecutorEvent,
      }],
      ['claude', {
        id: 'claude', displayName: 'Claude Code', command: 'claude',
        capabilities: ['stream-json', 'tools', 'permission-hook', 'sessions', 'model-override'],
        supportedProtocols: [PROTOCOL.ANTHROPIC],
        // Claude Code speaks the Anthropic Messages wire format. Through OpenCode
        // Go that means the anthropic-messages model families (minimax-*, qwen*).
        supportedTransports: [TRANSPORT.ANTHROPIC_MESSAGES],
        // For other transports (openai-chat today) the bridge runs a local
        // protocol adapter, so Claude Code still sees a Messages endpoint.
        adapterTransports: [TRANSPORT.OPENAI_CHAT],
        adapterReady: true, normalizeEvent: normalizeExecutorEvent,
      }],
      ['opencode', {
        id: 'opencode', displayName: 'OpenCode', command: 'opencode', capabilities: [],
        supportedProtocols: [PROTOCOL.OPENAI, PROTOCOL.ANTHROPIC],
        supportedTransports: [TRANSPORT.ANTHROPIC_MESSAGES, TRANSPORT.OPENAI_CHAT, TRANSPORT.OPENAI_RESPONSES],
        adapterReady: false,
      }],
      ['codex', {
        id: 'codex', displayName: 'Codex', command: 'codex', capabilities: [],
        supportedProtocols: [PROTOCOL.OPENAI], supportedTransports: [TRANSPORT.OPENAI_RESPONSES],
        adapterReady: false,
      }],
    ]);
  }

  async discover() {
    await Promise.all([...this.executors.values()].map(async (executor) => {
      executor.version = executor.command ? await this.probeVersion(executor.command) : null;
      executor.available = Boolean(executor.version);
      executor.status = !executor.available ? 'NOT_INSTALLED' : executor.adapterReady ? 'PASS' : 'ADAPTER_NOT_READY';
    }));
    return this.list();
  }

  list() { return [...this.executors.values()]; }

  get(id) { return this.executors.get(id) ?? null; }

  /**
   * The local protocol adapter needed to reach a transport, or null for a direct
   * route. Only the Anthropic -> OpenAI Chat adapter exists today; the Responses
   * path is an explicit extension point, not a silent guess.
   */
  adapterFor(protocol, transport) {
    if (protocol === PROTOCOL.OPENCODE_GO && transport === TRANSPORT.OPENAI_CHAT) return ADAPTER.ANTHROPIC_TO_OPENAI_CHAT;
    return null;
  }

  adapterLabel(protocol, transport) {
    const adapter = this.adapterFor(protocol, transport);
    return adapter ? ADAPTER_LABEL[adapter] : null;
  }

  /**
   * Whether an Executor can run a Provider/model pair.
   *
   * Most Providers have a single protocol, so the Executor's `supportedProtocols`
   * decides. OpenCode Go is different: the Provider is a gateway whose models are
   * served over three different wire protocols, so compatibility is decided by the
   * model's `transport`: either natively, or through a local protocol adapter.
   * Passing no transport asks the weaker question "does this Executor support any
   * OpenCode Go model at all?" (used to allow `!provider`).
   */
  compatible(executorId, protocol, transport = null) {
    const executor = this.get(executorId);
    if (!executor?.available || !executor.adapterReady) return false;
    if (protocol === PROTOCOL.OPENCODE_GO) {
      const supported = executor.supportedTransports ?? [];
      if (!transport) return supported.length > 0 || Boolean(this.adapterFor(protocol, TRANSPORT.OPENAI_CHAT) && executor.adapterTransports?.length);
      if (supported.includes(transport)) return true;
      return Boolean(this.adapterFor(protocol, transport) && (executor.adapterTransports ?? []).includes(transport));
    }
    return executor.supportedProtocols.includes(protocol);
  }

  compatibleExecutors(protocol, transport = null) {
    return this.list().filter((executor) => this.compatible(executor.id, protocol, transport));
  }

  /** The wire protocol a given Provider/model pair is served over. */
  resolveTransport(provider, model) {
    if (!provider) return null;
    if (provider.protocol === PROTOCOL.OPENCODE_GO) return openCodeGoTransport(model);
    if (provider.protocol === PROTOCOL.ANTHROPIC) return TRANSPORT.ANTHROPIC_MESSAGES;
    if (provider.protocol === PROTOCOL.OPENAI) return TRANSPORT.OPENAI_CHAT;
    if (provider.protocol === PROTOCOL.WORKBUDDY) return 'workbuddy';
    return TRANSPORT.UNKNOWN;
  }

  buildEnvironment(executorId, provider, credential, model, transport = null, adapter = null) {
    if (executorId === 'workbuddy') {
      const env = isolatedBase(this.workbuddyEnv, this.bridgeEnv);
      for (const [name, value] of Object.entries(this.workbuddyEnv)) {
        if (/^(?:CODEBUDDY|WORKBUDDY)_/.test(name)) env[name] = value;
      }
      const envUnset = stripPaidCredentials(env);
      return { env, envUnset };
    }
    const env = isolatedBase(this.env, this.bridgeEnv);
    const wire = transport ?? this.resolveTransport(provider, model);
    if (provider.protocol === PROTOCOL.ANTHROPIC) {
      env.ANTHROPIC_BASE_URL = provider.baseUrl;
      env.ANTHROPIC_API_KEY = credential;
      env.ANTHROPIC_AUTH_TOKEN = credential;
      if (model) env.ANTHROPIC_MODEL = model;
    } else if (provider.protocol === PROTOCOL.OPENCODE_GO && wire === TRANSPORT.ANTHROPIC_MESSAGES) {
      // OpenCode Go authenticates the Anthropic Messages route with the x-api-key
      // header. Claude Code only sends that header for ANTHROPIC_API_KEY; setting
      // ANTHROPIC_AUTH_TOKEN makes it send `Authorization: Bearer`, which the
      // gateway rejects with 401. So the token variable is deliberately not set.
      env.ANTHROPIC_BASE_URL = provider.baseUrl;
      env.ANTHROPIC_API_KEY = credential;
      if (model) env.ANTHROPIC_MODEL = model;
    } else if (provider.protocol === PROTOCOL.OPENCODE_GO && wire === TRANSPORT.OPENAI_CHAT && adapter) {
      // Claude Code points at the local adapter and never sees the real key: the
      // child gets a random per-gateway token instead.
      env.ANTHROPIC_BASE_URL = adapter.baseUrl;
      env.ANTHROPIC_API_KEY = adapter.apiKey;
      if (model) env.ANTHROPIC_MODEL = model;
    } else if (provider.protocol === PROTOCOL.OPENAI) {
      env.OPENAI_BASE_URL = provider.baseUrl;
      env.OPENAI_API_KEY = credential;
      if (model) env.OPENAI_MODEL = model;
    }
    return { env, envUnset: [] };
  }

  async createRunner({ executorId, provider, credential, model, ...options }) {
    const executor = this.get(executorId);
    if (!executor?.available) throw Object.assign(new Error('executor is not installed'), { code: 'EXECUTOR_NOT_INSTALLED' });
    if (!executor.adapterReady) throw Object.assign(new Error('executor adapter is not ready'), { code: 'ADAPTER_NOT_READY' });
    const transport = this.resolveTransport(provider, model);
    if (!this.compatible(executorId, provider.protocol, transport)) {
      throw Object.assign(new Error('executor does not support this model transport'), { code: 'INCOMPATIBLE' });
    }

    const adapterId = this.adapterFor(provider.protocol, transport);
    if (adapterId === ADAPTER.ANTHROPIC_TO_OPENAI_CHAT) {
      const gateway = new CompatGateway({ provider, credential, model, transport });
      await gateway.start();
      const { env, envUnset } = this.buildEnvironment(executorId, provider, credential, model, transport, {
        baseUrl: gateway.url, apiKey: gateway.token,
      });
      const runner = new this.RunnerClass({
        ...options,
        command: executor.command,
        model,
        extraEnv: env,
        envUnset,
        inheritEnv: false,
        onDispose: () => gateway.close(),
      });
      runner.adapter = adapterId;
      runner.adapterLabel = ADAPTER_LABEL[adapterId];
      runner.gateway = gateway;
      return runner;
    }

    const { env, envUnset } = this.buildEnvironment(executorId, provider, credential, model, transport);
    return new this.RunnerClass({
      ...options,
      command: executor.command,
      model,
      extraEnv: env,
      envUnset,
      inheritEnv: false,
    });
  }
}
