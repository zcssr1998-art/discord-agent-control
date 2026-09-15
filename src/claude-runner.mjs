import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { killTree, registerChild, unregisterChild } from './kill-tree.mjs';

function userMessage(prompt) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n';
}

/**
 * Quote one argument for a cmd.exe command line.
 *
 * With `shell: true` Node joins the command and every argument with a single
 * space and quotes nothing, so an argument containing a space is silently split
 * into several arguments (a prompt of "Read the file x" arrives as `Read` plus
 * three extra argv entries). Implements the standard CommandLineToArgvW escaping
 * rules: backslashes are only special immediately before a quote.
 */
export function quoteWindowsArg(arg) {
  const s = String(arg);
  if (s !== '' && !/[\s"^&|<>()%!]/.test(s)) return s;

  let out = '"';
  let backslashes = 0;
  for (const ch of s) {
    if (ch === '\\') {
      backslashes += 1;
      out += ch;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(backslashes + 1) + '"';
      backslashes = 0;
      continue;
    }
    backslashes = 0;
    out += ch;
  }
  out += '\\'.repeat(backslashes) + '"';
  return out;
}

/**
 * Windows spawn is the fragile part of this bridge, so the rules are explicit:
 *
 *  - A Node script (`.mjs` / `.cjs` / `.js`) is launched with `process.execPath`
 *    and no shell. cmd.exe cannot execute `.mjs` reliably (no file association),
 *    so going through a shell is wrong even though it "exits 0".
 *  - Any other Windows command (bare `claude`, `claude.cmd`, a full path inside
 *    `C:\Program Files\...`) is launched through the shell, and BOTH the
 *    executable and every argument are quoted: with `shell: true` Node joins
 *    them with spaces without quoting, so a path containing a space is split and
 *    the child dies with "not recognized as an internal or external command",
 *    while an argument containing a space is silently split into several args.
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
    return { file: `"${trimmed}"`, args: baseArgs.map(quoteWindowsArg), shell: true };
  }
  return { file: trimmed, args: baseArgs, shell: false };
}

export class ClaudeRunner {
  constructor({
    command,
    cwd,
    sessionId = null,
    model = null,
    includePartialMessages = false,
    extraEnv = {},
    envUnset = [],
    inheritEnv = true,
    onEvent = () => {},
    onExit = () => {},
    onLog = null,
  }) {
    this.command = command;
    this.cwd = cwd;
    this.sessionId = sessionId;
    this.model = model;
    this.includePartialMessages = includePartialMessages;
    this.extraEnv = extraEnv;
    this.envUnset = envUnset;
    this.inheritEnv = inheritEnv;
    this.apiKeySource = null;
    this.restarts = 0;
    this.onEvent = onEvent;
    this.onExit = onExit;
    this.onLog = onLog;
    this.child = null;
    this.pending = [];
    this.current = null;
    this.lastError = null;
    // Liveness clock for the control-plane watchdog: any byte the agent sends
    // (stdout event or stderr line) refreshes it. A task that stops producing
    // events must be visible on the phone instead of looking frozen.
    this.lastEventAt = Date.now();
  }

  get busy() {
    return Boolean(this.current);
  }

  /** Milliseconds since the agent last produced any output. */
  get idleMs() {
    return Date.now() - this.lastEventAt;
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
    if (this.model) args.push('--model', this.model);
    if (this.sessionId) args.push('--resume', this.sessionId);
    return args;
  }

  start() {
    if (this.child && !this.child.killed && this.child.exitCode === null) return;
    const plan = buildSpawnPlan(this.command, this.buildArgs());

    // Build the child environment explicitly: merge the caller's additions, then
    // remove everything the caller asked to block. Blocking matters — with paid
    // fallback disabled the child must not even be able to see a metered API key.
    const env = { ...(this.inheritEnv ? process.env : {}), ...this.extraEnv, DISCORD_BRIDGE_ACTIVE: '1' };
    for (const name of this.envUnset) delete env[name];

    this.child = spawn(plan.file, plan.args, {
      cwd: this.cwd,
      env,
      shell: plan.shell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    registerChild(this.child.pid);
    this.lastEventAt = Date.now();

    // A child that dies while we are still writing to it makes the pipe emit
    // `error`. An EventEmitter 'error' with no listener *throws*, and an
    // uncaught throw takes the whole bridge down — Discord control plane
    // included. That is exactly the "bot went silent and !status stopped
    // answering" failure, so every stdio stream gets a listener that converts
    // the failure into an ordinary request rejection instead.
    this.#guardPipe(this.child.stdin, 'stdin', true);
    this.#guardPipe(this.child.stdout, 'stdout', true);
    this.#guardPipe(this.child.stderr, 'stderr', false);

    const rl = readline.createInterface({ input: this.child.stdout });
    // Defence in depth: this callback runs straight off the event loop, so an
    // exception here would be uncaught and would kill the bridge process.
    rl.on('line', (line) => {
      try { this.#handleLine(line); }
      catch (error) { this.#guardFailure('stdout', error, false); }
    });
    // readline forwards stream errors too; without this they would be unhandled.
    rl.on('error', (error) => this.#guardFailure('stdout', error));
    this.child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      this.lastEventAt = Date.now();
      this.#log({ stream: 'stderr', text });
      this.onEvent({ type: 'stderr', text });
    });
    this.child.on('error', (error) => {
      this.lastError = error;
      unregisterChild(this.child?.pid);
      this.child = null;
      this.#failCurrent(error);
    });
    this.child.on('exit', (code, signal) => {
      const child = this.child;
      unregisterChild(child?.pid);
      // Always settle an in-flight request. Previously only a non-zero exit did,
      // so a child that exited 0 without emitting a `result` event left send()
      // pending forever: the task stayed RUNNING, the channel stayed "busy", and
      // the only way out was a manual !stop.
      const reason = code === 0 && !signal
        ? Object.assign(new Error('agent process exited without producing a result'), { code: 'AGENT_EXIT_NO_RESULT' })
        : Object.assign(new Error(`Claude exited code=${code} signal=${signal || ''}`), { code: 'AGENT_EXIT' });
      if (code !== 0 || signal) this.lastError = reason;
      this.child = null;
      this.#failCurrent(reason);
      this.onExit({ code, signal });
    });
  }

  /**
   * Turn a stdio stream failure into a request rejection.
   *
   * `failCurrent` is true for the streams we write to or read results from: if
   * either is broken the in-flight request can never complete, so it must be
   * rejected rather than left hanging.
   */
  #guardPipe(stream, label, failCurrent) {
    if (!stream || typeof stream.on !== 'function') return;
    stream.on('error', (error) => this.#guardFailure(label, error, failCurrent));
  }

  #guardFailure(label, error, failCurrent = false) {
    this.lastError = error;
    this.#log({ stream: 'bridge', text: `${label} stream error: ${error?.message || error}` });
    if (failCurrent) this.#failCurrent(error);
  }

  async send(prompt) {
    this.start();
    if (!this.child?.stdin) {
      throw new Error('agent process is not running; cannot send a task');
    }
    if (this.current) {
      return await new Promise((resolve, reject) => this.pending.push({ prompt, resolve, reject }));
    }
    return await this.#sendNow(prompt);
  }

  #sendNow(prompt) {
    return new Promise((resolve, reject) => {
      this.current = { resolve, reject, textParts: [], tools: [], started: Date.now() };
      this.lastEventAt = Date.now();
      try {
        this.child.stdin.write(userMessage(prompt));
      } catch (error) {
        // A synchronous write failure (destroyed stream) must reject this
        // request and move on, never leave it pending forever.
        const current = this.current;
        this.current = null;
        current.reject(error);
        this.#drain();
      }
    });
  }

  #log(entry) {
    if (!this.onLog) return;
    try { this.onLog(entry); } catch { /* logging must never break the run */ }
  }

  #handleLine(line) {
    this.lastEventAt = Date.now();
    this.#log({ stream: 'stdout', text: line });
    let event;
    try { event = JSON.parse(line); }
    catch { this.onEvent({ type: 'raw', text: line }); return; }

    // Claude Code emits one `system/thinking_tokens` event per thinking token
    // (measured: 2451 of 2505 stdout lines in a single 90s task, even with
    // --include-partial-messages off). It carries no information the bridge can
    // act on, so it is recorded in the run log but never dispatched.
    if (event.type === 'system' && event.subtype === 'thinking_tokens') return;

    // Claude Code retries API failures up to 10 times with exponential backoff,
    // which is several minutes of apparent silence. Surface it or the phone just
    // shows an unchanging status and the run looks hung.
    if (event.type === 'system' && event.subtype === 'api_retry') {
      this.onEvent({
        type: 'retry',
        attempt: event.attempt,
        maxRetries: event.max_retries,
        errorStatus: event.error_status,
        error: event.error,
      });
      return;
    }

    if (event.type === 'system' && event.subtype === 'init') {
      if (event.session_id) {
        this.sessionId = event.session_id;
        this.onEvent({ type: 'session', sessionId: this.sessionId });
      }
      if (event.model) {
        this.model = event.model;
        this.onEvent({ type: 'model', model: event.model });
      }
      // Which credential actually served the request. The WorkBuddy CLI reports
      // its own gateway here, which is how the bridge proves it is on the free
      // backend rather than a paid API.
      this.apiKeySource = event.apiKeySource ?? null;
      this.onEvent({ type: 'init', model: this.model, apiKeySource: this.apiKeySource, tools: event.tools ?? [], cwd: event.cwd ?? this.cwd });
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

    if (event.type === 'user' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block.type === 'tool_result') {
          const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
          this.onEvent({ type: 'tool-result', text });
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
    if (!this.child?.stdin) {
      // The agent died while requests were queued: fail them instead of
      // leaving the queue (and the busy flag) stuck.
      next.reject(Object.assign(new Error('agent process is not running'), { code: 'AGENT_EXIT' }));
      this.#drain();
      return;
    }
    this.#sendNow(next.prompt).then(next.resolve, next.reject);
  }

  /**
   * Kill the whole agent tree and release everything waiting on it.
   *
   * Releasing is the important half: `!stop` used to kill the process but leave
   * the in-flight request (and therefore the "busy" task) hanging until the task
   * wall-clock timeout fired. Every caller of `send()` is now settled with a
   * `TASK_CANCELLED` error, so the task's `finally` block always runs and the
   * channel is immediately usable again.
   */
  async stop({ reason = 'stopped by owner' } = {}) {
    const child = this.child;
    this.child = null;
    const cancelled = Object.assign(new Error(reason), { code: 'TASK_CANCELLED' });
    this.#failCurrent(cancelled);
    if (!child || !child.pid) return { killed: false, pid: null };
    unregisterChild(child.pid);
    const killed = await killTree(child.pid);
    return { killed, pid: child.pid };
  }
}
