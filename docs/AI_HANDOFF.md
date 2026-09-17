# AI handoff

## Branch

`jarvis-v4-p2-2-hardening`

## Active task

`docs/JARVIS_V4_P2_2_6_SAFE_SELF_UPDATE_TASK.md`

## Current status

P2.2.5 implementation/tests are complete, but owner real-Discord validation found a runtime-deployment mismatch: repository source says `/work task max_length=6000`, while the live Jarvis/Discord command schema still showed 1500 because the running Bridge had not been restarted/redeployed.

This is now treated as a product/runtime freshness problem, not another one-off max-length patch.

P2.2.6 must add safe self-update/deploy semantics using the existing Task Scheduler -> Supervisor -> Bridge ownership chain. No in-process hot module swapping.

## Required behavior

- configured trusted remote/branch, production target `origin/main` after P2 release;
- periodic fetch/check, observable local vs remote SHA;
- active Work => UPDATE_PENDING, never kill Work for deploy;
- safe idle boundary => verified fast-forward deploy;
- dirty/diverged checkout => BLOCKED, no auto stash/reset/merge/rebase;
- candidate verification and last-known-good rollback/quarantine;
- exactly one Bridge after restart;
- Discord command registration must be fetched back and normalized/verified, including `/work task max_length=6000`;
- `/update status|now|pause|resume` or equivalent owner-only controls;
- one controlled real Windows bootstrap restart so future updates can become automatic.

## Preserve

- Supervisor/LiteLLM/Task Scheduler recovery and one bridge instance;
- Chat AUTO/manual selection and model persistence;
- pagination/ACK/help consistency;
- FULL persistent owner semantics;
- unlimited default Work duration;
- monotonic Work lifecycle, truthful insert accounting, one-shot Stop and stale-control safety;
- P2.2.5 full result delivery, auto-compact, visible cooldown, non-blocking failure diagnostics, no hidden 1500-style policy caps;
- AUTO billing safeguards, manual-pin semantics, secret/credential protection.

## External limitation

WorkBuddy gateway may still return `HTTP 403 request illegal`; keep documented as external if unchanged. It must not block other providers, updater state or Bridge availability.

## Do not do

- do not execute the deferred release merge in this job;
- do not start P3;
- do not rerun the long Hunyuan3D reproduction;
- do not kill an active Work to deploy an update;
- do not add another independent daemon if the existing Supervisor can own the lifecycle with less complexity.

## Next

Execute `docs/JARVIS_V4_P2_2_6_SAFE_SELF_UPDATE_TASK.md`. When it passes, restore the active pointer to `docs/JARVIS_V4_P2_RELEASE_MERGE_TASK.md`, then stop.
