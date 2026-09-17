# Jarvis Chat timeout fix

## Objective

Remove Jarvis's default client-side wall-clock timeout for normal Chat requests so slow but valid model responses are not killed at 25s/120s.

Default policy after this task:

- `CHAT_TIMEOUT_MS=0`
- `0` means no Jarvis client-side Chat timeout.
- A positive integer remains an explicit operator-configured timeout in milliseconds.
- Provider/network/HTTP failures must still surface normally.
- Manual provider/model pins must keep their existing no-silent-fallback semantics.

## Confirmed current problem

`src/config.mjs` currently defaults `CHAT_TIMEOUT_MS` to `120000`, while `.env.example` still documents `25000`. `src/chat-runtime.mjs` already supports `0` by omitting `AbortSignal.timeout()`, so this is a focused configuration/default/test fix, not a timeout-system redesign.

Observed runtime symptom: a manually pinned OpenCode Go Grok 4.6 Chat request is aborted by Jarvis at roughly 120 seconds with `chat provider timed out`.

## Scope

Implement the smallest reversible fix only.

### 1. `src/config.mjs`

Change the default from:

```js
chatTimeoutMs: int('CHAT_TIMEOUT_MS', 120000)
```

to:

```js
chatTimeoutMs: int('CHAT_TIMEOUT_MS', 0)
```

Update the nearby comment so it states that no client-side Chat timeout is applied by default and positive values are explicit operator overrides.

### 2. `.env.example`

Change:

```env
CHAT_TIMEOUT_MS=25000
```

to:

```env
CHAT_TIMEOUT_MS=0
```

Document concisely:

- `0` = unlimited / no Jarvis client-side timeout
- positive value = explicit operator timeout in milliseconds

### 3. `tests/config.test.mjs`

Update the default assertion to require:

```js
chatTimeoutMs === 0
```

Keep or add coverage proving an explicit positive override such as `CHAT_TIMEOUT_MS=60000` still parses to `60000`.

### 4. `tests/chat-runtime.test.mjs`

Add the minimum deterministic test proving that when `timeoutMs=0`, ChatRuntime does not pass a client-side AbortSignal timeout into `fetch`.

Do not remove positive-timeout capability.

### 5. Actual local runtime configuration

On the real Jarvis Windows machine, inspect the effective `.env` / environment value for `CHAT_TIMEOUT_MS`.

If it is any positive value such as `120000` or `25000`, change only that setting to:

```env
CHAT_TIMEOUT_MS=0
```

Do not print, commit, log, or echo any API key, token, Discord credential, cookie, or other secret. `.env` must remain uncommitted.

## Non-goals / do not change

Do not modify:

- Grok 4.6 routing
- OpenCode Go provider behavior
- AUTO fallback policy
- Chat/Work mode routing
- model discovery/listing
- manual provider/model pin semantics
- unrelated code or architecture

Do not replace the timeout with another arbitrary default such as 5 or 10 minutes.

## Verification

Run real checks:

```text
npm test
npm run check
```

Also ensure the relevant config and chat-runtime tests execute and pass.

Acceptance evidence must establish:

1. Default `loadConfig().chatTimeoutMs === 0`.
2. Explicit positive override still works, e.g. `CHAT_TIMEOUT_MS=60000` -> `60000`.
3. `timeoutMs=0` causes no Jarvis client-side AbortSignal timeout to be supplied to the request.
4. Existing manual provider/model pin test still passes: a pinned model failure does not silently switch models/providers.
5. Existing OpenCode Go auth/transport tests still pass.
6. No unrelated files are changed except task/state docs needed for this task.

## Runtime smoke

After code/tests pass:

1. Restart the actual Jarvis runtime so the local config is reloaded.
2. Confirm Jarvis comes online normally.
3. Start a Chat request with a manually selected model.
4. Confirm the old Jarvis-local 25s/120s timer no longer aborts the request.
5. If the upstream provider itself returns timeout/unavailable, report it distinctly as an upstream/provider failure, not a Jarvis client timeout.

## Completion

Commit and push the verified fix.

Final worker report only:

```text
PASS | FAIL
commit: <sha or none>
tests: <compact result>
runtime: <Jarvis restart + Chat smoke result>
blocker: <none or key blocker>
```
