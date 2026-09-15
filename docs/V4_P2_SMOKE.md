# Jarvis V4 P2 smoke evidence

Status: **PENDING IMPLEMENTATION**

This file is evidence, not a planning document. Update only with commands/results that actually ran.

## 1. Baseline

```text
main/P1 baseline:
npm test      195 passed / 0 failed
npm run check 76 files / 0 failed
npm run smoke:p1 20/20
```

## 2. P2A control panel

Pending.

Record at minimum:

- persistent `!panel`
- old panel buttons after bridge restart
- New Work modal -> guild Work thread / DM inline
- Chat model AUTO/manual selector
- Work Provider -> model selector
- Settings / Permission / Status / Stop / Usage Guide

## 3. P2B Chat history

Pending.

Record persistence across restart, multi-turn context, bounded replay, and fallback-no-duplication evidence.

## 4. P2C New / Compact

Pending.

Record New Chat context reset and Compact before/after context size with continuity retained.

## 5. P2D attachments

Pending.

Record:

- Chat text attachment
- Chat image attachment / `PENDING_REAL_VISION_SMOKE` if no real image-capable route exists
- Work attachment downloaded once and read by real Agent
- path/size safety regression tests

## 6. Final regression

Pending.

```text
npm test
npm run check
```

Do not mark PASS without real output.
