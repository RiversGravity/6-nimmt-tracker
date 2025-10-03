# 6 Nimmt Tracker – AI Guide

## Quick orientation
- `6-nimmt-tracker.user.js` is the entire app; sections are laid out constants → state → persistence → data ingestion → UI → solver → observers. Keep any new helper beside the block it supports.
- `createAndMount()` runs once, mounts the panel, spins up the 800 ms heartbeat via `refreshStateAndMetrics()`, and polls (≤240 tries) every 500 ms until the BGA log container appears.
- Canonical data flows through `buildCanonicalState()`; derive new metrics from its output instead of poking `g_game` / DOM nodes directly.

## Game data & canonical state
- Always fetch BGA snapshots with `findGameDataObject()`; the trio `collectPlayerMetadataFromGD()` / `captureRowsWithBgaMapFromGD()` / `seedLiveRowsFromGD()` keeps live and replay pipelines identical.
- `attachMetaToLiveRows()` enriches `liveRowsByBga` with seat order; if you add metadata, update `getOrderedPlayerIds()` so solver, placement, and UI stay aligned.
- `snapshotRows()` plus `liveHandArray()` feed `buildCanonicalState()`, which also reconciles opponent hand estimates via `roundRevealCounts` and `opponentInitialHandGuess`.
- Cache invalidation is explicit—call `invalidateCanonicalState()` whenever you mutate rows, card state, or player metadata.

## Persistence & round lifecycle
- Card knowledge moves monotonically through `setCardState()` (`unknown → my_hand → played`), with backing sets like `playedSet` and `prevHand`; never demote a card.
- Per-round storage lives in `sessionStorage` (`SS_PLAYED`, `SS_ROUND_SIG`, `SS_NEW_ROUND_FLAG`); write via helpers such as `savePlayedToSession()`, `setNewRoundFlag()`, `checkAndClearNewRoundFlag()`, and reset with `clearRoundStorage()`.
- Round detection couples `maybeHeuristicNewRound()` with `hardResetForNewRound()`; keep both paths in sync when you tweak heuristics or signature handling (the reset path also reseeds starters and updates `SS_ROUND_SIG`).
- UI layout + solver preferences persist in `localStorage` (`LS_UI_STATE`); always route changes through `saveUIState()` / `loadUIState()`.

## Log ingestion & replay
- `observeLogContainer()` is the sole MutationObserver; each new log line hits `applyLogLine()`, which updates `roundRevealCounts` (`noteCardRevealFromName()`) and defers row edits to `applyLogToLiveRows()`.
- `applyLogToLiveRows()` must remain the only writer of `liveRowsByBga`; add regex branches for append/start/take together and keep rows sorted by end card.
- On load, `replayExistingLogForCurrentRound()` rebuilds state from history before handing off to live observers; always mirror logic between replay and live flows when heuristics evolve.
- `seedLiveRowsFromGD()`, `scanTablePlayed()`, and `scanMyHand()` prime state on every heartbeat, so keep them lean.

## UI refresh pipeline
- `createTrackerUI()` builds the draggable panel once; `updateCardsUI()` and `renderUndercutList()` rerender based on canonical snapshots—avoid fresh DOM queries inside these.
- `refreshStateAndMetrics()` is the heartbeat: `syncTableMeta()` + GD scans + heuristics + UI repaint. New observers should schedule this rather than duplicating the pipeline.
- Temporary banners come from `showStatus()`; messages auto-dismiss, so keep them punchy.
- Respect the `recommendedCards` set when touching card styling; it’s populated alongside solver metrics in `renderUndercutList()`.

## Solver loop
- `ensureSolverCoordinator()` brings up the inline worker with a cap equal to detected hardware threads; adjust `DEFAULT_WORKER_COUNT` only if you also patch the worker selector UI.
- Worker code is emitted by `buildSolverWorkerSource()`; helpers like `findRowForCard`, `resolvePlacement`, and RNG utilities must stay byte-identical between main thread and worker to preserve determinism.
- Solver progress flows through `recordDelta()` / `flushProgress()` into `solverSnapshot`; update both if you change telemetry shape or pacing.
- Card recommendations highlight within ±0.05 EV (`recommendedCards`); keep tolerance and UI cue in sync if you expose new metrics.

## Development workflow
- Develop locally by importing the script into Tampermonkey (*Utilities → Import from file*) and use console hooks (`refreshStateAndMetrics()`, `hardResetForNewRound()`, `renderUndercutList()`, `updateCardsUI()`) while observing a live table.
- Ship changes by bumping both the metadata `@version` header and the `BUILD_STAMP` constant; without both, Tampermonkey clients will not pick up updates.
- There’s no automated test suite—manual QA means joining a 6 Nimmt table, validating card states, solver stats, and persistence across refreshes and new round triggers.
