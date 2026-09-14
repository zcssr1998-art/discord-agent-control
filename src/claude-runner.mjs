import { spawn } from 'node:child_process';
import readline from 'node:readline';

function userMessage(prompt) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n';
}

export class ClaudeRunner {
  constructor({ command, cwd, sessionId = null, onEvent = () => {}, onExit = () => {} }) {
    this.command = command;
    this.cwd = cwd;
    this.sessionId = sessionId;
    this.onEvent = onEvent;
    this.onExit = onExit;
    this.child = null;
    this.pending = [];
    this.current = null;
  }

  start() {
    if (this.child && !this.child.killed) return;
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--dangerously-skip-permissions',
    ];
    if (this.sessionId) args.push('--resume', this.sessionId);

    this.child = spawn(this.command, args, {
      cwd: this.cwd,
      env: { ...process.env, DISCORD_BRIDGE_ACTIVE: '1' },
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on('line', (line) => this.#handleLine(line));
    this.child.stderr.on('data', (chunk) => this.onEvent({ type: 'stderr', text: chunk.toString() }));
    this.child.on('error', (error) => this.#failCurrent(error));
    this.child.on('exit', (code, signal) => {
      const err = code === 0 ? null : new Error(`Claude exited code=${code} signal=${signal || ''}`);
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

  #handleLine(line) {
    let event;
    try { event = JSON.parse(line); }
    catch { this.onEvent({ type: 'raw', text: line }); return; }

    if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
      this.sessionId = event.session_id;
      this.onEvent({ type: 'session', sessionId: this.sessionId });
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
    if (process.platform === 'win32' && child.pid) {
      await new Promise((resolve) => {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        killer.on('exit', resolve);
        killer.on('error', resolve);
      });
    } else {
      child.kill('SIGTERM');
    }
    this.child = null;
  }
}
