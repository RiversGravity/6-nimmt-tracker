# 6 Nimmt Tracker – AI Guide

## Single userscript layout
- `6-nimmt-script.user.js` is the only source; the top-level IIFE is organized into blocks (constants/build stamp, state stores, data ingestion, UI, solver, observers). Keep helpers beside the block they support.
- `findGameDataObject()` is the canonical entry for BoardGameArena snapshots; feed new flows through `buildCanonicalState()` instead of querying `g_game`/`gameui` directly.
- `refreshStateAndMetrics()` is the shared heartbeat: bootstrap, observers, and manual hooks all call it to rebuild state, recompute metrics, and redraw the UI.

## State & persistence
- Card knowledge moves monotonically via `setCardState()` (`unknown → my_hand → played`) over `cardState`, `playedSet`, `prevHand`, and `roundRevealCounts`.
- Round artifacts live in `sessionStorage` (`SS_PLAYED`, `SS_ROUND_SIG`, `SS_NEW_ROUND_FLAG`); layout and solver preferences use `localStorage` (`LS_UI_STATE`). Stick to helpers like `savePlayedToSession()` and `saveUIState()`.
- `liveRowsByBga` mirrors the four board rows; attach metadata with `attachMetaToLiveRows()` so placement logic and solver runs share ordered player info.

## Data capture & replay
- Normalize player data through `collectPlayerMetadataFromGD()` + `syncTableMeta()` to keep live and replay modes identical.
- Table rows come from `captureRowsWithBgaMapFromGD()` / `seedLiveRowsFromGD()`. When row heuristics change, update `applyLogToLiveRows()` and `replayExistingLogForCurrentRound()` as well.
- `applyLogLine()` is the single mutator for `liveRowsByBga`; extend its regex handling carefully and call `noteCardRevealFromName()` whenever logs surface hidden cards.

## UI, solver, and metrics
- The panel mounts once in `createTrackerUI()`. Refresh routines (`updateCardsUI()`, `renderUndercutList()`) assume `buildCanonicalState()` output; avoid ad-hoc DOM reads.
- `ensureSolverCoordinator()` configures the inline worker built by `buildSolverWorkerSource()`. Keep mirrored helpers (`findRowForCard`, `resolvePlacement`, RNG) identical between main thread and worker.
- Solver pacing relies on deterministic seeds plus `flushProgress()` / `recordDelta()` checkpoints; preserve those when altering ISMCTS loops or `recommendedCards` updates.

## Bootstrap & observers
- `createAndMount()` seeds UI, polls for the log container (≤240 tries), and decides restore vs reset via `SS_NEW_ROUND_FLAG` + `getRoundSignature()`.
- Live updates run through `observeLogContainer()` → `applyLogLine()` → `savePlayedToSession()` → `refreshStateAndMetrics()`; keep this order intact for synchronization.
- Round resets trigger `resetRoundRevealCounts()` and `clearRoundStorage()`. Mirror any new heuristics across live bootstrap and replay recovery paths.

## Development workflow
- Bump both the userscript metadata `@version` and the `BUILD_STAMP` constant for user-visible changes so Tampermonkey clients update.
- Local testing: import the `.user.js` into Tampermonkey (Utilities → Import from file), join a 6 Nimmt table, and watch the console—there is no automated test harness.
- Handy console hooks: `refreshStateAndMetrics()` for a full resync, `hardResetForNewRound()` for clean bootstraps, and `renderUndercutList()` / `updateCardsUI()` to validate UI tweaks on demand.
