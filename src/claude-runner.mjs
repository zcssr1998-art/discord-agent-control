import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';

function userMessage(prompt) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n';
}

/**
 * Windows spawn is the fragile part of this bridge, so the rules are explicit:
 *
 *  - A Node script (`.mjs` / `.cjs` / `.js`) is launched with `process.execPath`
 *    and no shell. cmd.exe cannot execute `.mjs` reliably (no file association),
 *    so going through a shell is wrong even though it "exits 0".
 *  - Any other Windows command (bare `claude`, `claude.cmd`, a full path inside
 *    `C:\Program Files\...`) is launched through the shell but the executable
 *    itself MUST be quoted: with `shell: true` Node joins the command and args
 *    with spaces without quoting, so a path containing a space is split and the
 *    child dies with "not recognized as an internal or external command".
 *  - POSIX spawns directly.
 *
 * Exported so the behaviour can be asserted in tests instead of assumed.
 */
export function buildSpawnPlan(command, baseArgs, { platform = process.platform, execPath = process.execPath } = {}) {
  const trimmed = String(command ?? '').trim().replace(/^"(.*)"$/s, '$1');
  if (!trimmed) throw new Error('claude command is empty');

  if (/\.(mjs|cjs|js)$/i.test(trimmed)) {
    return { file: execPath, args: [path.resolve(trimmed), ...baseArgs], shell: false };
  }
  if (platform === 'win32') {
    return { file: `"${trimmed}"`, args: baseArgs, shell: true };
  }
  return { file: trimmed, args: baseArgs, shell: false };
}

export class ClaudeRunner {
  constructor({
    command,
    cwd,
    sessionId = null,
    includePartialMessages = false,
    extraEnv = {},
    onEvent = () => {},
    onExit = () => {},
    onLog = null,
  }) {
    this.command = command;
    this.cwd = cwd;
    this.sessionId = sessionId;
    this.includePartialMessages = includePartialMessages;
    this.extraEnv = extraEnv;
    this.onEvent = onEvent;
    this.onExit = onExit;
    this.onLog = onLog;
    this.child = null;
    this.pending = [];
    this.current = null;
    this.model = null;
    this.lastError = null;
  }

  get busy() {
    return Boolean(this.current);
  }

  buildArgs() {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ];
    // Partial-message events are mostly `thinking_tokens` noise; the bridge only
    // needs complete assistant turns plus the final result, so this is opt-in.
    if (this.includePartialMessages) args.push('--include-partial-messages');
    if (this.sessionId) args.push('--resume', this.sessionId);
    return args;
  }

  start() {
    if (this.child && !this.child.killed && this.child.exitCode === null) return;
    const plan = buildSpawnPlan(this.command, this.buildArgs());

    this.child = spawn(plan.file, plan.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.extraEnv, DISCORD_BRIDGE_ACTIVE: '1' },
      shell: plan.shell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on('line', (line) => this.#handleLine(line));
    this.child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      this.#log({ stream: 'stderr', text });
      this.onEvent({ type: 'stderr', text });
    });
    this.child.on('error', (error) => {
      this.lastError = error;
      this.#failCurrent(error);
    });
    this.child.on('exit', (code, signal) => {
      const err = code === 0 ? null : new Error(`Claude exited code=${code} signal=${signal || ''}`);
      if (err) this.lastError = err;
      if (err) this.#failCurrent(err);
      this.child = null;
      this.onExit({ code, signal });
    });
  }

  async send(prompt) {
    this.start();
    if (this.current) {
      return await new Promise((resolve, reject) => this.pending.push({ prompt, resolve, reject }));
    }
    return await this.#sendNow(prompt);
  }

  #sendNow(prompt) {
    return new Promise((resolve, reject) => {
      this.current = { resolve, reject, textParts: [], tools: [], started: Date.now() };
      this.child.stdin.write(userMessage(prompt));
    });
  }

  #log(entry) {
    if (!this.onLog) return;
    try { this.onLog(entry); } catch { /* logging must never break the run */ }
  }

  #handleLine(line) {
    this.#log({ stream: 'stdout', text: line });
    let event;
    try { event = JSON.parse(line); }
    catch { this.onEvent({ type: 'raw', text: line }); return; }

    if (event.type === 'system' && event.subtype === 'init') {
      if (event.session_id) {
        this.sessionId = event.session_id;
        this.onEvent({ type: 'session', sessionId: this.sessionId });
      }
      if (event.model) {
        this.model = event.model;
        this.onEvent({ type: 'model', model: event.model });
      }
    }

    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text) {
          this.current?.textParts.push(block.text);
          this.onEvent({ type: 'text', text: block.text });
        }
        if (block.type === 'tool_use') {
          const tool = { name: block.name, input: block.input || {}, id: block.id };
          this.current?.tools.push(tool);
          this.onEvent({ type: 'tool', tool });
        }
      }
    }

    if (event.type === 'result') {
      const current = this.current;
      this.current = null;
      const result = {
        text: event.result || current?.textParts.join('') || '',
        sessionId: event.session_id || this.sessionId,
        durationMs: Date.now() - (current?.started || Date.now()),
        tools: current?.tools || [],
        isError: Boolean(event.is_error),
        costUsd: event.total_cost_usd ?? null,
        raw: event,
      };
      if (result.sessionId) this.sessionId = result.sessionId;
      current?.resolve(result);
      this.#drain();
    }

    this.onEvent({ type: 'event', event });
  }

  #failCurrent(error) {
    if (this.current) {
      this.current.reject(error);
      this.current = null;
    }
    while (this.pending.length) this.pending.shift().reject(error);
  }

  #drain() {
    if (this.current || !this.pending.length) return;
    const next = this.pending.shift();
    this.#sendNow(next.prompt).then(next.resolve, next.reject);
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    if (process.platform === 'win32' && child.pid) {
      await new Promise((resolve) => {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        killer.on('exit', resolve);
        killer.on('error', resolve);
      });
    } else {
      child.kill('SIGTERM');
    }
  }
}
