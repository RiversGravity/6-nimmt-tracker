# 6 Nimmt Tracker – AI Guide

## Single-file architecture
- The tracker ships as a single Tampermonkey userscript (`6-nimmt-script.user.js`) that runs on BoardGameArena at `@run-at document-idle`.
- The top-level IIFE is segmented into constants, state stores, UI rendering, solver plumbing, BGA data capture, log replay, round detection, and bootstrap observers—keep helpers near the block they support.
- `findGameDataObject()` is the entry point for live/replay data; every flow derives from the canonical snapshot built in this file (no bundler or external modules).

## State & persistence
- Card knowledge flows through `cardState`, `playedSet`, `prevHand`, and `roundRevealCounts`; always promote states with `setCardState` (`unknown → my_hand → played`) to preserve monotonic guarantees.
- Session-level storage (`SS_PLAYED`, `SS_ROUND_SIG`, `SS_NEW_ROUND_FLAG`) tracks per-table rounds; UI layout/settings persist via `LS_UI_STATE`. Use `savePlayedToSession()`/`loadPlayedFromSession()` instead of touching storage directly.
- `buildCanonicalState()` is the shared truth for UI + solver; extend its payload rather than scraping the DOM ad hoc.

## Data ingestion & replay
- Normalize BGA structs through `collectPlayerMetadataFromGD()` and `syncTableMeta()`; avoid interrogating `g_game`/`gameui` elsewhere to keep replay and live modes consistent.
- Table state comes from `captureRowsWithBgaMapFromGD()` and `seedLiveRowsFromGD()`. If you tweak row detection, update the replay path in `applyLogToLiveRows()`/`replayExistingLogForCurrentRound()` too.
- `applyLogLine()` is the single mutator for `liveRowsByBga` based on textual logs—mirror its regex patterns and remember `noteCardRevealFromName()` whenever a card identity becomes public.

## UI & solver pipeline
- UI mounts once via `createTrackerUI()`, then `updateCardsUI()` and `renderUndercutList()` refresh visuals. New panels must save/restore state through `saveUIState()`/`loadUIState()`.
- Undercut/highlight logic hinges on `cardMetrics` and `recommendedCards`; feed any new scoring into that map instead of hand-building DOM.
- ISMCTS orchestration lives in `SolverCoordinator` + `runIsmctsRecommendation()` on the main thread and `buildSolverWorkerSource()` for the inline worker. Keep duplicated helpers (`findRowForCard`, `resolvePlacement`, `createRng`, etc.) identical across both copies.
- Worker pacing assumes deterministic seeds and periodic `flushProgress()`/`recordDelta()` calls; adjust iteration cadence without breaking those checkpoints.

## Bootstrap & observers
- `createAndMount()` builds the panel, spins a gentle heartbeat (`refreshStateAndMetrics()` every 800 ms), then polls for the BGA log container up to 240 tries.
- On discovery it checks `SS_NEW_ROUND_FLAG`/`getRoundSignature()` to decide whether to restore or reset storage, seeds `liveRowsByBga` from GD, replays the current round log, and finally attaches `observeLogContainer()`.
- The log observer mutations trigger `applyLogLine()` → `savePlayedToSession()` → `refreshStateAndMetrics()`; keep this chain intact so live updates stay synchronized.

## Development workflow
- Bump both the userscript `@version` metadata and the in-file `BUILD_STAMP` whenever shipping user-visible changes so Tampermonkey clients notice updates.
- Local testing: load the file into Tampermonkey (*Utilities → Import from file*), join a live table, and watch console output while iterating; there is no automated test harness.
- When debugging, prefer `console.log(buildCanonicalState(true))` to inspect full tracker state instead of sampling internal structures piecemeal.

## Handy console hooks
- `refreshStateAndMetrics()` re-runs the full sync (GD scan → heuristics → UI redraw) and is safe to spam during development.
- `hardResetForNewRound()` clears round storage and forces a clean bootstrap cycle; great for testing round transitions.
- `renderUndercutList()` and `updateCardsUI()` can be invoked manually after mutating prototype data if you need to validate UI without waiting for observers.
