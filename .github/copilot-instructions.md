# 6 Nimmt Tracker – AI Guide

## Script layout
- All logic lives in `6-nimmt-script.js` as a Tampermonkey userscript executed on BoardGameArena (`@run-at document-idle`).
- The IIFE is organized into thematic blocks: build constants, card state bookkeeping, UI rendering, ISMCTS solver, BGA game-data scanning, log parsing, round detection, and bootstrap observers.
- Treat the file as the single source of truth—there is no bundler or dependency manager. Keep any shared helpers near the top-level blocks they serve.

## Card & round state
- Card state is tracked via `cardState`, `playedSet`, and `prevHand`. Use `setCardState` to promote states (`unknown → my_hand → played`) so monotonic rules hold.
- Round-specific persistence lives in `sessionStorage` (`SS_PLAYED`, `SS_ROUND_SIG`, `SS_NEW_ROUND_FLAG`); UI chrome uses `localStorage` (`LS_UI_STATE`). Respect these keys when adding new persistence to avoid clobbering existing data.
- `buildCanonicalState` produces the authoritative snapshot for solver + UI. Extend its payload instead of gathering ad-hoc DOM state.

## Game data ingestion
- `findGameDataObject()` and `collectPlayerMetadataFromGD()` normalize BoardGameArena structures; always funnel new metadata through them so replay + live updates stay in sync.
- Table rows are reconstructed via `captureRowsWithBgaMapFromGD()` and friends. When adjusting how rows are detected, update both the snapshot helpers and the replay logic in `applyLogToLiveRows`/`replayExistingLogForCurrentRound`.
- Log parsing (`applyLogLine`) is the only place that mutates `liveRowsByBga` from textual events; mirror its regex style and remember to `noteCardRevealFromName` to keep reveal counts accurate.

## UI & metrics
- UI is created once in `createTrackerUI()` and refreshed through `updateCardsUI()` and `renderUndercutList()`. New UI pieces should be wired into `saveUIState`/`loadUIState` to persist layout + solver settings.
- Metrics table expects `renderUndercutList()` to populate `recommendedCards`; any new scoring data should be appended to the same `cardMetrics` map so highlighting logic stays centralized.

## Solver pipeline
- ISMCTS orchestration is split between the main thread (`SolverCoordinator`, `runIsmctsRecommendation`) and an inline worker built by `buildSolverWorkerSource()`.
- Functions used by the worker must stay in lockstep with their main-thread counterparts; if you change card placement (`findRowForCard`, `resolvePlacement`, etc.), update both definitions (search for the duplicated code string) before testing.
- Worker coordination assumes deterministic seeds from `createRng` and periodic flushes (`flushProgress`, `recordDelta`); maintain those contracts when changing iteration pacing.

## Round lifecycle
- New rounds are detected via session signatures (`getRoundSignature`) plus heuristics in `maybeHeuristicNewRound()`. When altering round start behavior, also check `hardResetForNewRound()` and the ready-check block inside `createAndMount()`.
- After refresh, `createAndMount()` restores saved state, seeds rows/hand from GD, replays logs, then attaches observers. Preserve this order to avoid stale highlights or missing resets.

## Developer workflow
- Increment `BUILD_STAMP` when shipping meaningful behavior so users can see the build in the help panel.
- To test locally, load the script into Tampermonkey, join a 6 Nimmt game on BoardGameArena, and use the browser console to call `refreshStateAndMetrics()` or `hardResetForNewRound()` while watching DOM + console output.
- There are no automated tests; rely on live-table smoke checks and console logging (e.g., `console.log(buildCanonicalState(true))`) when debugging solver state.
