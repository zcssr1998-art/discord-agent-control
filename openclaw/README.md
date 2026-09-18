# Native OpenClaw bootstrap

This directory records the upstream OpenClaw release used by Jarvis.

## Current policy

- OpenClaw is installed as the **official upstream product**, not vendored or forked here.
- The self-built Jarvis remains untouched and recoverable.
- This phase does **not** migrate Discord, model providers, permissions, prompts, memory, or other Jarvis customizations.
- OpenClaw core must not be modified for this bootstrap.
- Secrets and tokens must never be committed.

Pinned release metadata lives in `version.json`.

## Windows commands

From the repository root:

```powershell
npm run openclaw:install
npm run openclaw:verify
```

When installation is verified and you intentionally want to configure the native product:

```powershell
npm run openclaw:onboard
```

After onboarding:

```powershell
npm run openclaw:status
npm run openclaw:dashboard
```

The install wrapper downloads the official OpenClaw Windows installer and passes the pinned
version from `version.json`. It skips onboarding by default so installation cannot silently
take over the existing Discord Jarvis.
