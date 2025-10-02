# 6 Nimmt Tracker – AI Guide

## Architecture snapshot
- `6-nimmt-tracker.user.js` is the single source, wrapped in a top-level IIFE organized into build constants, state stores, data ingestion, UI, solver, and observers. Keep helpers adjacent to the block they support.
- `createAndMount()` bootstraps the panel, polls for the BGA log container (≤240 tries), then schedules the 800 ms heartbeat via `refreshStateAndMetrics()`.
- `buildCanonicalState()` is the hub for derived data; route new logic through it instead of querying `g_game` / `gameui` directly.

## Game data sources
- `findGameDataObject()` is the only approved doorway to BoardGameArena snapshots. Downstream helpers (`collectPlayerMetadataFromGD`, `captureRowsWithBgaMapFromGD`, `seedLiveRowsFromGD`) keep live and replay flows identical.
- `attachMetaToLiveRows()` decorates `liveRowsByBga` with ordered player info so placement logic, solver runs, and UI renderings stay aligned. Update `getOrderedPlayerIds()` when player metadata changes.
- When adding metadata, mirror the shape fed into `buildSolverWorkerSource()` so the inline worker sees the same structures as the main thread.

## State progression & persistence
- Card knowledge is monotonic via `setCardState()` (`unknown → my_hand → played`) across `cardState`, `playedSet`, `prevHand`, and `roundRevealCounts`.
- Per-round artifacts live in `sessionStorage` (`SS_PLAYED`, `SS_ROUND_SIG`, `SS_NEW_ROUND_FLAG`); layout and solver preferences persist in `localStorage` (`LS_UI_STATE`). Always use helpers (`savePlayedToSession()`, `saveUIState()`, etc.) rather than raw storage calls.
- `hardResetForNewRound()` and `maybeHeuristicNewRound()` coordinate resets. When changing round detection, update both the heuristics and the storage-reset path.

## Log & replay pipeline
- `observeLogContainer()` listens for DOM mutations and funnels each line into `applyLogLine()`. That function promotes card states, updates `roundRevealCounts` via `noteCardRevealFromName()`, and delegates structural row changes to `applyLogToLiveRows()`.
- `applyLogToLiveRows()` is the lone mutator of `liveRowsByBga`; whenever you add regex cases, update both append/start/take branches and ensure rows stay sorted.
- Page load recovery runs through `replayExistingLogForCurrentRound()`, which rebuilds rows from historical logs before reseeding from the current GD snapshot. Keep replay and live flows in sync when changing heuristics.

## UI & metrics
- The tracker panel mounts once in `createTrackerUI()`; redraws happen through `updateCardsUI()` and `renderUndercutList()`, both expecting canonical state output. Avoid ad-hoc DOM reads inside refresh routines.
- `refreshStateAndMetrics()` performs GD scans (`scanMyHand`, `scanTablePlayed`), heuristic checks, and UI updates. New observers should schedule this instead of duplicating the pipeline.
- `showStatus()` gives short-lived banners—useful when introducing workflow changes (e.g., new round alerts).

## Solver playbook
- `ensureSolverCoordinator()` spins up `SolverCoordinator`, which manages worker caps (default = detected hardware threads), deterministic seeds, and aggregated stats via `applyDeltas()`.
- The worker source comes from `buildSolverWorkerSource()`; keep mirrored helpers (`findRowForCard`, `resolvePlacement`, RNG utilities) bitwise identical between main thread and worker to preserve determinism.
- Solver pacing relies on `flushProgress()` / `recordDelta()` checkpoints and `recommendedCards` highlighting tolerance (±0.05 EV). Preserve these when altering ISMCTS loops or UI thresholds.

## Development workflow
- Ship changes by bumping both the metadata `@version` header and the `BUILD_STAMP` constant; otherwise Tampermonkey clients will not auto-update.
- Manual testing only: import the script into Tampermonkey (Utilities → Import from file), join a 6 Nimmt table, and watch the console. Handy hooks: `refreshStateAndMetrics()`, `hardResetForNewRound()`, `renderUndercutList()`, `updateCardsUI()`.
- UI layout state persists via `LS_UI_STATE`. To reset panel positioning during debugging, delete that key from `localStorage`.
