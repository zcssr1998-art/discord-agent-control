# AI handoff

## Branch

`openclaw-native-bootstrap`

## Active task

`docs/tasks/OPENCLAW_NATIVE_BOOTSTRAP.md`

Execute the installation-only OpenClaw bootstrap on the real Windows machine and verify it. Do not
re-plan the migration.

## Do not redo

- The self-built Jarvis is already preserved on
  `archive/self-built-jarvis-pre-openclaw-20260918`.
- OpenClaw is pinned to upstream `v2026.9.4` in `openclaw/version.json`.
- Repository-owned install, verify, and explicit onboarding wrappers already exist.

## Exact next step

On the real Jarvis Windows machine:

```powershell
git fetch origin
git checkout openclaw-native-bootstrap
git pull --ff-only
npm run openclaw:install
npm run openclaw:verify
npm test
npm run check
```

Do not run `npm run openclaw:onboard` in this task.

## Blocker

None known. Real-machine installation and runtime verification are still pending.
