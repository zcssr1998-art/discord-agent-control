# OpenClaw native bootstrap

## Objective

Install the current approved upstream OpenClaw release on the real Windows Jarvis machine while
preserving the existing self-built Jarvis unchanged and fully recoverable.

This is deliberately an **installation-only** phase. Treat OpenClaw like a new upstream software
package being installed beside the existing Jarvis.

## Approved upstream

- repository: `openclaw/openclaw`
- release: `v2026.9.4`
- source commit: `3a9d69db306cd7f081e06254cb89c4bcc14a7107`
- install path: official Windows PowerShell installer, npm method
- local pin: `openclaw/version.json`

Do not silently switch to a newer release during this task. A later update is a separate reviewed
change.

## Preservation requirement

The pre-OpenClaw self-built Jarvis is frozen on:

`archive/self-built-jarvis-pre-openclaw-20260918`

Do not delete, rewrite, disable, or migrate the existing Jarvis runtime in this task.

## Scope

1. Pull and use branch `openclaw-native-bootstrap`.
2. Run the repository-owned wrapper:
   `npm run openclaw:install`.
3. Run:
   `npm run openclaw:verify`.
4. Run the existing repository regression gates:
   `npm test` and `npm run check`.
5. Record only concise deterministic evidence in the task closeout/commit.

## Explicitly out of scope

Do **not**:

- run `npm run openclaw:onboard`;
- connect the current Discord bot/token to OpenClaw;
- start replacing the existing Jarvis Discord control plane;
- configure DS, Qwen, Grok, Claude, Codex, LiteLLM, or any model provider;
- import Jarvis memory, prompts, permissions, skills, or sessions;
- add Jarvis-specific OpenClaw plugins;
- modify OpenClaw core;
- stop or remove the existing Jarvis Supervisor / Task Scheduler chain;
- commit API keys, bot tokens, cookies, credentials, OpenClaw state, or generated secrets.

Those belong to later migration phases only after the native product itself is proven on this PC.

## Failure handling

- If the official installer fails, capture the failed command, exit code, and core error only.
- If PATH has not refreshed, start a fresh PowerShell process and re-run
  `npm run openclaw:verify`; do not reinstall blindly.
- If Node is unsupported, allow the official OpenClaw installer to provision the supported runtime.
- Do not repair unrelated Jarvis code to make this task pass.
- Do not retry destructive or credential-changing actions.

## Acceptance

PASS requires all of the following on the real Windows machine:

1. `npm run openclaw:install` exits 0.
2. `npm run openclaw:verify` prints `PASS`.
3. Reported OpenClaw version contains exactly `2026.9.4`.
4. `openclaw --help` is callable.
5. `npm test` passes.
6. `npm run check` passes.
7. Existing self-built Jarvis remains available and was not stopped/migrated.
8. No onboarding, Discord takeover, provider setup, or custom OpenClaw behavior was introduced.
9. No secrets were added to git.

After these gates pass, stop. Do not start the next migration phase.

## Worker closeout

```text
PASS | FAIL
commit: <sha or none>
tests: openclaw install/verify + npm test + npm run check
blocker: <none or one key blocker>
```
