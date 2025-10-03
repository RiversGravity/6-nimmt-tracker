// ==UserScript==
// @name         6 Nimmt Tracker
// @namespace    http://tampermonkey.net/
// @version      1.3.4
// @description  Minimal build
// @author       Technical Analyst
// @homepageURL  https://github.com/RiversGravity/6-nimmt-tracker
// @supportURL   https://github.com/RiversGravity/6-nimmt-tracker/issues
// @downloadURL  https://raw.githubusercontent.com/RiversGravity/6-nimmt-tracker/main/6-nimmt-tracker.user.js
// @updateURL    https://raw.githubusercontent.com/RiversGravity/6-nimmt-tracker/main/6-nimmt-tracker.user.js
// @match        *://boardgamearena.com/*
// @match        *://*.boardgamearena.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------- Build / constants ----------
  const BUILD_STAMP = '2025-10-02T19:25:00Z';
  const CARD_COUNT = 104;
  const TABLE_ID = (location.href.match(/table=(\d+)/)?.[1] || 'global');

  // Per-table, per-round persistence (sessionStorage - cleared on new round)
  const SS_PLAYED = `nimt_min_${TABLE_ID}_played_v1`;
  const SS_ROUND_SIG = `nimt_min_${TABLE_ID}_round_sig_v1`;
  const SS_NEW_ROUND_FLAG = `nimt_min_${TABLE_ID}_new_round_flag`; // Flag for new round refresh

  // UI persistence (localStorage - persists forever)
  const LS_UI_STATE = 'nimt_ui_state_v1';

  const DETECTED_HW_THREADS = (typeof navigator !== 'undefined' && Number.isFinite(navigator.hardwareConcurrency))
    ? Math.max(1, navigator.hardwareConcurrency)
    : 1;
  const DEFAULT_WORKER_COUNT = DETECTED_HW_THREADS;

  // ---------- State ----------
  const cardState = Object.create(null);
  const RANK = { unknown: 0, my_hand: 1, played: 2 };
  function setCardState(n, s) {
    const cur = cardState[n] || 'unknown';
    if (RANK[s] > RANK[cur]) cardState[n] = s;
  }

  let playedSet = new Set();
  let prevHand = new Set();
  let liveRowsByBga = null;
  let tableMeta = null;
  let canonicalStateCache = null;
  let roundRevealCounts = Object.create(null);
  let opponentInitialHandGuess = Object.create(null);
  let prevTableCount = null;
  let isReplaying = false;

  // UI refs
  let statusDiv = null;
  let logContainer = null;
  let trackerGrid = null;
  let metricsWrap = null;
  let trackerContainer = null;
  let recommendedCards = new Set();
  let solverToggleEl = null;
  let solverWorkerSelectEl = null;
  let solverCoordinator = null;
  let lastExpandedWidth = null;
  let lastExpandedHeight = null;

  // ---------- UI State Persistence ----------
  function saveUIState() {
    if (!trackerContainer) return;
    const minimized = trackerContainer.classList.contains('minimized');
    if (!minimized) {
      lastExpandedWidth = trackerContainer.offsetWidth;
      lastExpandedHeight = trackerContainer.offsetHeight;
    }
    const state = {
      left: trackerContainer.style.left || 'auto',
      top: trackerContainer.style.top || 'auto',
      width: lastExpandedWidth ?? trackerContainer.offsetWidth,
      height: lastExpandedHeight ?? trackerContainer.offsetHeight,
      minimized
    };
    if (solverCoordinator) {
      state.solver = {
        enabled: solverCoordinator.isEnabled(),
        workerCap: solverCoordinator.getWorkerCap()
      };
    }
    try {
      localStorage.setItem(LS_UI_STATE, JSON.stringify(state));
    } catch {}
  }

  function loadUIState() {
    try {
      const raw = localStorage.getItem(LS_UI_STATE);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function applyUIState(state) {
    if (!state || !trackerContainer) return;

    // Position
    if (state.left && state.left !== 'auto') {
      trackerContainer.style.left = state.left;
      trackerContainer.style.right = 'auto';
    }
    if (state.top && state.top !== 'auto') {
      trackerContainer.style.top = state.top;
    }

    if (state.width) {
      trackerContainer.style.width = state.width + 'px';
      lastExpandedWidth = state.width;
    }
    if (state.height) {
      lastExpandedHeight = state.height;
      if (!state.minimized) {
        trackerContainer.style.height = state.height + 'px';
      } else {
        trackerContainer.style.height = '';
      }
    }

    // Minimized state
    if (state.minimized) {
      trackerContainer.classList.add('minimized');
      const minBtn = trackerContainer.querySelector('button[title*="Minimize"]');
      if (minBtn) minBtn.textContent = '+';
    }
  }

  // ---------- Utilities ----------
  function byId(id) { return document.getElementById(id); }
  function clamp(val, min, max) {
    if (!Number.isFinite(val)) return min;
    if (val < min) return min;
    if (val > max) return max;
    return val;
  }
  function findGameDataObject() {
    const scope = (typeof window !== 'undefined')
      ? window
      : (typeof self !== 'undefined') ? self : {};

    const gGame = scope.g_game;
    if (gGame && gGame.gamedatas) return gGame.gamedatas;

    const gameUi = scope.gameui;
    if (gameUi && gameUi.gamedatas) return gameUi.gamedatas;

    if (scope.gamedatas) return scope.gamedatas;
    return null;
  }

  // ---------- Player metadata helpers ----------
  function normalizePlayerName(name) {
    if (name == null) return '';
    let str = (typeof name === 'string') ? name : String(name);
    str = str.replace(/\s+/g, ' ').trim();
    if (!str) return '';
    str = str.replace(/\(.*?\)/g, ' ');
    if (typeof str.normalize === 'function') {
      str = str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    }
    str = str.replace(/[^0-9a-zA-Z ]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    return str;
  }

  function pickFirstNumeric(obj, fields) {
    if (!obj) return null;
    for (const field of fields) {
      const val = obj[field];
      if (val == null || val === '') continue;
      const num = (typeof val === 'number') ? val : parseFloat(val);
      if (Number.isFinite(num)) return num;
    }
    return null;
  }

  function normalizeOrderValue(val) {
    const arr = [];
    if (!val) return arr;
    const push = (entry) => {
      if (entry == null) return;
      const id = String(entry).trim();
      if (!id) return;
      arr.push(id);
    };
    if (Array.isArray(val)) {
      val.forEach(push);
    } else if (typeof val === 'string') {
      val.split(/[,;|\s]+/).forEach(push);
    } else if (typeof val === 'object') {
      if (typeof val[Symbol.iterator] === 'function') {
        for (const entry of val) push(entry);
      } else {
        Object.values(val).forEach(push);
      }
    }
    return arr;
  }

  function collectPlayerMetadataFromGD(gd) {
    if (!gd) return null;

    const playersSrc = (gd.players && typeof gd.players === 'object') ? gd.players : null;
    const scoresSrc = (gd.scores && typeof gd.scores === 'object') ? gd.scores : null;
    if (!playersSrc && !scoresSrc) return null;

    const meta = {
      players: {},
      order: [],
      bullsById: Object.create(null),
      handCounts: Object.create(null),
      seatById: Object.create(null),
      nameToId: Object.create(null),
      rawScores: scoresSrc || null,
      myId: null,
      myName: null,
      lastUpdated: Date.now()
    };

    if (playersSrc) {
      for (const [idRaw, infoRaw] of Object.entries(playersSrc)) {
        if (!infoRaw) continue;
        const id = String(idRaw);
        const info = { ...infoRaw };
        meta.players[id] = info;

        const bulls = pickFirstNumeric(info, [
          'bullheads',
          'bull_heads',
          'bulls',
          'player_score',
          'score',
          'total_score',
          'points',
          'score_aux',
          'scoreAux'
        ]);
        if (Number.isFinite(bulls)) meta.bullsById[id] = bulls;

        const seat = pickFirstNumeric(info, [
          'player_no',
          'player_table_order',
          'playerIndex',
          'player_index',
          'seat',
          'table_order',
          'order',
          'no'
        ]);
        if (Number.isFinite(seat)) meta.seatById[id] = seat;

        const handCount = pickFirstNumeric(info, [
          'hand_count',
          'handCount',
          'cards_on_hand',
          'cardsOnHand',
          'cards_in_hand',
          'cardsInHand',
          'card_count',
          'cardCount',
          'cards',
          'remaining_cards',
          'remainingCards',
          'nb_cards',
          'nbr_cards',
          'n_cards',
          'cardsleft',
          'cardsLeft'
        ]);
        if (Number.isFinite(handCount)) meta.handCounts[id] = handCount;

        const names = [
          info.player_name,
          info.playerName,
          info.name,
          info.player_nickname,
          info.nickname,
          info.player_username,
          info.username,
          info.label
        ];
        for (const nm of names) {
          if (typeof nm === 'string' && nm.trim()) {
            meta.nameToId[normalizePlayerName(nm)] = id;
          }
        }
      }
    }

    if (scoresSrc) {
      for (const [idRaw, entry] of Object.entries(scoresSrc)) {
        const id = String(idRaw);
        if (entry && typeof entry === 'object') {
          const bulls = pickFirstNumeric(entry, [
            'score',
            'points',
            'value',
            'bulls',
            'bullheads',
            'total'
          ]);
          if (Number.isFinite(bulls)) meta.bullsById[id] = bulls;
        } else {
          const bulls = (typeof entry === 'number') ? entry : parseFloat(entry);
          if (Number.isFinite(bulls)) meta.bullsById[id] = bulls;
        }
      }
    }

    const candidateIds = new Set(Object.keys(meta.players));
    const orderSet = new Set();
    const orderList = [];

    const pushOrder = (val) => {
      const arr = normalizeOrderValue(val);
      for (const id of arr) {
        if (!id) continue;
        if (candidateIds.size && !candidateIds.has(id) && !meta.players[id]) continue;
        if (!orderSet.has(id)) {
          orderSet.add(id);
          orderList.push(id);
        }
      }
    };

    const orderSources = [
      gd?.playerorder,
      gd?.player_order,
      gd?.gamestate?.playerorder,
      gd?.gamestate?.player_order,
      gd?.gamestate?.args?.playerorder,
      gd?.gamestate?.args?.player_order,
      gd?.playerorder_map,
      gd?.playerorderlist
    ];
    for (const source of orderSources) pushOrder(source);

    if (orderList.length < candidateIds.size && Object.keys(meta.seatById).length) {
      const seats = Object.entries(meta.seatById).sort((a, b) => {
        const av = a[1], bv = b[1];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        return av - bv;
      });
      for (const [id] of seats) {
        if (!orderSet.has(id)) {
          orderSet.add(id);
          orderList.push(id);
        }
      }
    }

    if (candidateIds.size) {
      const sorted = Array.from(candidateIds).sort();
      for (const id of sorted) {
        if (!orderSet.has(id)) orderList.push(id);
      }
    }

    meta.order = orderList;

    let myId = gd?.playerid ?? gd?.player_id ?? gd?.playerId ?? gd?.current_player_id ?? gd?.currentPlayerId ?? null;
    if (!myId) {
      const scope = (typeof window !== 'undefined')
        ? window
        : (typeof self !== 'undefined') ? self : {};

      const gGame = scope.g_game;
      if (gGame) myId = gGame.player_id ?? gGame.playerid ?? null;

      if (!myId) {
        const gameUi = scope.gameui;
        if (gameUi) myId = gameUi.player_id ?? gameUi.playerid ?? null;
      }
    }
    if (myId != null) {
      meta.myId = String(myId);
    } else if (meta.order.length === 1) {
      meta.myId = meta.order[0];
    } else {
      meta.myId = null;
    }

    if (meta.myId) {
      const me = meta.players[meta.myId];
      if (me) {
        const selfNames = [
          me.player_name,
          me.name,
          me.playerName,
          me.nickname,
          me.player_nickname
        ];
        for (const nm of selfNames) {
          if (typeof nm === 'string' && nm.trim()) {
            meta.nameToId[normalizePlayerName(nm)] = meta.myId;
          }
        }
      }
    }

    return meta;
  }

  function attachMetaToLiveRows(meta) {
    if (!liveRowsByBga || !meta) return;
    try {
      Object.defineProperty(liveRowsByBga, '__meta', {
        value: meta,
        configurable: true,
        enumerable: false,
        writable: true
      });
    } catch {
      liveRowsByBga.__meta = meta;
    }
  }

  function setTableMeta(meta) {
    if (!meta) return;
    tableMeta = meta;
    attachMetaToLiveRows(meta);
  }

  function ensureTableMeta() {
    if (tableMeta) return tableMeta;
    syncTableMeta();
    return tableMeta;
  }

  function syncTableMeta(gd) {
    const meta = collectPlayerMetadataFromGD(gd || findGameDataObject());
    if (meta) setTableMeta(meta);
    return tableMeta;
  }

  function getOrderedPlayerIds(meta) {
    if (!meta) return [];
    const seen = new Set();
    const ordered = [];

    if (Array.isArray(meta.order)) {
      for (const val of meta.order) {
        const id = String(val);
        if (!id) continue;
        if (meta.players && !meta.players[id]) continue;
        if (!seen.has(id)) {
          seen.add(id);
          ordered.push(id);
        }
      }
    }

    if (meta.seatById) {
      const seats = Object.entries(meta.seatById).sort((a, b) => {
        const av = a[1], bv = b[1];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        return av - bv;
      });
      for (const [id] of seats) {
        if (meta.players && !meta.players[id]) continue;
        if (!seen.has(id)) {
          seen.add(id);
          ordered.push(id);
        }
      }
    }

    if (meta.players) {
      const rest = Object.keys(meta.players).sort();
      for (const id of rest) {
        if (!seen.has(id)) {
          seen.add(id);
          ordered.push(id);
        }
      }
    }

    return ordered;
  }

  function resolvePlayerIdFromName(name) {
    const meta = ensureTableMeta();
    if (!meta || !name) return null;
    const raw = String(name).trim();
    if (!raw) return null;
    if (/^you\b/i.test(raw)) {
      return meta.myId || null;
    }
    const cleaned = raw.replace(/\(.*?\)/g, ' ');
    const normalized = normalizePlayerName(cleaned);
    if (normalized && meta.nameToId?.[normalized]) {
      return meta.nameToId[normalized];
    }
    if (meta.players) {
      for (const [id, info] of Object.entries(meta.players)) {
        const names = [
          info.player_name,
          info.playerName,
          info.name,
          info.player_nickname,
          info.nickname
        ];
        for (const nm of names) {
          if (typeof nm === 'string' && normalizePlayerName(nm) === normalized) {
            return id;
          }
        }
      }
    }
    return null;
  }

  function noteCardRevealFromName(name) {
    const id = resolvePlayerIdFromName(name);
    if (!id) return null;
    const prev = roundRevealCounts[id] || 0;
    roundRevealCounts[id] = prev + 1;
    return id;
  }

  function resetRoundRevealCounts() {
    roundRevealCounts = Object.create(null);
    opponentInitialHandGuess = Object.create(null);
    clearSolverCache();
  }

  function loadPlayedFromSession() {
    try {
      const a = JSON.parse(sessionStorage.getItem(SS_PLAYED) || '[]');
      if (Array.isArray(a)) return new Set(a.filter(n => Number.isFinite(n)));
    } catch {}
    return new Set();
  }

  function savePlayedToSession() {
    try { sessionStorage.setItem(SS_PLAYED, JSON.stringify([...playedSet])); } catch {}
  }

  function clearRoundStorage() {
    try {
      sessionStorage.removeItem(SS_PLAYED);
      sessionStorage.removeItem(SS_ROUND_SIG);
    } catch {}
    clearSolverCache();
  }

  function setNewRoundFlag() {
    try {
      sessionStorage.setItem(SS_NEW_ROUND_FLAG, '1');
    } catch {}
  }

  function checkAndClearNewRoundFlag() {
    try {
      const flag = sessionStorage.getItem(SS_NEW_ROUND_FLAG);
      sessionStorage.removeItem(SS_NEW_ROUND_FLAG);
      return flag === '1';
    } catch {
      return false;
    }
  }

  function getRoundSignature() {
    const snap = captureRowsWithBgaMapFromGD();
    const hand = liveHandArray();
    if (snap.rows.length === 4 && snap.rowLens.every(l => l === 1) && hand.length >= 8) {
      return `${snap.rowEnds.join(',')}_${hand.slice(0,3).join(',')}`;
    }
    return '';
  }

  // ---------- CSS ----------
  (function addCss() {
    const style = document.createElement('style');
    style.textContent = `
      #nimt-tracker-status { position: fixed; top: 10px; left: 10px; padding: 8px 12px; background: #4a90e2; color: #fff; z-index: 10001; border-radius: 6px; font-weight: 600; box-shadow: 0 2px 5px rgba(0,0,0,.2); }
      #nimt-tracker-container { position: fixed; top: 6px; right: 16px; width: 520px; background: #fff; border: 2px solid #222; border-radius: 10px; z-index: 9999; box-shadow: 0 4px 12px rgba(0,0,0,.2); display: flex; flex-direction: column; resize: both; overflow: hidden; cursor: move; }
      #nimt-tracker-container.minimized { height: auto !important; resize: none; overflow: visible; }
      #nimt-tracker-container.minimized #nimt-tracker-grid,
      #nimt-tracker-container.minimized #nimt-metrics,
      #nimt-tracker-container.minimized #nimt-tracker-help { display: none !important; }
      #nimt-tracker-container button,
      #nimt-tracker-container input,
      #nimt-tracker-container select,
      #nimt-tracker-container textarea,
      #nimt-tracker-container label { cursor: auto; }
      #nimt-tracker-header { display:flex; align-items:center; justify-content:space-between; padding:10px; font-weight:700; color:#fff; background:#333; border-radius: 8px 8px 0 0; }
      #nimt-tracker-header button { background:#555; color:#fff; border:1px solid #777; border-radius:6px; cursor:pointer; width:26px; height:26px; margin-left:8px; }
      #nimt-tracker-help { padding:10px 15px; border-bottom:1px solid #ddd; background:#f9f9f9; display:none; }
      #nimt-tracker-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(24px, 1fr)); gap:2px; padding:6px; }
      .tracker-card { display:flex; justify-content:center; align-items:center; height:24px; font-size:11px; font-weight:600; border-radius:3px; background:#eee; color:#555; user-select:none; }
      .tracker-card.state-played { background:#c62828; color:#fff; text-decoration:line-through; }
      .tracker-card.state-my_hand { background:#2e7d32; color:#fff; }
      .tracker-card.recommend { box-shadow: 0 0 0 2px #ff9800 inset; }
      #nimt-metrics { border-top:1px solid #ddd; padding:8px 10px 12px; background:#fafafa; }
      #nimt-metrics h4 { margin:6px 0 8px; font-size:14px; font-weight:800; color:#222; }
      #nimt-solver-controls { display:flex; align-items:center; gap:10px; margin:0 0 8px; font-size:12px; color:#333; flex-wrap:wrap; }
      #nimt-solver-controls label { display:flex; align-items:center; gap:4px; }
      #nimt-solver-controls select { padding:2px 6px; font-size:12px; }
      #nimt-metrics table { width:100%; border-collapse: collapse; }
      #nimt-metrics th, #nimt-metrics td { font-size:12px; text-align:right; padding:4px 6px; border-bottom:1px solid #e9e9e9; font-variant-numeric: tabular-nums; }
      #nimt-metrics th { text-align:right; background:#f1f1f1; position: sticky; top: 0; z-index: 1; }
      #nimt-metrics td:first-child, #nimt-metrics th:first-child { text-align:left; }
      #nimt-metrics tr.best-card { background: rgba(255, 193, 7, 0.16); font-weight:700; }
    `;
    document.head.appendChild(style);
  })();

  // ---------- UI ----------
  function helpHtml() {
    return `
      <p><strong>Minimal tracker</strong> (build ${BUILD_STAMP})</p>
      <ul style="margin:0 0 6px 16px;">
        <li><b>Grid:</b> <span style="color:#2e7d32;">green</span>=in hand, <span style="color:#fff;background:#c62828;padding:0 4px;border-radius:3px;">red</span>=seen/played this round, grey=unknown.</li>
  <li><b>Card metrics</b>: ISMCTS expected bull-head penalties split into immediate vs. future impact, plus undercut counts for context.</li>
        <li><b>Auto-refresh:</b> Page reloads automatically when a new round starts.</li>
        <li><b>UI position/size:</b> Saved permanently across all sessions.</li>
        <li><b>Solver controls:</b> Pause/resume the ISMCTS search or cap the number of background workers.</li>
      </ul>`;
  }

  function createTrackerUI() {
    if (byId('nimt-tracker-container')) return;

    const box = document.createElement('div');
    box.id = 'nimt-tracker-container';
    trackerContainer = box;

    const header = document.createElement('div');
    header.id = 'nimt-tracker-header';
    const title = document.createElement('span');
    title.textContent = '6 Nimmt! Minimal Tracker';
    header.appendChild(title);

    const ctrls = document.createElement('div');
    ctrls.style.display = 'flex';
    const helpBtn = document.createElement('button');
    helpBtn.textContent = '?';
    helpBtn.title = 'Help';
    const minBtn = document.createElement('button');
    minBtn.textContent = '–';
    minBtn.title = 'Minimize/Maximize';
    ctrls.appendChild(helpBtn);
    ctrls.appendChild(minBtn);
    header.appendChild(ctrls);
    box.appendChild(header);

    const help = document.createElement('div');
    help.id = 'nimt-tracker-help';
    help.innerHTML = helpHtml();
    box.appendChild(help);

    trackerGrid = document.createElement('div');
    trackerGrid.id = 'nimt-tracker-grid';
    for (let i = 1; i <= CARD_COUNT; i++) {
      const d = document.createElement('div');
      d.id = `tracker-card-${i}`;
      d.className = 'tracker-card';
      d.textContent = i;
      trackerGrid.appendChild(d);
    }
    box.appendChild(trackerGrid);

    const metricsBox = document.createElement('div');
    metricsBox.id = 'nimt-metrics';
    metricsBox.innerHTML = `
      <h4>Card Metrics (ISMCTS)</h4>
      <div id="nimt-solver-controls">
        <label><input type="checkbox" id="nimt-solver-toggle" checked> Run solver</label>
        <label>Workers:
          <select id="nimt-solver-worker-count"></select>
        </label>
      </div>
      <div id="nimt-metrics-wrap"><div style="color:#777;">Waiting for game data…</div></div>`;
    box.appendChild(metricsBox);
    metricsWrap = metricsBox.querySelector('#nimt-metrics-wrap');
    solverToggleEl = metricsBox.querySelector('#nimt-solver-toggle');
    solverWorkerSelectEl = metricsBox.querySelector('#nimt-solver-worker-count');

    if (solverWorkerSelectEl) {
      solverWorkerSelectEl.innerHTML = '';
      for (let i = 1; i <= DETECTED_HW_THREADS; i++) {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = String(i);
        solverWorkerSelectEl.appendChild(opt);
      }
    }

    document.body.appendChild(box);

    lastExpandedWidth = box.offsetWidth;
    lastExpandedHeight = box.offsetHeight;

    const savedState = loadUIState();
    ensureSolverCoordinator(savedState?.solver || null);

    if (solverCoordinator) {
      if (solverToggleEl) solverToggleEl.checked = solverCoordinator.isEnabled();
      if (solverWorkerSelectEl) solverWorkerSelectEl.value = String(solverCoordinator.getWorkerCap());
    } else {
      if (solverToggleEl) solverToggleEl.checked = true;
      if (solverWorkerSelectEl) solverWorkerSelectEl.value = String(DEFAULT_WORKER_COUNT);
    }

    // Apply saved UI state for layout/minimize
    if (savedState) {
      applyUIState(savedState);
    }

    if (solverToggleEl) {
      solverToggleEl.addEventListener('change', () => {
        const enabled = !!solverToggleEl.checked;
        if (solverCoordinator) {
          solverCoordinator.setEnabled(enabled);
        }
        saveUIState();
        renderUndercutList();
      });
    }

    if (solverWorkerSelectEl) {
      solverWorkerSelectEl.addEventListener('change', () => {
        const val = parseInt(solverWorkerSelectEl.value, 10);
        if (solverCoordinator) {
          solverCoordinator.setWorkerCap(val);
        }
        saveUIState();
      });
    }

    makeDraggable(box);

    helpBtn.onclick = () => (help.style.display = help.style.display === 'none' ? 'block' : 'none');
    minBtn.onclick = () => {
      const wasMinimized = box.classList.contains('minimized');
      if (!wasMinimized) {
        lastExpandedWidth = box.offsetWidth;
        lastExpandedHeight = box.offsetHeight;
      }
      const isMin = box.classList.toggle('minimized');
      const widthToApply = lastExpandedWidth ?? box.offsetWidth;
      if (Number.isFinite(widthToApply)) {
        box.style.width = widthToApply + 'px';
      }
      if (isMin) {
        box.style.height = '';
      } else if (Number.isFinite(lastExpandedHeight)) {
        box.style.height = lastExpandedHeight + 'px';
      } else {
        box.style.height = '';
      }
      help.style.display = 'none';
      minBtn.textContent = isMin ? '+' : '–';
      saveUIState();
      if (!isMin) refreshStateAndMetrics();
    };

    // Save UI state on resize
    const resizeObserver = new ResizeObserver(() => {
      if (!box.classList.contains('minimized')) {
        lastExpandedWidth = box.offsetWidth;
        lastExpandedHeight = box.offsetHeight;
      }
      saveUIState();
    });
    resizeObserver.observe(box);
  }

  function makeDraggable(container) {
    let dx = 0, dy = 0, dragging = false;
    container.style.cursor = 'move';
    const interactiveSelectors = 'button, input, select, textarea, label, a';
    container.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const target = e.target;
      if (target instanceof Element && target.closest(interactiveSelectors)) return;

      const RESIZE_HANDLE_SIZE = 16;
      let nearResizeHandle = false;
      if (target === container && Number.isFinite(e.offsetX) && Number.isFinite(e.offsetY)) {
        const nearRight = (container.clientWidth - e.offsetX) <= RESIZE_HANDLE_SIZE;
        const nearBottom = (container.clientHeight - e.offsetY) <= RESIZE_HANDLE_SIZE;
        nearResizeHandle = nearRight && nearBottom;
      } else {
        const rect = container.getBoundingClientRect();
        const withinBounds = (
          e.clientX >= rect.left && e.clientX <= rect.right &&
          e.clientY >= rect.top && e.clientY <= rect.bottom
        );
        if (withinBounds) {
          const nearRight = (rect.right - e.clientX) <= RESIZE_HANDLE_SIZE;
          const nearBottom = (rect.bottom - e.clientY) <= RESIZE_HANDLE_SIZE;
          nearResizeHandle = nearRight && nearBottom;
        }
      }
      if (nearResizeHandle) return;

      dragging = true;
      dx = e.clientX - container.offsetLeft;
      dy = e.clientY - container.offsetTop;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      container.style.left = `${e.clientX - dx}px`;
      container.style.top = `${e.clientY - dy}px`;
      container.style.right = 'auto';
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0 && dragging) {
        dragging = false;
        saveUIState();
      }
    });
  }

  function showStatus(s, color = '#4a90e2') {
    if (!statusDiv) {
      statusDiv = document.createElement('div');
      statusDiv.id = 'nimt-tracker-status';
      document.body.appendChild(statusDiv);
    }
    statusDiv.textContent = s;
    statusDiv.style.background = color;
  }

  // ---------- GD snapshot helpers ----------
  function captureRowsWithBgaMapFromGD() {
    const gd = findGameDataObject();
    const meta = syncTableMeta(gd);
    const rows = [], map = [], lens = [];
    if (gd?.table) {
      const entries = Object.entries(gd.table);
      for (let idx = 0; idx < entries.length; idx++) {
        const [rowKey, rowObj] = entries[idx];
        const cards = Object.values(rowObj)
          .map(c => parseInt(c?.type_arg, 10))
          .filter(Number.isFinite)
          .sort((a, b) => a - b);
        if (cards.length > 0) {
          rows.push(cards);
          lens.push(cards.length);
          const guessed = parseInt(rowKey, 10);
          map.push(Number.isNaN(guessed) ? (map.length + 1) : guessed);
        }
      }
      const zipped = rows.map((r, i) => ({ r, i, l: lens[i] }));
      zipped.sort((a, b) => a.r[a.r.length - 1] - b.r[b.r.length - 1]);
      const sortedRows = zipped.map(z => z.r);
      const sortedMap = zipped.map(z => map[z.i]);
      const sortedLens = zipped.map(z => z.l);
      return {
        rows: sortedRows,
        rowEnds: sortedRows.map(r => r[r.length - 1]),
        rowLens: sortedLens,
        rowBgaNums: sortedMap,
        playerMeta: meta || tableMeta || null
      };
    }
    return { rows: [], rowEnds: [], rowLens: [], rowBgaNums: [], playerMeta: meta || tableMeta || null };
  }

  function seedLiveRowsFromGD() {
    const snap = captureRowsWithBgaMapFromGD();
    if (!snap.rows.length) {
      liveRowsByBga = null;
      return;
    }
    liveRowsByBga = Object.create(null);
    if (snap.playerMeta || tableMeta) {
      attachMetaToLiveRows(snap.playerMeta || tableMeta);
    }
    for (let i = 0; i < snap.rows.length; i++) {
      const bga = snap.rowBgaNums[i] ?? (i + 1);
      liveRowsByBga[bga] = snap.rows[i].slice();
    }
    prevTableCount = snap.rowLens.reduce((a, b) => a + b, 0);
    invalidateCanonicalState();
  }

  function snapshotRows() {
    if (!liveRowsByBga) seedLiveRowsFromGD();
    if (!liveRowsByBga) return { rows: [], rowEnds: [], rowBgaNums: [], playerMeta: tableMeta || null };
    const bgaNums = Object.keys(liveRowsByBga).map(n => +n).sort((a, b) => a - b);
    const rows = bgaNums.map(n => (liveRowsByBga[n] || []).slice().sort((a, b) => a - b));
    const ends = rows.map(r => r[r.length - 1]);
    return { rows, rowEnds: ends, rowBgaNums: bgaNums, playerMeta: tableMeta || null };
  }

  function invalidateCanonicalState() {
    canonicalStateCache = null;
  }

  function buildCanonicalState(force = false) {
    if (!force && canonicalStateCache) return canonicalStateCache;

    const meta = ensureTableMeta() || {
      players: {},
      order: [],
      bullsById: Object.create(null),
      handCounts: Object.create(null),
      seatById: Object.create(null),
      nameToId: Object.create(null),
      myId: null
    };

    const snap = snapshotRows();
    const rows = snap.rows.map(r => r.slice());
    const rowBgaNums = (snap.rowBgaNums || []).slice();
    const hand = liveHandArray();

    const deck = [];
    for (let card = 1; card <= CARD_COUNT; card++) {
      deck.push({
        card,
        state: cardState[card] || 'unknown',
        played: playedSet.has(card),
        inMyHand: cardState[card] === 'my_hand'
      });
    }

    const orderedIds = getOrderedPlayerIds(meta);
    const baseIds = orderedIds.length
      ? orderedIds.slice()
      : (meta.players ? Object.keys(meta.players).sort() : []);

    const myId = meta.myId ? String(meta.myId) : null;
    const mySeatIndex = baseIds.indexOf(myId);
    const myReveals = myId ? (roundRevealCounts[myId] || 0) : 0;
    const bgaMyHandCount = (myId != null && meta.handCounts) ? meta.handCounts[myId] : null;
    const revealsContribution = Number.isFinite(myReveals) ? myReveals : 0;
    let initialHandCount = null;
    if (myId != null) {
      if (Number.isFinite(bgaMyHandCount)) {
        initialHandCount = bgaMyHandCount + revealsContribution;
      } else {
        initialHandCount = hand.length + revealsContribution;
      }
    }

    const players = baseIds.map((id, idx) => {
      const info = meta.players?.[id] || {};
      const bulls = meta.bullsById?.[id];
      const revealsRaw = roundRevealCounts[id];
      const reveals = Number.isFinite(revealsRaw) ? revealsRaw : 0;
      const bgaHandCountRaw = meta.handCounts?.[id];
      const bgaHandCount = Number.isFinite(bgaHandCountRaw) ? Math.max(0, bgaHandCountRaw) : null;

      if (Number.isFinite(bgaHandCount) && Number.isFinite(reveals)) {
        const inferredInitial = bgaHandCount + reveals;
        if (Number.isFinite(inferredInitial) && inferredInitial >= 0) {
          const prevInitial = opponentInitialHandGuess[id];
          if (!Number.isFinite(prevInitial) || inferredInitial > prevInitial) {
            opponentInitialHandGuess[id] = inferredInitial;
          }
        }
      }

      return {
        id,
        seat: idx,
        name:
          info.player_name ||
          info.playerName ||
          info.name ||
          info.nickname ||
          `Player ${id}`,
        bulls: Number.isFinite(bulls) ? bulls : null,
        reveals,
        handCount: Number.isFinite(bgaHandCount) ? bgaHandCount : null,
        isYou: id === myId,
        color: info.player_color || info.color || null
      };
    });

    const opponentHandCounts = {};
    for (const id of baseIds) {
      if (id === myId) continue;
      const revealsRaw = roundRevealCounts[id];
      const reveals = Number.isFinite(revealsRaw) ? revealsRaw : 0;
      const bgaCountRaw = meta.handCounts?.[id];
      const bgaCount = Number.isFinite(bgaCountRaw) ? Math.max(0, bgaCountRaw) : null;

      let initialEstimate = null;
      if (Number.isFinite(bgaCount) && Number.isFinite(reveals)) {
        const inferredInitial = bgaCount + reveals;
        if (Number.isFinite(inferredInitial) && inferredInitial >= 0) {
          initialEstimate = inferredInitial;
        }
      }

      const cachedInitial = opponentInitialHandGuess[id];
      if (!Number.isFinite(initialEstimate) && Number.isFinite(cachedInitial)) {
        initialEstimate = cachedInitial;
      }
      if (!Number.isFinite(initialEstimate) && Number.isFinite(initialHandCount)) {
        initialEstimate = initialHandCount;
      }

      let remaining = null;
      let source = null;
      if (Number.isFinite(bgaCount)) {
        remaining = bgaCount;
        source = 'bga';
      } else if (Number.isFinite(initialEstimate) && Number.isFinite(reveals)) {
        remaining = Math.max(initialEstimate - reveals, 0);
        source = 'derived';
      }

      if (Number.isFinite(initialEstimate)) {
        const prevInitial = opponentInitialHandGuess[id];
        if (!Number.isFinite(prevInitial) || initialEstimate > prevInitial) {
          opponentInitialHandGuess[id] = initialEstimate;
        }
      }

      opponentHandCounts[id] = {
        remaining: Number.isFinite(remaining) ? remaining : null,
        reveals,
        source,
        fromBga: Number.isFinite(bgaCount) ? bgaCount : null,
        initialEstimate: Number.isFinite(initialEstimate) ? initialEstimate : null
      };
    }

    const revealSnapshot = Object.create(null);
    for (const [id, count] of Object.entries(roundRevealCounts)) {
      revealSnapshot[id] = count;
    }

    const cardBeliefs = Object.create(null);
    const knowledgeByPlayer = Object.create(null);
    const opponents = baseIds.filter(id => id !== myId);
    if (opponents.length) {
      const weightInfoCache = Object.create(null);
      const resolveBeliefWeight = (id) => {
        if (Object.prototype.hasOwnProperty.call(weightInfoCache, id)) {
          return weightInfoCache[id];
        }
        const info = opponentHandCounts[id] || {};
        let bestWeight = null;
        let bestPriority = -Infinity;
        let hasHardZero = false;
        let observedSoftZero = false;
        let softZeroPriority = -Infinity;
        let source = 'unknown';

        const consider = (value, priority, src, zeroIsHard = true) => {
          if (!Number.isFinite(value)) return;
          const val = Number(value);
          if (val <= 0) {
            if (val === 0) {
              if (zeroIsHard) {
                hasHardZero = true;
                if (bestWeight == null || priority >= bestPriority) {
                  bestWeight = 0;
                  bestPriority = priority;
                  source = src;
                }
              } else {
                observedSoftZero = true;
                if (priority > softZeroPriority) softZeroPriority = priority;
              }
            }
            return;
          }
          if (bestWeight == null || priority >= bestPriority) {
            bestWeight = val;
            bestPriority = priority;
            source = src;
          }
        };

        consider(info.remaining, 6, 'remaining', true);
        consider(info.fromBga, 5, 'bgaCount', true);
        const metaCount = meta.handCounts?.[id];
        if (metaCount !== info.fromBga) consider(metaCount, 5, 'metaHand', true);
        if (Number.isFinite(info.initialEstimate) && Number.isFinite(info.reveals)) {
          consider(info.initialEstimate - info.reveals, 4, 'initialMinusReveals', false);
        }
        const revealsVal = roundRevealCounts[id];
        if (Number.isFinite(revealsVal)) {
          let initialCandidate = info.initialEstimate;
          if (!Number.isFinite(initialCandidate)) {
            const cachedInitial = opponentInitialHandGuess[id];
            if (Number.isFinite(cachedInitial)) initialCandidate = cachedInitial;
          }
          if (!Number.isFinite(initialCandidate) && Number.isFinite(initialHandCount)) {
            initialCandidate = initialHandCount;
          }
          if (Number.isFinite(initialCandidate)) {
            consider(initialCandidate - revealsVal, 3, 'sharedInitialMinusReveals', false);
          }
        }

        let weight;
        let fallback = false;
        if (bestWeight != null) {
          weight = bestWeight;
          if (!hasHardZero && observedSoftZero && softZeroPriority > bestPriority) {
            weight = 0;
            source = 'softZero';
          }
        } else if (hasHardZero) {
          weight = 0;
          source = 'hardZero';
        } else if (observedSoftZero) {
          weight = 0;
          source = 'softZero';
        } else {
          weight = 1;
          fallback = true;
          source = 'fallback';
        }

        if (!(weight >= 0)) weight = 0;

        const resolved = { weight, fallback, hardZero: hasHardZero, source };
        weightInfoCache[id] = resolved;
        return resolved;
      };

      for (const id of opponents) {
        knowledgeByPlayer[id] = { must: [], forbid: [] };
      }

      const estimateRemaining = (id) => {
        const info = opponentHandCounts[id];
        if (!info) return null;
        if (Number.isFinite(info.remaining)) return info.remaining;
        if (Number.isFinite(info.initialEstimate) && Number.isFinite(info.reveals)) {
          return Math.max(info.initialEstimate - info.reveals, 0);
        }
        return null;
      };

      const mustCapacityRemaining = Object.create(null);
      for (const id of opponents) {
        const cap = estimateRemaining(id);
        if (Number.isFinite(cap) && cap >= 0) {
          mustCapacityRemaining[id] = Math.floor(cap);
        } else {
          mustCapacityRemaining[id] = Infinity;
        }
      }

      for (const entry of deck) {
        if (!entry) continue;
        if (entry.state !== 'unknown' || entry.played || entry.inMyHand) continue;

        const support = [];
        const fallbackPool = [];
        for (const opponentId of opponents) {
          const wInfo = resolveBeliefWeight(opponentId);
          if (!wInfo) continue;
          if (wInfo.weight > 0) {
            support.push({ id: opponentId, weight: wInfo.weight });
          } else if (!wInfo.hardZero) {
            fallbackPool.push(opponentId);
          }
        }

        if (!support.length) {
          if (!fallbackPool.length) continue;
          const share = 1 / fallbackPool.length;
          const belief = Object.create(null);
          for (const opponentId of fallbackPool) {
            belief[opponentId] = share;
          }
          cardBeliefs[entry.card] = belief;
          continue;
        }

        let totalWeight = 0;
        for (const item of support) totalWeight += item.weight;

        if (!(totalWeight > 0)) {
          if (!fallbackPool.length) continue;
          const share = 1 / fallbackPool.length;
          const belief = Object.create(null);
          for (const opponentId of fallbackPool) {
            belief[opponentId] = share;
          }
          cardBeliefs[entry.card] = belief;
          continue;
        }

        const belief = Object.create(null);
        for (const item of support) {
          belief[item.id] = item.weight / totalWeight;
        }
        cardBeliefs[entry.card] = belief;

        const positiveIds = [];
        const eligiblePositiveIds = [];
        for (const opponentId of opponents) {
          const weight = belief?.[opponentId];
          if (!Number.isFinite(weight) || weight <= 0) continue;
          positiveIds.push(opponentId);
          const remainingCap = mustCapacityRemaining[opponentId];
          if (!(Number.isFinite(remainingCap) && remainingCap <= 0)) {
            eligiblePositiveIds.push(opponentId);
          }
        }

        const eligibleSet = new Set(eligiblePositiveIds);
        for (const opponentId of opponents) {
          if (eligibleSet.has(opponentId)) continue;
          const remainingCap = mustCapacityRemaining[opponentId];
          const noCapacity = Number.isFinite(remainingCap) && remainingCap <= 0;
          const weightInfo = resolveBeliefWeight(opponentId);
          const definitiveZero = !!(weightInfo && weightInfo.hardZero);
          if ((noCapacity || definitiveZero) && knowledgeByPlayer[opponentId]) {
            knowledgeByPlayer[opponentId].forbid.push(entry.card);
          }
        }

        if (eligiblePositiveIds.length === 1) {
          const onlyId = eligiblePositiveIds[0];
          const remainingCap = mustCapacityRemaining[onlyId];
          const canAssignMust = !(Number.isFinite(remainingCap) && remainingCap <= 0);
          if (knowledgeByPlayer[onlyId] && canAssignMust) {
            knowledgeByPlayer[onlyId].must.push(entry.card);
            if (Number.isFinite(remainingCap)) {
              mustCapacityRemaining[onlyId] = Math.max(0, remainingCap - 1);
            }
          }
        }
      }

      for (const id of opponents) {
        const info = knowledgeByPlayer[id];
        if (!info) continue;
        if (info.must.length) {
          const unique = Array.from(new Set(info.must));
          unique.sort((a, b) => a - b);
          info.must = unique;
        } else {
          delete info.must;
        }
        if (info.forbid.length) {
          const unique = Array.from(new Set(info.forbid));
          unique.sort((a, b) => a - b);
          info.forbid = unique;
        } else {
          delete info.forbid;
        }
        if (!info.must && !info.forbid) {
          delete knowledgeByPlayer[id];
        }
      }
    }

    const normalizedKnowledge = Object.keys(knowledgeByPlayer).length ? knowledgeByPlayer : null;

    const canonical = {
      mySeatIndex: (mySeatIndex >= 0) ? mySeatIndex : null,
      myPlayerId: myId,
      players,
      playerOrder: baseIds,
      rows,
      rowBgaNums,
      hand,
      deck,
      opponentHandCounts,
      cardBeliefs,
      knowledgeByPlayer: normalizedKnowledge,
      roundRevealCounts: revealSnapshot,
      meta,
      initialHandCount: Number.isFinite(initialHandCount) ? initialHandCount : null,
      generatedAt: Date.now()
    };

    canonicalStateCache = canonical;
    return canonical;
  }

  // ---------- Solver / ISMCTS ----------
  // === Coordination & lifecycle ===
  function clearSolverCache() {
    if (solverCoordinator) {
      solverCoordinator.reset();
    }
  }

  // === Shared placement heuristics (mirrored in worker) ===
  const BULL_HEADS = (() => {
    const arr = new Array(CARD_COUNT + 1).fill(1);
    arr[0] = 0;
    for (let i = 1; i <= CARD_COUNT; i++) {
      let bulls = 1;
      if (i === 55) {
        bulls = 7;
      } else if (i % 11 === 0) {
        bulls = 5;
      } else if (i % 10 === 0) {
        bulls = 3;
      } else if (i % 5 === 0) {
        bulls = 2;
      }
      arr[i] = bulls;
    }
    return arr;
  })();

  function getBullHeads(card) {
    return BULL_HEADS[card] || 0;
  }

  function sumRowBullHeads(row) {
    if (!row || !row.length) return 0;
    let total = 0;
    for (let i = 0; i < row.length; i++) {
      total += getBullHeads(row[i]);
    }
    return total;
  }

  function findRowForCard(rows, card) {
    if (!rows || !rows.length) {
      return { rowIdx: -1, forcedTake: true, diff: null, rowLen: 0, rowBullSum: 0 };
    }

    let bestIdx = -1;
    let bestDiff = Infinity;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !row.length) continue;
      const end = row[row.length - 1];
      if (card > end) {
        const diff = card - end;
        if (diff < bestDiff) {
          bestDiff = diff;
          bestIdx = i;
        } else if (diff === bestDiff && bestIdx !== -1) {
          const prev = rows[bestIdx];
          const prevEnd = prev?.[prev.length - 1] ?? -Infinity;
          if (end > prevEnd) bestIdx = i;
        }
      }
    }

    if (bestIdx !== -1) {
      const target = rows[bestIdx] || [];
      return {
        rowIdx: bestIdx,
        forcedTake: false,
        diff: bestDiff,
        rowLen: target.length,
        rowBullSum: sumRowBullHeads(target)
      };
    }

    const forcedOptions = [];
    let takeIdx = -1;
    let minBull = Infinity;
    let minEnd = Infinity;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || [];
      const bulls = sumRowBullHeads(row);
      forcedOptions.push({ rowIdx: i, rowLen: row.length, rowBullSum: bulls });
      const end = row[row.length - 1];
      const endValue = end == null ? Infinity : end;
      if (bulls < minBull - 1e-9) {
        minBull = bulls;
        takeIdx = i;
        minEnd = endValue;
      } else if (Math.abs(bulls - minBull) < 1e-9 && endValue < minEnd - 1e-9) {
        takeIdx = i;
        minEnd = endValue;
      }
    }

    if (takeIdx === -1 && forcedOptions.length) {
      takeIdx = forcedOptions[0].rowIdx;
      minBull = forcedOptions[0].rowBullSum;
    }

    const chosen = rows[takeIdx] || [];
    return {
      rowIdx: takeIdx,
      forcedTake: true,
      diff: null,
      rowLen: chosen.length,
      rowBullSum: sumRowBullHeads(chosen),
      forcedOptions
    };
  }

  function resolvePlacement(rows, card, forcedRowIdxOrOpts) {
    if (!rows || !rows.length) {
      return { rows: [[card]], bulls: 0, forcedTake: true, rowIdx: 0, diff: null };
    }

    let forcedRowIdx = null;
    let placement = null;
    if (typeof forcedRowIdxOrOpts === "number") {
      forcedRowIdx = forcedRowIdxOrOpts;
    } else if (forcedRowIdxOrOpts && typeof forcedRowIdxOrOpts === "object") {
      if (Number.isFinite(forcedRowIdxOrOpts.forcedRowIdx)) {
        forcedRowIdx = forcedRowIdxOrOpts.forcedRowIdx;
      }
      if (forcedRowIdxOrOpts.placement) {
        placement = forcedRowIdxOrOpts.placement;
      }
    }

    if (!placement || !Number.isFinite(placement.rowIdx)) {
      placement = findRowForCard(rows, card);
    }
    const nextRows = [];
    for (let i = 0; i < rows.length; i++) {
      nextRows.push(rows[i] ? rows[i].slice() : []);
    }

    let targetIdx = placement.rowIdx ?? -1;
    if (placement.forcedTake) {
      if (Number.isFinite(forcedRowIdx) && forcedRowIdx >= 0 && forcedRowIdx < nextRows.length) {
        targetIdx = forcedRowIdx;
      } else if (!(targetIdx >= 0 && targetIdx < nextRows.length)) {
        const fallback = placement.forcedOptions && placement.forcedOptions[0];
        if (fallback && Number.isFinite(fallback.rowIdx)) {
          targetIdx = fallback.rowIdx;
        }
      }
    }

    let bulls = 0;
    if (targetIdx >= 0 && targetIdx < nextRows.length && nextRows[targetIdx]) {
      const targetRow = nextRows[targetIdx];
      const takeRow = placement.forcedTake || targetRow.length >= 5;
      if (takeRow) {
        bulls = sumRowBullHeads(targetRow);
        nextRows[targetIdx] = [card];
      } else {
        targetRow.push(card);
      }
    } else {
      nextRows.push([card]);
      targetIdx = nextRows.length - 1;
    }

    return {
      rows: nextRows,
      bulls,
      forcedTake: placement.forcedTake,
      rowIdx: targetIdx,
      diff: placement.forcedTake ? null : placement.diff
    };
  }

  function applyPlacementAndScore(rows, card, playerId, scoreMap, forcedRowIdxOrOpts) {
    const result = resolvePlacement(rows, card, forcedRowIdxOrOpts);
    if (playerId != null && scoreMap) {
      scoreMap[playerId] = (scoreMap[playerId] || 0) + result.bulls;
    }
    return result;
  }

  // === State inference helpers ===
  function deriveInitialHandSize(state) {
    if (!state) return null;
    if (Number.isFinite(state.initialHandCount)) return state.initialHandCount;
    const myId = state.myPlayerId;
    if (!myId) return null;
    const handSize = Array.isArray(state.hand) ? state.hand.length : 0;
    const reveals = state.roundRevealCounts?.[myId];
    if (Number.isFinite(handSize) && Number.isFinite(reveals)) {
      return handSize + reveals;
    }
    return null;
  }

  function computeRemainingForPlayer(state, playerId, fallbackInitial) {
    if (!state || !playerId) return null;
    const info = state.opponentHandCounts?.[playerId];
    if (info) {
      if (Number.isFinite(info.remaining)) return info.remaining;
      if (Number.isFinite(info.fromBga)) return info.fromBga;
      if (Number.isFinite(info.initialEstimate) && Number.isFinite(info.reveals)) {
        return Math.max(info.initialEstimate - info.reveals, 0);
      }
    }
    const reveals = state.roundRevealCounts?.[playerId];
    if (Number.isFinite(fallbackInitial) && Number.isFinite(reveals)) {
      return Math.max(fallbackInitial - reveals, 0);
    }
    return null;
  }

  function computeSolverSignature(state) {
    if (!state) return null;

    const numVal = (val) => (Number.isFinite(val) ? String(val) : 'x');
    const strVal = (val) => (val == null ? '' : String(val));
    const boolVal = (val) => (val ? '1' : '0');

    const parts = [];
    parts.push(`me:${strVal(state.myPlayerId)}:${numVal(state.mySeatIndex)}`);
    parts.push(`init:${numVal(state.initialHandCount)}`);

    if (Array.isArray(state.hand)) {
      const sortedHand = state.hand.slice().sort((a, b) => a - b);
      parts.push(`h:${sortedHand.join(',')}`);
    } else {
      parts.push('h:');
    }

    if (Array.isArray(state.rows)) {
      const rowParts = state.rows.map(row =>
        Array.isArray(row) ? row.join(',') : ''
      );
      parts.push(`r:${rowParts.join('|')}`);
    } else {
      parts.push('r:');
    }

    if (Array.isArray(state.rowBgaNums)) {
      parts.push(`rb:${state.rowBgaNums.join(',')}`);
    } else {
      parts.push('rb:');
    }

    if (Array.isArray(state.deck)) {
      const deckParts = state.deck.map(entry => {
        const cardVal = Number.isFinite(entry?.card) ? entry.card : 'x';
        const stateVal = entry?.state || '';
        const playedVal = entry?.played ? '1' : '0';
        const handVal = entry?.inMyHand ? '1' : '0';
        return `${cardVal}:${stateVal}:${playedVal}:${handVal}`;
      });
      parts.push(`d:${deckParts.join('|')}`);
    } else {
      parts.push('d:');
    }

    if (Array.isArray(state.playerOrder)) {
      parts.push(`o:${state.playerOrder.join(',')}`);
    } else {
      parts.push('o:');
    }

    if (Array.isArray(state.players)) {
      const playerParts = state.players
        .slice()
        .sort((a, b) => strVal(a?.id).localeCompare(strVal(b?.id)))
        .map(p => [
          strVal(p?.id),
          numVal(p?.seat),
          boolVal(p?.isYou),
          numVal(p?.reveals),
          numVal(p?.handCount),
          numVal(p?.bulls)
        ].join(':'));
      parts.push(`p:${playerParts.join('|')}`);
    } else {
      parts.push('p:');
    }

    if (state.opponentHandCounts && typeof state.opponentHandCounts === 'object') {
      const oppParts = Object.keys(state.opponentHandCounts)
        .sort()
        .map(id => {
          const info = state.opponentHandCounts[id] || {};
          return [
            strVal(id),
            numVal(info.remaining),
            numVal(info.reveals),
            strVal(info.source),
            numVal(info.fromBga),
            numVal(info.initialEstimate)
          ].join(':');
        });
      parts.push(`oc:${oppParts.join('|')}`);
    } else {
      parts.push('oc:');
    }

    if (state.roundRevealCounts && typeof state.roundRevealCounts === 'object') {
      const revealParts = Object.keys(state.roundRevealCounts)
        .sort()
        .map(id => {
          const val = state.roundRevealCounts[id];
          return `${strVal(id)}:${numVal(val)}`;
        });
      parts.push(`rc:${revealParts.join('|')}`);
    } else {
      parts.push('rc:');
    }

    if (state.cardBeliefs && typeof state.cardBeliefs === 'object') {
      const beliefParts = Object.keys(state.cardBeliefs)
        .map(card => Number(card))
        .filter(card => Number.isFinite(card))
        .sort((a, b) => a - b)
        .map(card => {
          const entries = state.cardBeliefs[card] || {};
          const inner = Object.keys(entries)
            .map(id => id)
            .sort((a, b) => String(a).localeCompare(String(b)))
            .map(id => `${strVal(id)}:${numVal(entries[id])}`)
            .join(',');
          return `${card}:${inner}`;
        });
      parts.push(`cb:${beliefParts.join('|')}`);
    } else {
      parts.push('cb:');
    }

    if (state.knowledgeByPlayer && typeof state.knowledgeByPlayer === 'object') {
      const knowledgeParts = Object.keys(state.knowledgeByPlayer)
        .sort((a, b) => String(a).localeCompare(String(b)))
        .map(id => {
          const info = state.knowledgeByPlayer[id] || {};
          const must = Array.isArray(info.must) ? info.must.slice().sort((a, b) => a - b) : [];
          const forbid = Array.isArray(info.forbid) ? info.forbid.slice().sort((a, b) => a - b) : [];
          return `${strVal(id)}:${must.join(',')}:${forbid.join(',')}`;
        });
      parts.push(`kp:${knowledgeParts.join('|')}`);
    } else {
      parts.push('kp:');
    }

    return parts.join('||');
  }

  function createRng(seed) {
    let t = seed >>> 0;
    if (!t) t = 0x9e3779b9;
    return function rng() {
      t += 0x6D2B79F5;
      let x = t;
      x = Math.imul(x ^ (x >>> 15), 1 | x);
      x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffleInPlace(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  // === Simulation & playout ===
  function sampleDeterminization(state, rng = Math.random) {
    if (!state) return null;
    const opponents = (state.players || []).filter(p => !p.isYou);
    const unknownCards = [];
    for (const entry of state.deck || []) {
      if (!entry) continue;
      if (entry.state === 'unknown' && !entry.played && !entry.inMyHand) {
        unknownCards.push(entry.card);
      }
    }

    const fallbackInitial = deriveInitialHandSize(state);
    const wants = [];
    let fixedTotal = 0;
    for (const opp of opponents) {
      const need = computeRemainingForPlayer(state, opp.id, fallbackInitial);
      if (Number.isFinite(need)) {
        const clamped = Math.max(0, Math.min(need, CARD_COUNT));
        wants.push({ id: opp.id, need: clamped });
        fixedTotal += clamped;
      } else {
        wants.push({ id: opp.id, need: null });
      }
    }

    if (unknownCards.length < fixedTotal) return null;

    const unspecified = wants.filter(w => w.need == null);
    let remaining = unknownCards.length - fixedTotal;
    if (unspecified.length) {
      const base = Math.floor(remaining / unspecified.length);
      let extras = remaining - base * unspecified.length;
      for (const w of unspecified) {
        let assign = Math.max(0, base);
        if (extras > 0) {
          assign++;
          extras--;
        }
        w.need = assign;
        fixedTotal += assign;
      }
      remaining = unknownCards.length - fixedTotal;
    }

    const beliefs = state.cardBeliefs || null;
    const knowledgeSource = state.knowledgeByPlayer || null;
    const knowledgeSets = Object.create(null);
    for (const opp of opponents) {
      const info = knowledgeSource?.[opp.id] || null;
      const mustArr = Array.isArray(info?.must) ? info.must.filter(n => Number.isFinite(n)) : [];
      const forbidArr = Array.isArray(info?.forbid) ? info.forbid.filter(n => Number.isFinite(n)) : [];
      knowledgeSets[opp.id] = {
        must: mustArr.length ? new Set(mustArr) : null,
        forbid: forbidArr.length ? new Set(forbidArr) : null
      };
    }

    const globalMustSet = new Set();
    const validUnknown = new Set(unknownCards);
    const hands = Object.create(null);
    for (const w of wants) {
      const normalizedNeed = Number.isFinite(w.need) ? Math.max(0, Math.floor(w.need)) : 0;
      const knowledge = knowledgeSets[w.id];
      let mustList = knowledge?.must ? Array.from(knowledge.must).filter(card => validUnknown.has(card)) : [];
      if (normalizedNeed <= 0 || !mustList.length) {
        mustList = [];
      } else if (mustList.length > normalizedNeed) {
        mustList = mustList.slice(0, normalizedNeed);
      }
      for (const card of mustList) {
        globalMustSet.add(card);
        validUnknown.delete(card);
      }
      const appliedMust = mustList.sort((a, b) => a - b);
      w.must = appliedMust;
      w.need = Math.max(0, normalizedNeed - appliedMust.length);
      hands[w.id] = appliedMust.slice();
    }

    const remainingCards = unknownCards.filter(card => !globalMustSet.has(card));
    const shuffled = shuffleInPlace(remainingCards, rng);
    const pool = [];

    const pickTargetForCard = (card) => {
      let total = 0;
      const entries = [];
      const belief = beliefs ? beliefs[card] : null;
      for (const w of wants) {
        if (!w || w.need <= 0) continue;
        const knowledge = knowledgeSets[w.id];
        if (knowledge?.forbid && knowledge.forbid.has(card)) continue;
        let weight = 1;
        if (belief && belief[w.id] != null) {
          const val = Number(belief[w.id]);
          if (Number.isFinite(val) && val > 0) weight = val;
        }
        weight *= w.need;
        if (weight <= 0) continue;
        entries.push({ w, weight });
        total += weight;
      }
      if (total <= 0 || !entries.length) return null;
      let pick = rng() * total;
      if (!Number.isFinite(pick)) pick = total * 0.5;
      for (const entry of entries) {
        pick -= entry.weight;
        if (pick <= 0) return entry.w;
      }
      return entries[entries.length - 1].w;
    };

    for (const card of shuffled) {
      const target = pickTargetForCard(card);
      if (!target) {
        pool.push(card);
        continue;
      }
      (hands[target.id] ||= []).push(card);
      target.need = Math.max(0, (target.need || 0) - 1);
    }

    let shortage = false;
    for (const w of wants) {
      if (!w) continue;
      let need = Math.max(0, Math.floor(w.need || 0));
      const assigned = hands[w.id] || [];
      while (need > 0 && pool.length) {
        assigned.push(pool.pop());
        need--;
      }
      if (need > 0) {
        shortage = true;
        break;
      }
      assigned.sort((a, b) => a - b);
      hands[w.id] = assigned;
      w.need = need;
    }

    if (shortage) return null;

    if (pool.length) {
      const assignFallback = (card) => {
        const candidates = [];
        const belief = beliefs ? beliefs[card] : null;
        for (const w of wants) {
          if (!w) continue;
          const knowledge = knowledgeSets[w.id];
          if (knowledge?.forbid && knowledge.forbid.has(card)) continue;
          let weight = 1;
          if (belief && belief[w.id] != null) {
            const val = Number(belief[w.id]);
            if (Number.isFinite(val) && val > 0) weight = val;
          }
          if (!(weight > 0)) weight = 1e-3;
          candidates.push({ target: w, weight });
        }
        if (!candidates.length) return;
        let total = 0;
        for (const cand of candidates) total += cand.weight;
        if (!(total > 0)) total = candidates.length;
        let pick = rng() * total;
        if (!Number.isFinite(pick)) pick = total * 0.5;
        let chosen = candidates[candidates.length - 1].target;
        for (const cand of candidates) {
          pick -= cand.weight;
          if (pick <= 0) {
            chosen = cand.target;
            break;
          }
        }
        const list = (hands[chosen.id] ||= []);
        list.push(card);
      };

      while (pool.length) {
        const card = pool.pop();
        assignFallback(card);
      }
    }

    for (const id of Object.keys(hands)) {
      const list = hands[id];
      if (Array.isArray(list) && list.length > 1) {
        list.sort((a, b) => a - b);
      }
    }

    return { hands, pool: [] };
  }

  function previewPlacement(rows, card) {
    const placement = findRowForCard(rows, card);
    const options = [];
    if (placement.forcedTake) {
      const forced = placement.forcedOptions || [];
      if (forced.length) {
        for (let i = 0; i < forced.length; i++) {
          const option = forced[i];
          options.push({
            rowIdx: option.rowIdx,
            forcedTake: true,
            bulls: option.rowBullSum,
            diff: null
          });
        }
      } else {
        options.push({
          rowIdx: placement.rowIdx ?? -1,
          forcedTake: true,
          bulls: placement.rowBullSum ?? 0,
          diff: null
        });
      }
    } else {
      const rowLen = placement.rowLen;
      const bulls = rowLen >= 5 ? placement.rowBullSum : 0;
      options.push({
        rowIdx: placement.rowIdx,
        forcedTake: false,
        bulls,
        diff: placement.diff
      });
    }
    return {
      ...placement,
      options
    };
  }

  function evaluateCardPlacement(rows, card) {
    const placement = previewPlacement(rows, card);
    const options = placement?.options || [];
    if (!options.length) return null;

    let bestOption = null;
    let bestScore = Infinity;
    for (const opt of options) {
      const row = rows?.[opt.rowIdx] || [];
      const rowLen = row.length || 0;
      let score = Number.isFinite(opt.bulls) ? opt.bulls : 0;

      if (opt.forcedTake) {
        score += 8 + rowLen * 0.25;
      } else {
        const diff = Number.isFinite(opt.diff) ? opt.diff : 0;
        score += diff * 0.015;
        if (rowLen >= 4) score += 1.35;
        else if (rowLen === 0) score -= 0.4;
        else if (rowLen === 1) score -= 0.15;
        score += rowLen * 0.05;
      }

      if (score < bestScore) {
        bestScore = score;
        bestOption = opt;
      }
    }

    return bestOption ? { placement, bestOption, score: bestScore } : null;
  }

  function pickForcedRowIndex(placement, rows) {
    const options = placement?.options || [];
    if (!options.length) return null;

    let bestIdx = null;
    let bestScore = Infinity;
    for (const opt of options) {
      if (!Number.isFinite(opt.rowIdx)) continue;
      const row = rows?.[opt.rowIdx] || [];
      const bulls = Number.isFinite(opt.bulls) ? opt.bulls : 0;
      const rowLen = row.length || 0;
      const tail = row[row.length - 1];
      let score = bulls + rowLen * 0.05;
      if (Number.isFinite(tail)) score += tail * 0.001;
      if (score < bestScore) {
        bestScore = score;
        bestIdx = opt.rowIdx;
      }
    }

    return Number.isFinite(bestIdx) ? bestIdx : null;
  }

  function chooseCardHeuristic(hand, rows, rng, opts = {}) {
    if (!hand || !hand.length) return null;
    const epsilon = Number.isFinite(opts.epsilon) ? Math.max(0, Math.min(opts.epsilon, 1)) : 0.12;
    const scored = [];

    for (let i = 0; i < hand.length; i++) {
      const card = hand[i];
      const evalInfo = evaluateCardPlacement(rows, card);
      if (!evalInfo) continue;
      const jitter = (rng() - 0.5) * 0.001;
      scored.push({ card, score: evalInfo.score + jitter });
    }

    if (!scored.length) return null;

    scored.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      return a.card - b.card;
    });

    const bestScore = scored[0].score;
    const tolerance = 0.12;
    const topGroup = scored.filter(entry => entry.score <= bestScore + tolerance);

    let pickEntry;
    if (rng() < epsilon && scored.length > 1) {
      const span = Math.min(4, scored.length);
      let idx = Math.floor(rng() * span);
      if (!Number.isFinite(idx) || idx < 0) idx = 0;
      if (idx >= scored.length) idx = scored.length - 1;
      pickEntry = scored[idx];
    } else {
      let idx = Math.floor(rng() * topGroup.length);
      if (!Number.isFinite(idx) || idx < 0) idx = 0;
      if (idx >= topGroup.length) idx = topGroup.length - 1;
      pickEntry = topGroup[idx];
    }

    return pickEntry ? pickEntry.card : null;
  }

  function simulatePlayout(state, determinization, rootCard, rng) {
    if (!state || !Array.isArray(state.rows) || !state.rows.length) return null;
    const myId = state.myPlayerId;
    if (!myId) return null;
    const players = (Array.isArray(state.playerOrder) && state.playerOrder.length)
      ? state.playerOrder.slice()
      : (state.players || []).map(p => p.id);
    if (!players.length) return null;

    let rows = state.rows.map(r => (Array.isArray(r) ? r.slice() : []));
    const hands = new Map();
    const myHand = (state.hand || []).slice().sort((a, b) => a - b);
    const forcedIdx = myHand.indexOf(rootCard);
    if (forcedIdx === -1) return null;
    myHand.splice(forcedIdx, 1);
    hands.set(myId, myHand);

    for (const id of players) {
      if (id === myId) continue;
      const sample = (determinization?.hands?.[id] || []).slice().sort((a, b) => a - b);
      hands.set(id, sample);
    }

    const seatIndex = new Map();
    for (let i = 0; i < players.length; i++) seatIndex.set(players[i], i);

  const bullsByPlayer = Object.create(null);
  for (const id of players) bullsByPlayer[id] = 0;

  let forcedCardPending = true;
  let rootResolved = false;
  let immediatePenalty = null;
    let turns = 0;
    const maxTurns = 200;

    while (turns++ < maxTurns) {
      const plays = [];
      let anyPlay = false;

      for (const id of players) {
        const hand = hands.get(id) || [];
        let card = null;
        if (id === myId) {
          if (forcedCardPending) {
            card = rootCard;
            forcedCardPending = false;
          } else if (hand.length) {
            card = chooseCardHeuristic(hand, rows, rng, { epsilon: 0.08 });
            if (card != null) {
              const idx = hand.indexOf(card);
              if (idx >= 0) hand.splice(idx, 1);
            }
          }
        } else if (hand.length) {
          card = chooseCardHeuristic(hand, rows, rng, { epsilon: 0.18 });
          if (card != null) {
            const idx = hand.indexOf(card);
            if (idx >= 0) hand.splice(idx, 1);
          }
        }
        if (card != null) {
          plays.push({ playerId: id, card });
          anyPlay = true;
        }
      }

      if (!anyPlay) break;

      plays.sort((a, b) => {
        if (a.card !== b.card) return a.card - b.card;
        return (seatIndex.get(a.playerId) || 0) - (seatIndex.get(b.playerId) || 0);
      });

      for (const play of plays) {
        const placement = previewPlacement(rows, play.card);
        let forcedRowIdx = null;
        if (placement?.forcedTake) {
          forcedRowIdx = pickForcedRowIndex(placement, rows);
        }
        const res = applyPlacementAndScore(
          rows,
          play.card,
          play.playerId,
          bullsByPlayer,
          { forcedRowIdx, placement }
        );
        rows = res.rows;
        if (play.playerId === myId && !rootResolved) {
          rootResolved = true;
        }
      }

      if (rootResolved && immediatePenalty == null) {
        immediatePenalty = Math.max(0, bullsByPlayer[myId] || 0);
      }
    }

    const totalPenalty = Math.max(0, bullsByPlayer[myId] || 0);
    if (immediatePenalty == null) immediatePenalty = totalPenalty;
    const futurePenalty = Math.max(totalPenalty - immediatePenalty, 0);
    return {
      reward: -totalPenalty,
      immediatePenalty,
      futurePenalty
    };
  }

  const PUCT_EXPLORATION = 1.15;

  function createNode(card, prior = 0) {
    return {
      card,
      prior,
      visitCount: 0,
      totalReward: 0,
      totalImmediate: 0,
      totalFuture: 0,
      children: new Map()
    };
  }

  function selectChild(node, rng) {
    if (!node?.children?.size) return null;
    const parentVisits = Math.max(1, node.visitCount);
    let best = null;
    let bestScore = -Infinity;
    for (const child of node.children.values()) {
      const prior = Number.isFinite(child.prior) ? child.prior : 0;
      const mean = child.visitCount > 0 ? (child.totalReward / child.visitCount) : 0;
      const exploration = PUCT_EXPLORATION * prior * Math.sqrt(parentVisits) / (1 + child.visitCount);
      const noise = (rng() - 0.5) * 1e-6;
      const score = mean + exploration + noise;
      if (score > bestScore) {
        bestScore = score;
        best = child;
      }
    }
    return best;
  }

  function runIsmctsRecommendation(state, opts = {}) {
    if (!state || !Array.isArray(state.hand) || !state.hand.length) return null;
    if (!Array.isArray(state.rows) || !state.rows.length) return null;

    const iterations = opts.iterations ?? Math.max(80, state.hand.length * 20);
    const rng = opts.rng || createRng((Date.now() ^ (state.hand.length * 131)) >>> 0);

    const root = createNode(null, 1);
    const prior = state.hand.length ? 1 / state.hand.length : 0;
    for (const card of state.hand) {
      root.children.set(card, createNode(card, prior));
    }

    let completed = 0;
    let attempts = 0;
    const maxAttempts = iterations * 6;

    while (completed < iterations && attempts < maxAttempts) {
      attempts++;
      const determinization = sampleDeterminization(state, rng);
      if (!determinization) continue;
      const child = selectChild(root, rng);
      if (!child) break;
      const outcome = simulatePlayout(state, determinization, child.card, rng);
      if (!outcome || !Number.isFinite(outcome.reward)) continue;
      const { reward, immediatePenalty = 0, futurePenalty = 0 } = outcome;
      child.visitCount += 1;
  child.totalReward = (child.totalReward || 0) + reward;
  child.totalImmediate = (child.totalImmediate || 0) + immediatePenalty;
  child.totalFuture = (child.totalFuture || 0) + futurePenalty;
  root.visitCount += 1;
  root.totalReward = (root.totalReward || 0) + reward;
  root.totalImmediate = (root.totalImmediate || 0) + immediatePenalty;
  root.totalFuture = (root.totalFuture || 0) + futurePenalty;
      completed++;
    }

    const results = [];
    for (const [card, node] of root.children.entries()) {
      if (node.visitCount > 0 && Number.isFinite(node.totalReward)) {
        const immediateAvg = node.totalImmediate / node.visitCount;
        const futureAvg = node.totalFuture / node.visitCount;
        const expected = immediateAvg + futureAvg;
        results.push({
          card,
          expectedBulls: expected,
          expectedImmediate: immediateAvg,
          expectedFuture: futureAvg,
          visitCount: node.visitCount
        });
      } else {
        results.push({
          card,
          expectedBulls: null,
          expectedImmediate: null,
          expectedFuture: null,
          visitCount: node.visitCount || 0
        });
      }
    }

    if (completed === 0 && !results.some(r => r.expectedBulls != null)) {
      return { results, best: null, iterations: 0 };
    }

    results.sort((a, b) => {
      if (a.expectedBulls != null && b.expectedBulls != null) {
        if (a.expectedBulls !== b.expectedBulls) return a.expectedBulls - b.expectedBulls;
        return a.card - b.card;
      }
      if (a.expectedBulls != null) return -1;
      if (b.expectedBulls != null) return 1;
      return a.card - b.card;
    });

    const best = results.find(r => r.expectedBulls != null) || null;
    return { results, best, iterations: completed };
  }

  /**
   * Inline worker source builder.
   *
   * Helpers mirrored inside this string literal must stay in lockstep with the
   * main-thread implementations defined above: `getBullHeads`,
   * `sumRowBullHeads`, `findRowForCard`, `resolvePlacement`,
   * `applyPlacementAndScore`, `deriveInitialHandSize`,
   * `computeRemainingForPlayer`, `createRng`, `shuffleInPlace`,
  * `sampleDeterminization`, `previewPlacement`, `evaluateCardPlacement`,
  * `pickForcedRowIndex`, `chooseCardHeuristic`,
   * `simulatePlayout`, `createNode`, `selectChild`, `flushProgress`,
   * `recordDelta`, and `runIterations`. When adding new shared logic, update the
   * shared helper section first and mirror the changes here before stringifying.
   */
  function buildSolverWorkerSource() {
    return `
'use strict';
const CARD_COUNT = ${CARD_COUNT};
const BULL_HEADS = (() => {
  const arr = new Array(CARD_COUNT + 1).fill(1);
  arr[0] = 0;
  for (let i = 1; i <= CARD_COUNT; i++) {
    let bulls = 1;
    if (i === 55) {
      bulls = 7;
    } else if (i % 11 === 0) {
      bulls = 5;
    } else if (i % 10 === 0) {
      bulls = 3;
    } else if (i % 5 === 0) {
      bulls = 2;
    }
    arr[i] = bulls;
  }
  return arr;
})();
function getBullHeads(card) {
  return BULL_HEADS[card] || 0;
}
function sumRowBullHeads(row) {
  if (!row || !row.length) return 0;
  let total = 0;
  for (let i = 0; i < row.length; i++) {
    total += getBullHeads(row[i]);
  }
  return total;
}
function findRowForCard(rows, card) {
  if (!rows || !rows.length) {
    return { rowIdx: -1, forcedTake: true, diff: null, rowLen: 0, rowBullSum: 0 };
  }

  let bestIdx = -1;
  let bestDiff = Infinity;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row.length) continue;
    const end = row[row.length - 1];
    if (card > end) {
      const diff = card - end;
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      } else if (diff === bestDiff && bestIdx !== -1) {
        const prev = rows[bestIdx];
        const prevEnd = prev?.[prev.length - 1] ?? -Infinity;
        if (end > prevEnd) bestIdx = i;
      }
    }
  }

  if (bestIdx !== -1) {
    const target = rows[bestIdx] || [];
    return {
      rowIdx: bestIdx,
      forcedTake: false,
      diff: bestDiff,
      rowLen: target.length,
      rowBullSum: sumRowBullHeads(target)
    };
  }

  const forcedOptions = [];
  let takeIdx = -1;
  let minBull = Infinity;
  let minEnd = Infinity;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || [];
    const bulls = sumRowBullHeads(row);
    forcedOptions.push({ rowIdx: i, rowLen: row.length, rowBullSum: bulls });
    const end = row[row.length - 1];
    const endValue = end == null ? Infinity : end;
    if (bulls < minBull - 1e-9) {
      minBull = bulls;
      takeIdx = i;
      minEnd = endValue;
    } else if (Math.abs(bulls - minBull) < 1e-9 && endValue < minEnd - 1e-9) {
      takeIdx = i;
      minEnd = endValue;
    }
  }

  if (takeIdx === -1 && forcedOptions.length) {
    takeIdx = forcedOptions[0].rowIdx;
    minBull = forcedOptions[0].rowBullSum;
  }

  const chosen = rows[takeIdx] || [];
  return {
    rowIdx: takeIdx,
    forcedTake: true,
    diff: null,
    rowLen: chosen.length,
    rowBullSum: sumRowBullHeads(chosen),
    forcedOptions
  };
}
function resolvePlacement(rows, card, forcedRowIdxOrOpts) {
  if (!rows || !rows.length) {
    return { rows: [[card]], bulls: 0, forcedTake: true, rowIdx: 0, diff: null };
  }

  let forcedRowIdx = null;
  let placement = null;
  if (typeof forcedRowIdxOrOpts === "number") {
    forcedRowIdx = forcedRowIdxOrOpts;
  } else if (forcedRowIdxOrOpts && typeof forcedRowIdxOrOpts === "object") {
    if (Number.isFinite(forcedRowIdxOrOpts.forcedRowIdx)) {
      forcedRowIdx = forcedRowIdxOrOpts.forcedRowIdx;
    }
    if (forcedRowIdxOrOpts.placement) {
      placement = forcedRowIdxOrOpts.placement;
    }
  }

  if (!placement || !Number.isFinite(placement.rowIdx)) {
    placement = findRowForCard(rows, card);
  }
  const nextRows = [];
  for (let i = 0; i < rows.length; i++) {
    nextRows.push(rows[i] ? rows[i].slice() : []);
  }

  let targetIdx = placement.rowIdx ?? -1;
  if (placement.forcedTake) {
    if (Number.isFinite(forcedRowIdx) && forcedRowIdx >= 0 && forcedRowIdx < nextRows.length) {
      targetIdx = forcedRowIdx;
    } else if (!(targetIdx >= 0 && targetIdx < nextRows.length)) {
      const fallback = placement.forcedOptions && placement.forcedOptions[0];
      if (fallback && Number.isFinite(fallback.rowIdx)) {
        targetIdx = fallback.rowIdx;
      }
    }
  }

  let bulls = 0;
  if (targetIdx >= 0 && targetIdx < nextRows.length && nextRows[targetIdx]) {
    const targetRow = nextRows[targetIdx];
    const takeRow = placement.forcedTake || targetRow.length >= 5;
    if (takeRow) {
      bulls = sumRowBullHeads(targetRow);
      nextRows[targetIdx] = [card];
    } else {
      targetRow.push(card);
    }
  } else {
    nextRows.push([card]);
    targetIdx = nextRows.length - 1;
  }

  return {
    rows: nextRows,
    bulls,
    forcedTake: placement.forcedTake,
    rowIdx: targetIdx,
    diff: placement.forcedTake ? null : placement.diff
  };
}
function applyPlacementAndScore(rows, card, playerId, scoreMap, forcedRowIdxOrOpts) {
  const result = resolvePlacement(rows, card, forcedRowIdxOrOpts);
  if (playerId != null && scoreMap) {
    scoreMap[playerId] = (scoreMap[playerId] || 0) + result.bulls;
  }
  return result;
}
function deriveInitialHandSize(state) {
  if (!state) return null;
  if (Number.isFinite(state.initialHandCount)) return state.initialHandCount;
  const myId = state.myPlayerId;
  if (!myId) return null;
  const handSize = Array.isArray(state.hand) ? state.hand.length : 0;
  const reveals = state.roundRevealCounts?.[myId];
  if (Number.isFinite(handSize) && Number.isFinite(reveals)) {
    return handSize + reveals;
  }
  return null;
}
function computeRemainingForPlayer(state, playerId, fallbackInitial) {
  if (!state || !playerId) return null;
  const info = state.opponentHandCounts?.[playerId];
  if (info) {
    if (Number.isFinite(info.remaining)) return info.remaining;
    if (Number.isFinite(info.fromBga)) return info.fromBga;
    if (Number.isFinite(info.initialEstimate) && Number.isFinite(info.reveals)) {
      return Math.max(info.initialEstimate - info.reveals, 0);
    }
  }
  const reveals = state.roundRevealCounts?.[playerId];
  if (Number.isFinite(fallbackInitial) && Number.isFinite(reveals)) {
    return Math.max(fallbackInitial - reveals, 0);
  }
  return null;
}
function createRng(seed) {
  let t = seed >>> 0;
  if (!t) t = 0x9e3779b9;
  return function rng() {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), 1 | x);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}
function sampleDeterminization(state, rng) {
  if (!state) return null;
  const opponents = (state.players || []).filter(p => !p.isYou);
  const unknownCards = [];
  for (const entry of state.deck || []) {
    if (!entry) continue;
    if (entry.state === 'unknown' && !entry.played && !entry.inMyHand) {
      unknownCards.push(entry.card);
    }
  }

  const fallbackInitial = deriveInitialHandSize(state);
  const wants = [];
  let fixedTotal = 0;
  for (const opp of opponents) {
    const need = computeRemainingForPlayer(state, opp.id, fallbackInitial);
    if (Number.isFinite(need)) {
      const clamped = Math.max(0, Math.min(need, CARD_COUNT));
      wants.push({ id: opp.id, need: clamped });
      fixedTotal += clamped;
    } else {
      wants.push({ id: opp.id, need: null });
    }
  }

  if (unknownCards.length < fixedTotal) return null;

  const unspecified = wants.filter(w => w.need == null);
  let remaining = unknownCards.length - fixedTotal;
  if (unspecified.length) {
    const base = Math.floor(remaining / unspecified.length);
    let extras = remaining - base * unspecified.length;
    for (const w of unspecified) {
      let assign = Math.max(0, base);
      if (extras > 0) {
        assign++;
        extras--;
      }
      w.need = assign;
      fixedTotal += assign;
    }
    remaining = unknownCards.length - fixedTotal;
  }

  const beliefs = state.cardBeliefs || null;
  const knowledgeSource = state.knowledgeByPlayer || null;
  const knowledgeSets = Object.create(null);
  for (const opp of opponents) {
    const info = knowledgeSource?.[opp.id] || null;
    const mustArr = Array.isArray(info?.must) ? info.must.filter(n => Number.isFinite(n)) : [];
    const forbidArr = Array.isArray(info?.forbid) ? info.forbid.filter(n => Number.isFinite(n)) : [];
    knowledgeSets[opp.id] = {
      must: mustArr.length ? new Set(mustArr) : null,
      forbid: forbidArr.length ? new Set(forbidArr) : null
    };
  }

  const globalMustSet = new Set();
  const validUnknown = new Set(unknownCards);
  const hands = Object.create(null);
  for (const w of wants) {
    const normalizedNeed = Number.isFinite(w.need) ? Math.max(0, Math.floor(w.need)) : 0;
    const knowledge = knowledgeSets[w.id];
    let mustList = knowledge?.must ? Array.from(knowledge.must).filter(card => validUnknown.has(card)) : [];
    if (normalizedNeed <= 0 || !mustList.length) {
      mustList = [];
    } else if (mustList.length > normalizedNeed) {
      mustList = mustList.slice(0, normalizedNeed);
    }
    for (const card of mustList) {
      globalMustSet.add(card);
      validUnknown.delete(card);
    }
    const appliedMust = mustList.sort((a, b) => a - b);
    w.must = appliedMust;
    w.need = Math.max(0, normalizedNeed - appliedMust.length);
    hands[w.id] = appliedMust.slice();
  }

  const remainingCards = unknownCards.filter(card => !globalMustSet.has(card));
  const shuffled = shuffleInPlace(remainingCards, rng);
  const pool = [];

  const pickTargetForCard = (card) => {
    let total = 0;
    const entries = [];
    const belief = beliefs ? beliefs[card] : null;
    for (const w of wants) {
      if (!w || w.need <= 0) continue;
      const knowledge = knowledgeSets[w.id];
      if (knowledge?.forbid && knowledge.forbid.has(card)) continue;
      let weight = 1;
      if (belief && belief[w.id] != null) {
        const val = Number(belief[w.id]);
        if (Number.isFinite(val) && val > 0) weight = val;
      }
      weight *= w.need;
      if (weight <= 0) continue;
      entries.push({ w, weight });
      total += weight;
    }
    if (total <= 0 || !entries.length) return null;
    let pick = rng() * total;
    if (!Number.isFinite(pick)) pick = total * 0.5;
    for (const entry of entries) {
      pick -= entry.weight;
      if (pick <= 0) return entry.w;
    }
    return entries[entries.length - 1].w;
  };

  for (const card of shuffled) {
    const target = pickTargetForCard(card);
    if (!target) {
      pool.push(card);
      continue;
    }
    (hands[target.id] ||= []).push(card);
    target.need = Math.max(0, (target.need || 0) - 1);
  }

  let shortage = false;
  for (const w of wants) {
    if (!w) continue;
    let need = Math.max(0, Math.floor(w.need || 0));
    const assigned = hands[w.id] || [];
    while (need > 0 && pool.length) {
      assigned.push(pool.pop());
      need--;
    }
    if (need > 0) {
      shortage = true;
      break;
    }
    assigned.sort((a, b) => a - b);
    hands[w.id] = assigned;
    w.need = need;
  }

  if (shortage) return null;

  if (pool.length) {
    const assignFallback = (card) => {
      const candidates = [];
      const belief = beliefs ? beliefs[card] : null;
      for (const w of wants) {
        if (!w) continue;
        const knowledge = knowledgeSets[w.id];
        if (knowledge?.forbid && knowledge.forbid.has(card)) continue;
        let weight = 1;
        if (belief && belief[w.id] != null) {
          const val = Number(belief[w.id]);
          if (Number.isFinite(val) && val > 0) weight = val;
        }
        if (!(weight > 0)) weight = 1e-3;
        candidates.push({ target: w, weight });
      }
      if (!candidates.length) return;
      let total = 0;
      for (const cand of candidates) total += cand.weight;
      if (!(total > 0)) total = candidates.length;
      let pick = rng() * total;
      if (!Number.isFinite(pick)) pick = total * 0.5;
      let chosen = candidates[candidates.length - 1].target;
      for (const cand of candidates) {
        pick -= cand.weight;
        if (pick <= 0) {
          chosen = cand.target;
          break;
        }
      }
      const list = (hands[chosen.id] ||= []);
      list.push(card);
    };

    while (pool.length) {
      const card = pool.pop();
      assignFallback(card);
    }
  }

  for (const id in hands) {
    const list = hands[id];
    if (Array.isArray(list) && list.length > 1) {
      list.sort((a, b) => a - b);
    }
  }

  return { hands, pool: [] };
}
function previewPlacement(rows, card) {
  const placement = findRowForCard(rows, card);
  const options = [];
  if (placement.forcedTake) {
    const forced = placement.forcedOptions || [];
    if (forced.length) {
      for (let i = 0; i < forced.length; i++) {
        const option = forced[i];
        options.push({
          rowIdx: option.rowIdx,
          forcedTake: true,
          bulls: option.rowBullSum,
          diff: null
        });
      }
    } else {
      options.push({
        rowIdx: placement.rowIdx ?? -1,
        forcedTake: true,
        bulls: placement.rowBullSum ?? 0,
        diff: null
      });
    }
  } else {
    const rowLen = placement.rowLen;
    const bulls = rowLen >= 5 ? placement.rowBullSum : 0;
    options.push({
      rowIdx: placement.rowIdx,
      forcedTake: false,
      bulls,
      diff: placement.diff
    });
  }
  return {
    ...placement,
    options
  };
}
function evaluateCardPlacement(rows, card) {
  const placement = previewPlacement(rows, card);
  const options = placement?.options || [];
  if (!options.length) return null;

  let bestOption = null;
  let bestScore = Infinity;
  for (const opt of options) {
    const row = rows?.[opt.rowIdx] || [];
    const rowLen = row.length || 0;
    let score = Number.isFinite(opt.bulls) ? opt.bulls : 0;

    if (opt.forcedTake) {
      score += 8 + rowLen * 0.25;
    } else {
      const diff = Number.isFinite(opt.diff) ? opt.diff : 0;
      score += diff * 0.015;
      if (rowLen >= 4) score += 1.35;
      else if (rowLen === 0) score -= 0.4;
      else if (rowLen === 1) score -= 0.15;
      score += rowLen * 0.05;
    }

    if (score < bestScore) {
      bestScore = score;
      bestOption = opt;
    }
  }

  return bestOption ? { placement, bestOption, score: bestScore } : null;
}
function pickForcedRowIndex(placement, rows) {
  const options = placement?.options || [];
  if (!options.length) return null;

  let bestIdx = null;
  let bestScore = Infinity;
  for (const opt of options) {
    if (!Number.isFinite(opt.rowIdx)) continue;
    const row = rows?.[opt.rowIdx] || [];
    const bulls = Number.isFinite(opt.bulls) ? opt.bulls : 0;
    const rowLen = row.length || 0;
    const tail = row[row.length - 1];
    let score = bulls + rowLen * 0.05;
    if (Number.isFinite(tail)) score += tail * 0.001;
    if (score < bestScore) {
      bestScore = score;
      bestIdx = opt.rowIdx;
    }
  }

  return Number.isFinite(bestIdx) ? bestIdx : null;
}
function chooseCardHeuristic(hand, rows, rng, opts = {}) {
  if (!hand || !hand.length) return null;
  const epsilon = Number.isFinite(opts.epsilon) ? Math.max(0, Math.min(opts.epsilon, 1)) : 0.12;
  const scored = [];

  for (let i = 0; i < hand.length; i++) {
    const card = hand[i];
    const evalInfo = evaluateCardPlacement(rows, card);
    if (!evalInfo) continue;
    const jitter = (rng() - 0.5) * 0.001;
    scored.push({ card, score: evalInfo.score + jitter });
  }

  if (!scored.length) return null;

  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return a.card - b.card;
  });

  const bestScore = scored[0].score;
  const tolerance = 0.12;
  const topGroup = scored.filter(entry => entry.score <= bestScore + tolerance);

  let pickEntry;
  if (rng() < epsilon && scored.length > 1) {
    let idx = Math.floor(rng() * scored.length);
    if (!Number.isFinite(idx) || idx < 0) idx = 0;
    if (idx >= scored.length) idx = scored.length - 1;
    pickEntry = scored[idx];
  } else {
    let idx = Math.floor(rng() * topGroup.length);
    if (!Number.isFinite(idx) || idx < 0) idx = 0;
    if (idx >= topGroup.length) idx = topGroup.length - 1;
    pickEntry = topGroup[idx];
  }

  return pickEntry ? pickEntry.card : null;
}
function simulatePlayout(state, determinization, rootCard, rng) {
  if (!state || !Array.isArray(state.rows) || !state.rows.length) return null;
  const myId = state.myPlayerId;
  if (!myId) return null;
  const players = (Array.isArray(state.playerOrder) && state.playerOrder.length)
    ? state.playerOrder.slice()
    : (state.players || []).map(p => p.id);
  if (!players.length) return null;

  let rows = state.rows.map(r => (Array.isArray(r) ? r.slice() : []));
  const hands = new Map();
  const myHand = (state.hand || []).slice().sort((a, b) => a - b);
  const forcedIdx = myHand.indexOf(rootCard);
  if (forcedIdx === -1) return null;
  myHand.splice(forcedIdx, 1);
  hands.set(myId, myHand);

  for (const id of players) {
    if (id === myId) continue;
    const sample = (determinization?.hands?.[id] || []).slice().sort((a, b) => a - b);
    hands.set(id, sample);
  }

  const seatIndex = new Map();
  for (let i = 0; i < players.length; i++) seatIndex.set(players[i], i);

  const bullsByPlayer = Object.create(null);
  for (const id of players) bullsByPlayer[id] = 0;

  let forcedCardPending = true;
  let rootResolved = false;
  let immediatePenalty = null;
  let turns = 0;
  const maxTurns = 200;

  while (turns++ < maxTurns) {
    const plays = [];
    let anyPlay = false;

    for (const id of players) {
      const hand = hands.get(id) || [];
      let card = null;
        if (id === myId) {
          if (forcedCardPending) {
            card = rootCard;
            forcedCardPending = false;
          } else if (hand.length) {
            card = chooseCardHeuristic(hand, rows, rng, { epsilon: 0.08 });
            if (card != null) {
              const idx = hand.indexOf(card);
              if (idx >= 0) hand.splice(idx, 1);
            }
          }
        } else if (hand.length) {
          card = chooseCardHeuristic(hand, rows, rng, { epsilon: 0.18 });
          if (card != null) {
            const idx = hand.indexOf(card);
            if (idx >= 0) hand.splice(idx, 1);
          }
        }
      if (card != null) {
        plays.push({ playerId: id, card });
        anyPlay = true;
      }
    }

    if (!anyPlay) break;

    plays.sort((a, b) => {
      if (a.card !== b.card) return a.card - b.card;
      return (seatIndex.get(a.playerId) || 0) - (seatIndex.get(b.playerId) || 0);
    });

    for (const play of plays) {
      const placement = previewPlacement(rows, play.card);
      let forcedRowIdx = null;
      if (placement?.forcedTake) {
        forcedRowIdx = pickForcedRowIndex(placement, rows);
      }
      const res = applyPlacementAndScore(
        rows,
        play.card,
        play.playerId,
        bullsByPlayer,
        { forcedRowIdx, placement }
      );
      rows = res.rows;
      if (play.playerId === myId && !rootResolved) {
        rootResolved = true;
      }
    }

    if (rootResolved && immediatePenalty == null) {
      immediatePenalty = Math.max(0, bullsByPlayer[myId] || 0);
    }
  }

  const totalPenalty = Math.max(0, bullsByPlayer[myId] || 0);
  if (immediatePenalty == null) immediatePenalty = totalPenalty;
  const futurePenalty = Math.max(totalPenalty - immediatePenalty, 0);
  return {
    reward: -totalPenalty,
    immediatePenalty,
    futurePenalty
  };
}
const PUCT_EXPLORATION = 1.15;
function createNode(card, prior = 0) {
  return {
    card,
    prior,
    visitCount: 0,
    totalReward: 0,
    totalImmediate: 0,
    totalFuture: 0,
    children: new Map()
  };
}
function selectChild(node, rng) {
  if (!node?.children?.size) return null;
  const parentVisits = Math.max(1, node.visitCount);
  let best = null;
  let bestScore = -Infinity;
  for (const child of node.children.values()) {
    const prior = Number.isFinite(child.prior) ? child.prior : 0;
    const mean = child.visitCount > 0 ? (child.totalReward / child.visitCount) : 0;
    const exploration = PUCT_EXPLORATION * prior * Math.sqrt(parentVisits) / (1 + child.visitCount);
    const noise = (rng() - 0.5) * 1e-6;
    const score = mean + exploration + noise;
    if (score > bestScore) {
      bestScore = score;
      best = child;
    }
  }
  return best;
}
function initializeRoot(state) {
  const root = createNode(null, 1);
  if (Array.isArray(state?.hand)) {
    const cards = state.hand.slice().sort((a, b) => a - b);
    const prior = cards.length ? 1 / cards.length : 0;
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      root.children.set(card, createNode(card, prior));
    }
  }
  return root;
}
const DEFAULT_TIME_MS = 140;
let currentTask = null;
let stopRequested = false;
const TREE_CACHE_LIMIT = 6;
const treeCache = new Map();
const treeOrder = [];

function cacheTree(signature, root) {
  if (!signature || !root) return;
  treeCache.set(signature, { root, ts: performance.now() });
  const idx = treeOrder.indexOf(signature);
  if (idx !== -1) treeOrder.splice(idx, 1);
  treeOrder.push(signature);
  while (treeOrder.length > TREE_CACHE_LIMIT) {
    const oldSig = treeOrder.shift();
    if (oldSig && oldSig !== signature) treeCache.delete(oldSig);
  }
}

function prepareTask(payload) {
  if (!payload || !payload.state || !Array.isArray(payload.state.hand) || !payload.state.hand.length) {
    currentTask = null;
    return null;
  }
  const signature = payload.signature || null;
  if (!currentTask || currentTask.requestId !== payload.requestId) {
    const seed = (payload.seed >>> 0) || 0x9e3779b9;
    let root = null;
    if (signature && treeCache.has(signature)) {
      const cached = treeCache.get(signature);
      root = cached?.root ? cached.root : null;
    }
    if (!root) root = initializeRoot(payload.state);
    currentTask = {
      requestId: payload.requestId,
      signature,
      state: payload.state,
      rng: createRng(seed),
      root,
      deltaStats: new Map(),
      deltaIterations: 0
    };
    stopRequested = false;
    cacheTree(signature, root);
  } else {
    currentTask.state = payload.state;
    currentTask.signature = signature;
    if (signature) cacheTree(signature, currentTask.root);
  }
  return currentTask;
}
function flushProgress(task) {
  if (!task) return;
  const payload = [];
  if (task.deltaStats.size) {
    for (const [card, info] of task.deltaStats.entries()) {
      payload.push({
        card,
        visits: info.visits,
        totalReward: info.totalReward,
        totalImmediate: info.totalImmediate,
        totalFuture: info.totalFuture
      });
    }
    task.deltaStats.clear();
  }
  const iterationDelta = task.deltaIterations;
  task.deltaIterations = 0;
  if (!payload.length && iterationDelta === 0) return;
  postMessage({ type: 'progress', requestId: task.requestId, deltas: payload, iterationDelta });
}
function recordDelta(task, card, reward, immediatePenalty, futurePenalty) {
  let entry = task.deltaStats.get(card);
  if (!entry) {
    entry = { visits: 0, totalReward: 0, totalImmediate: 0, totalFuture: 0 };
    task.deltaStats.set(card, entry);
  }
  entry.visits += 1;
  entry.totalReward = (entry.totalReward || 0) + reward;
  entry.totalImmediate = (entry.totalImmediate || 0) + immediatePenalty;
  entry.totalFuture = (entry.totalFuture || 0) + futurePenalty;
  task.deltaIterations += 1;
  if (task.deltaIterations >= 48) {
    flushProgress(task);
  }
}
function runIterations(task, timeMs) {
  if (!task) return;
  const state = task.state;
  const rng = task.rng;
  const limit = Number.isFinite(timeMs) && timeMs > 0 ? timeMs : DEFAULT_TIME_MS;
  const deadline = performance.now() + limit;
  while (performance.now() < deadline) {
    if (stopRequested) break;
    const determinization = sampleDeterminization(state, rng);
    if (!determinization) continue;
    const child = selectChild(task.root, rng);
    if (!child) break;
    const outcome = simulatePlayout(state, determinization, child.card, rng);
    if (!outcome || !Number.isFinite(outcome.reward)) continue;
    const { reward, immediatePenalty = 0, futurePenalty = 0 } = outcome;
    child.visitCount += 1;
    child.totalReward = (child.totalReward || 0) + reward;
    child.totalImmediate = (child.totalImmediate || 0) + immediatePenalty;
    child.totalFuture = (child.totalFuture || 0) + futurePenalty;
    task.root.visitCount += 1;
    task.root.totalReward = (task.root.totalReward || 0) + reward;
    task.root.totalImmediate = (task.root.totalImmediate || 0) + immediatePenalty;
    task.root.totalFuture = (task.root.totalFuture || 0) + futurePenalty;
    recordDelta(task, child.card, reward, immediatePenalty, futurePenalty);
  }
  flushProgress(task);
  const reason = stopRequested ? 'stopped' : 'timeout';
  stopRequested = false;
  cacheTree(task.signature, task.root);
  postMessage({ type: 'done', requestId: task.requestId, reason });
}
self.onmessage = (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'run') {
    try {
      const task = prepareTask(data);
      if (!task) {
        postMessage({ type: 'done', requestId: data.requestId, reason: 'stopped' });
        return;
      }
      runIterations(task, data.timeMs);
    } catch (err) {
      const message = (err && err.message) ? err.message : String(err);
      postMessage({ type: 'error', requestId: data.requestId, error: message });
    }
  } else if (data.type === 'stop') {
    if (currentTask && data.requestId && currentTask.requestId === data.requestId) {
      stopRequested = true;
    }
  } else if (data.type === 'dispose') {
    close();
  }
};
`;
  }

  function createSolverWorkerUrl() {
    if (createSolverWorkerUrl.cachedUrl) return createSolverWorkerUrl.cachedUrl;
    const source = buildSolverWorkerSource();
    const blob = new Blob([source], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    createSolverWorkerUrl.cachedUrl = url;
    return url;
  }

  const SOLVER_CACHE_SCHEMA_VERSION = 2;

  class SolverCoordinator {
    constructor(opts = {}) {
      this.hardwareConcurrency = clamp(Math.floor(opts.hardwareConcurrency || DETECTED_HW_THREADS), 1, DETECTED_HW_THREADS);
      this.desiredWorkerCount = clamp(Math.floor(opts.initialWorkers || DEFAULT_WORKER_COUNT), 1, this.hardwareConcurrency);
      this.enabled = opts.enabled !== false;
      this.timeSliceMs = clamp(Math.floor(opts.timeSliceMs || 140), 40, 1000);
      this.onUpdate = (typeof opts.onUpdate === 'function') ? opts.onUpdate : () => {};
  this.workerSourceUrl = createSolverWorkerUrl();
      this.workers = [];
      this.currentState = null;
      this.currentSignature = null;
      this.requestId = null;
      this.aggregatedStats = new Map();
      this.totalIterations = 0;
      this.nextWorkerId = 1;
      this.seedCounter = (Math.random() * 0x7fffffff) >>> 0;
        this.signatureCache = new Map();
        this.signatureOrder = [];
        this.signatureCacheLimit = clamp(Math.floor(opts.signatureCacheLimit || 6), 1, 16);
      if (this.enabled) {
        this.ensureWorkerPool();
      }
    }

    isEnabled() {
      return this.enabled;
    }

    getWorkerCap() {
      return this.desiredWorkerCount;
    }

    getPersistentState() {
      return { enabled: this.enabled, workerCap: this.desiredWorkerCount };
    }

    setEnabled(flag) {
      const next = !!flag;
      if (next === this.enabled) return;
      this.enabled = next;
      if (!next) {
        this.broadcastStop(this.requestId);
        this.shutdownWorkers();
      } else {
        this.ensureWorkerPool();
        this.restartWorkers();
      }
    }

    setWorkerCap(count) {
      const next = clamp(Math.floor(count) || 1, 1, this.hardwareConcurrency);
      if (next === this.desiredWorkerCount) return;
      this.desiredWorkerCount = next;
      if (!this.enabled) return;
      if (this.workers.length > next) {
        while (this.workers.length > next) {
          const info = this.workers.pop();
          if (info) this.terminateWorker(info);
        }
      } else {
        this.ensureWorkerPool();
      }
      this.restartWorkers();
    }

    setCanonicalState(state, signature) {
      if (!state || !Array.isArray(state.hand) || !state.hand.length || !Array.isArray(state.rows) || !state.rows.length) {
        if (this.currentState) {
          if (this.currentSignature) this.updateSignatureCache(this.currentSignature);
          this.broadcastStop(this.requestId);
          this.currentState = null;
          this.currentSignature = null;
          this.requestId = null;
          this.aggregatedStats.clear();
          this.totalIterations = 0;
          this.onUpdate();
        }
        return;
      }

      const sig = signature || computeSolverSignature(state);
      if (this.currentSignature === sig && this.requestId) {
        this.restartWorkers();
        return;
      }

      if (this.currentSignature && this.currentSignature !== sig) {
        this.updateSignatureCache(this.currentSignature);
      }

      const prevRequest = this.requestId;
      this.currentState = state;
      this.currentSignature = sig;
      this.requestId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
      const restored = this.restoreSignatureCache(sig);
      if (!restored) {
        this.aggregatedStats = new Map();
        this.totalIterations = 0;
      }
      if (prevRequest) this.broadcastStop(prevRequest);

      if (this.enabled) {
        this.ensureWorkerPool();
        for (const info of this.workers) {
          this.scheduleRun(info);
        }
      }
      this.onUpdate();
    }

    restartWorkers() {
      if (!this.enabled || !this.currentState || !this.requestId) return;
      this.ensureWorkerPool();
      for (const info of this.workers) {
        if (!info.busy || info.requestId !== this.requestId) {
          this.scheduleRun(info);
        }
      }
    }

    reset() {
      const prevRequest = this.requestId;
      this.currentState = null;
      this.currentSignature = null;
      this.requestId = null;
      this.aggregatedStats.clear();
      this.totalIterations = 0;
      this.signatureCache.clear();
      this.signatureOrder = [];
      if (prevRequest) this.broadcastStop(prevRequest);
      for (const info of this.workers) {
        info.busy = false;
        info.requestId = null;
      }
      this.onUpdate();
    }

    shutdownWorkers() {
      for (const info of this.workers) {
        this.terminateWorker(info);
      }
      this.workers = [];
    }

    ensureWorkerPool() {
      if (!this.enabled) return;
      while (this.workers.length < this.desiredWorkerCount) {
        this.spawnWorker();
      }
      while (this.workers.length > this.desiredWorkerCount) {
        const info = this.workers.pop();
        if (info) this.terminateWorker(info);
      }
    }

    spawnWorker() {
      try {
  const worker = new Worker(this.workerSourceUrl);
        const info = { worker, id: this.nextWorkerId++, busy: false, requestId: null };
        worker.onmessage = (ev) => this.handleWorkerMessage(info, ev.data);
        worker.onerror = (err) => this.handleWorkerError(info, err);
        this.workers.push(info);
      } catch (err) {
        console.error('Failed to spawn solver worker', err);
      }
    }

    terminateWorker(info) {
      if (!info) return;
      try {
        if (info.requestId) {
          info.worker.postMessage({ type: 'stop', requestId: info.requestId });
        }
        info.worker.postMessage({ type: 'dispose' });
      } catch {}
      try { info.worker.terminate(); } catch {}
      info.busy = false;
      info.requestId = null;
    }

    scheduleRun(info) {
      if (!this.enabled || !this.currentState || !this.requestId || !info) return;
      const seed = this.nextSeed(info.id);
      const payload = {
        type: 'run',
        requestId: this.requestId,
        state: this.currentState,
        signature: this.currentSignature,
        seed,
        timeMs: this.timeSliceMs
      };
      info.busy = true;
      info.requestId = this.requestId;
      try {
        info.worker.postMessage(payload);
      } catch (err) {
        console.error('Failed to post work to solver worker', err);
        info.busy = false;
      }
    }

    nextSeed(workerId) {
      this.seedCounter = (this.seedCounter + 0x9e3779b9) >>> 0;
      const base = this.seedCounter ^ ((Date.now() & 0xffffffff) >>> 0);
      const mixed = (base ^ ((workerId * 0x45d9f3b) >>> 0)) >>> 0;
      return mixed || 0x9e3779b9;
    }

    broadcastStop(requestId) {
      if (!requestId) return;
      for (const info of this.workers) {
        if (info.busy && info.requestId === requestId) {
          try { info.worker.postMessage({ type: 'stop', requestId }); } catch {}
        }
      }
    }

    handleWorkerMessage(info, message) {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'progress') {
        if (message.requestId !== this.requestId) return;
        if (Array.isArray(message.deltas)) this.applyDeltas(message.deltas);
        const delta = Number.isFinite(message.iterationDelta) ? message.iterationDelta : 0;
        if (delta) this.totalIterations += delta;
        this.onUpdate();
      } else if (message.type === 'done') {
        if (message.requestId !== info.requestId) return;
        info.busy = false;
        info.requestId = null;
        if (!this.enabled) return;
        if (message.requestId === this.requestId && message.reason === 'timeout') {
          this.scheduleRun(info);
        }
      } else if (message.type === 'error') {
        console.error('Solver worker error:', message.error);
        this.terminateWorker(info);
        this.workers = this.workers.filter(w => w !== info);
        if (this.enabled) this.ensureWorkerPool();
      }
    }

    handleWorkerError(info, err) {
      console.error('Solver worker crashed', err);
      this.terminateWorker(info);
      this.workers = this.workers.filter(w => w !== info);
      if (this.enabled) this.ensureWorkerPool();
    }

    applyDeltas(deltas) {
      for (const entry of deltas) {
        const card = Number(entry.card);
        if (!Number.isFinite(card)) continue;
        const visits = Number.isFinite(entry.visits) ? entry.visits : 0;
        const totalReward = Number.isFinite(entry.totalReward) ? entry.totalReward : 0;
        const totalImmediate = Number.isFinite(entry.totalImmediate) ? entry.totalImmediate : 0;
        const totalFuture = Number.isFinite(entry.totalFuture) ? entry.totalFuture : 0;
        if (!visits && !totalReward && !totalImmediate && !totalFuture) continue;
        const existing = this.aggregatedStats.get(card) || { visits: 0, totalReward: 0, totalImmediate: 0, totalFuture: 0 };
        existing.visits = (existing.visits || 0) + visits;
        existing.totalReward = (existing.totalReward || 0) + totalReward;
        existing.totalImmediate = (existing.totalImmediate || 0) + totalImmediate;
        existing.totalFuture = (existing.totalFuture || 0) + totalFuture;
        this.aggregatedStats.set(card, existing);
      }
      this.updateSignatureCache();
    }

    getAggregatedSnapshot(handCards = []) {
      const stats = new Map();
      for (const card of handCards) {
        const key = Number(card);
        if (!Number.isFinite(key)) continue;
        const existing = this.aggregatedStats.get(key);
        if (existing) {
          stats.set(key, {
            visits: Number.isFinite(existing.visits) ? existing.visits : 0,
            totalReward: Number.isFinite(existing.totalReward) ? existing.totalReward : 0,
            totalImmediate: Number.isFinite(existing.totalImmediate) ? existing.totalImmediate : null,
            totalFuture: Number.isFinite(existing.totalFuture) ? existing.totalFuture : null
          });
        } else {
          stats.set(key, { visits: 0, totalReward: 0, totalImmediate: null, totalFuture: null });
        }
      }
      return {
        stats,
        iterations: this.totalIterations,
        running: this.enabled && !!this.currentState && !!this.requestId && this.workers.length > 0
      };
    }

    updateSignatureCache(signature = this.currentSignature) {
      if (!signature) return;
      const snapshot = [];
      for (const [card, info] of this.aggregatedStats.entries()) {
        const visits = Number.isFinite(info && info.visits) ? info.visits : 0;
        const totalReward = Number.isFinite(info && info.totalReward) ? info.totalReward : 0;
        const totalImmediate = Number.isFinite(info && info.totalImmediate) ? info.totalImmediate : null;
        const totalFuture = Number.isFinite(info && info.totalFuture) ? info.totalFuture : null;
        snapshot.push([card, {
          visits,
          totalReward,
          totalImmediate,
          totalFuture
        }]);
      }
      this.signatureCache.set(signature, {
        stats: snapshot,
        iterations: this.totalIterations,
        ts: Date.now(),
        schema: SOLVER_CACHE_SCHEMA_VERSION
      });
      this.signatureOrder = this.signatureOrder.filter(sig => sig !== signature);
      this.signatureOrder.push(signature);
      while (this.signatureOrder.length > this.signatureCacheLimit) {
        const oldSig = this.signatureOrder.shift();
        if (oldSig && oldSig !== signature) this.signatureCache.delete(oldSig);
      }
    }

    restoreSignatureCache(signature) {
      const cached = signature ? this.signatureCache.get(signature) : null;
      if (!cached || cached.schema !== SOLVER_CACHE_SCHEMA_VERSION) {
        if (cached) {
          this.signatureCache.delete(signature);
          this.signatureOrder = this.signatureOrder.filter(sig => sig !== signature);
        }
        this.aggregatedStats = new Map();
        this.totalIterations = 0;
        return false;
      }

      const next = new Map();
      let incompatible = false;
      for (const [card, info] of cached.stats) {
        if (!info) continue;
        const visits = Number.isFinite(info.visits) ? info.visits : 0;
        const totalReward = Number.isFinite(info.totalReward) ? info.totalReward : 0;
        const totalImmediate = Number.isFinite(info.totalImmediate) ? info.totalImmediate : null;
        const totalFuture = Number.isFinite(info.totalFuture) ? info.totalFuture : null;
        if (visits > 0 && (totalImmediate == null || totalFuture == null)) {
          incompatible = true;
          break;
        }
        next.set(card, { visits, totalReward, totalImmediate, totalFuture });
      }

      if (incompatible) {
        this.signatureCache.delete(signature);
        this.signatureOrder = this.signatureOrder.filter(sig => sig !== signature);
        this.aggregatedStats = new Map();
        this.totalIterations = 0;
        return false;
      }

      this.aggregatedStats = next;
      this.totalIterations = Number.isFinite(cached.iterations) ? cached.iterations : 0;
      this.signatureOrder = this.signatureOrder.filter(sig => sig !== signature);
      this.signatureOrder.push(signature);
      return true;
    }
  }

  function ensureSolverCoordinator(savedSolverState) {
    if (solverCoordinator) {
      if (savedSolverState) {
        const desired = clamp(Math.floor(savedSolverState.workerCap) || DEFAULT_WORKER_COUNT, 1, DETECTED_HW_THREADS);
        solverCoordinator.setWorkerCap(desired);
        solverCoordinator.setEnabled(savedSolverState.enabled !== false);
      }
      return;
    }

    const initialWorkers = clamp(Math.floor(savedSolverState?.workerCap) || DEFAULT_WORKER_COUNT, 1, DETECTED_HW_THREADS);
    const enabled = savedSolverState ? (savedSolverState.enabled !== false) : true;
    solverCoordinator = new SolverCoordinator({
      hardwareConcurrency: DETECTED_HW_THREADS,
      initialWorkers,
      enabled,
      onUpdate: () => {
        try {
          renderUndercutList();
        } catch {}
      }
    });
  }

  // ---------- Scanning (GD) ----------
  function scanTablePlayed() {
    const gd = findGameDataObject();
    syncTableMeta(gd);
    if (!gd?.table) return;
    for (const row of Object.values(gd.table)) {
      for (const card of Object.values(row)) {
        const n = parseInt(card?.type_arg, 10);
        if (Number.isFinite(n)) {
          setCardState(n, 'played');
          playedSet.add(n);
        }
      }
    }
  }

  function scanMyHand() {
    const gd = findGameDataObject();
    syncTableMeta(gd);
    const handNow = new Set();
    if (gd?.hand) {
      for (const key in gd.hand) {
        const n = parseInt(gd.hand[key]?.type_arg, 10);
        if (Number.isFinite(n)) handNow.add(n);
      }
    }
    // Promote leaves → played (monotonic)
    for (const n of prevHand) {
      if (!handNow.has(n)) {
        setCardState(n, 'played');
        playedSet.add(n);
      }
    }
    // Clear stale my_hand markers
    for (let i = 1; i <= CARD_COUNT; i++) {
      if (cardState[i] === 'my_hand' && !handNow.has(i)) {
        cardState[i] = (cardState[i] === 'played') ? 'played' : 'unknown';
      }
    }
    // Mark current hand
    for (const n of handNow) setCardState(n, 'my_hand');

    prevHand.clear();
    for (const n of handNow) prevHand.add(n);
  }

  // ---------- Log processing ----------
  function applyLogToLiveRows(text, forceInit = false) {
    if (forceInit) {
      if (!isReplaying && !liveRowsByBga) seedLiveRowsFromGD();
    } else if (!liveRowsByBga && !isReplaying) {
      seedLiveRowsFromGD();
    }
    if (!liveRowsByBga) {
      liveRowsByBga = Object.create(null);
      attachMetaToLiveRows(tableMeta || ensureTableMeta());
    }

    let m = text.match(/^(.+?) places (\d+) on the back of row (\d+)/);
    if (m) {
      const n = +m[2], r = +m[3];
      (liveRowsByBga[r] ||= []).push(n);
      liveRowsByBga[r].sort((a, b) => a - b);
      return { type: 'append', card: n, row: r };
    }

    m = text.match(/^(.+?) places (\d+) and starts row (\d+)/);
    if (m) {
      const n = +m[2], r = +m[3];
      // Mark any previous cards in this row as played
      const prev = liveRowsByBga[r] || [];
      for (const p of prev) {
        setCardState(p, 'played');
        playedSet.add(p);
      }
      liveRowsByBga[r] = [n];
      return { type: 'start', card: n, row: r };
    }

    m = text.match(/^(.+?) takes (\d+) in row (\d+) and receives (\d+) bull head/);
    if (m) {
      const n = +m[2], r = +m[3];
      const taken = (liveRowsByBga[r] || []).slice();
      // Mark all taken cards as played
      for (const t of taken) {
        setCardState(t, 'played');
        playedSet.add(t);
      }
      liveRowsByBga[r] = [n];
      return { type: 'take', newCard: n, row: r, taken };
    }

    if (/A new round starts/i.test(text)) {
      // Clear storage BEFORE refresh, set flag
      if (!forceInit && !isReplaying) {
        clearRoundStorage();
        setNewRoundFlag();
        showStatus('New round detected! Refreshing...', '#2E7D32');
        setTimeout(() => location.reload(), 800);
      }
      resetRoundRevealCounts();
      invalidateCanonicalState();
      return { type: 'round' };
    }
    return null;
  }

  function applyLogLine(text, fromReplay = false) {
    let touched = false;

    // Direct card marks (monotonic -> played)
    let m;
    m = text.match(/^(.+?) places (\d+) on the back of row (\d+)/);
    if (m) {
      const playerName = m[1]?.trim();
      const n = +m[2];
      noteCardRevealFromName(playerName);
      setCardState(n, 'played');
      playedSet.add(n);
      touched = true;
    }

    m = text.match(/^(.+?) places (\d+) and starts row (\d+)/);
    if (m) {
      const playerName = m[1]?.trim();
      const n = +m[2];
      noteCardRevealFromName(playerName);
      setCardState(n, 'played');
      playedSet.add(n);
      touched = true;
    }

    m = text.match(/^(.+?) takes (\d+) in row (\d+) and receives (\d+) bull head/);
    if (m) {
      const playerName = m[1]?.trim();
      const n = +m[2];
      noteCardRevealFromName(playerName);
      setCardState(n, 'played');
      playedSet.add(n);
      touched = true;
    }

    const res = applyLogToLiveRows(text, fromReplay);
    if (res?.type === 'take' && Array.isArray(res.taken)) {
      // Strict rule: any card that has ever been on a row this round stays red
      for (const t of res.taken) {
        setCardState(t, 'played');
        playedSet.add(t);
      }
      touched = true;
    }
    if (res?.type === 'round') {
      resetRoundRevealCounts();
      invalidateCanonicalState();
      touched = true;
    } else if (res?.type) {
      touched = true;
    }

    if (touched) savePlayedToSession();
    return touched;
  }

  function replayExistingLogForCurrentRound() {
    if (!logContainer) return false;
    const lines = logContainer.innerText.split('\n').map(s => s.trim()).filter(Boolean);

    // Keep only from AFTER last "A new round starts"
    let startIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/A new round starts/i.test(lines[i])) {
        startIdx = i;
        break;
      }
    }
    // Skip the "new round" line itself
    const slice = (startIdx >= 0) ? lines.slice(startIdx + 1) : lines;

    const cloneLiveRows = (rows) => {
      if (!rows) return null;
      const cloned = Object.create(null);
      for (const key of Object.keys(rows)) {
        if (key === '__meta') continue;
        cloned[key] = (rows[key] || []).slice();
      }
      return cloned;
    };

    const prevLiveRows = cloneLiveRows(liveRowsByBga);
    const prevMeta = liveRowsByBga?.__meta || null;
    const prevTableCountSnapshot = prevTableCount;

    const preReplaySnap = captureRowsWithBgaMapFromGD();
    let replaySeedRows = null;
    let replaySeedMeta = preReplaySnap.playerMeta || null;
    if (preReplaySnap.rows.length) {
      replaySeedRows = Object.create(null);
      for (let i = 0; i < preReplaySnap.rows.length; i++) {
        const bga = preReplaySnap.rowBgaNums[i] ?? (i + 1);
        replaySeedRows[bga] = preReplaySnap.rows[i].slice();
      }
    } else if (prevLiveRows) {
      replaySeedRows = cloneLiveRows(prevLiveRows);
      replaySeedMeta = prevMeta;
    }

    liveRowsByBga = replaySeedRows || Object.create(null);
    const replayMeta = replaySeedMeta || tableMeta || ensureTableMeta();
    if (replayMeta) attachMetaToLiveRows(replayMeta);
    resetRoundRevealCounts();

    isReplaying = true;
    let any = false;
    for (const ln of slice) {
      if (applyLogLine(ln, true)) any = true;
    }
    isReplaying = false;

    // After replay, refresh liveRowsByBga from the actual table snapshot
    seedLiveRowsFromGD();
    if (!liveRowsByBga && prevLiveRows) {
      liveRowsByBga = prevLiveRows;
      prevTableCount = prevTableCountSnapshot;
      if (prevMeta) {
        attachMetaToLiveRows(prevMeta);
      } else if (tableMeta) {
        attachMetaToLiveRows(tableMeta);
      }
    }

    // After replay, sync with current table
    const gd = findGameDataObject();
    if (gd?.table) {
      for (const row of Object.values(gd.table)) {
        for (const card of Object.values(row)) {
          const n = parseInt(card?.type_arg, 10);
          if (Number.isFinite(n)) {
            setCardState(n, 'played');
            playedSet.add(n);
          }
        }
      }
    }

    invalidateCanonicalState();
    return any;
  }

  // ---------- Round detection / reset ----------
  function hardResetForNewRound() {
    clearSolverCache();
    // Clear all state
    for (let i = 1; i <= CARD_COUNT; i++) cardState[i] = 'unknown';
    playedSet = new Set();
    prevHand.clear();
    liveRowsByBga = null;
    prevTableCount = null;
    clearRoundStorage();
    resetRoundRevealCounts();
    invalidateCanonicalState();

    // Immediately seed current starters (4x1) as played
    const snap = captureRowsWithBgaMapFromGD();
    if (snap.rows.length === 4 && snap.rowLens.every(l => l === 1)) {
      for (const e of snap.rowEnds) {
        setCardState(e, 'played');
        playedSet.add(e);
      }
      savePlayedToSession();
      // Save round signature
      const sig = getRoundSignature();
      if (sig) {
        try { sessionStorage.setItem(SS_ROUND_SIG, sig); } catch {}
      }
    }
    updateCardsUI();
    renderUndercutList();
  }

  function maybeHeuristicNewRound() {
    const gd = findGameDataObject();
    if (!gd) return false;

    const snap = captureRowsWithBgaMapFromGD();
    const tableCount = snap.rowLens.reduce((a, b) => a + b, 0);
    const initPattern = (snap.rows.length === 4 && snap.rowLens.every(l => l === 1));

    const hand = liveHandArray();
    const looksDealt = hand.length >= 8;

    // Check if this is a different round than what we have saved
    const currentSig = getRoundSignature();
    const savedSig = sessionStorage.getItem(SS_ROUND_SIG) || '';

    if (initPattern && looksDealt) {
      if (currentSig && savedSig && currentSig !== savedSig) {
        // Different round detected
        hardResetForNewRound();
        seedLiveRowsFromGD();
        scanTablePlayed();
        scanMyHand();
        savePlayedToSession();
        prevTableCount = tableCount;
        return true;
      }
      // Same round or first load - check for other new round indicators
      if (playedSet.size > 4 && prevTableCount != null && prevTableCount > 4) {
        // Looks like we had a previous round
        hardResetForNewRound();
        seedLiveRowsFromGD();
        scanTablePlayed();
        scanMyHand();
        savePlayedToSession();
        prevTableCount = tableCount;
        return true;
      }
    }
    prevTableCount = tableCount;
    return false;
  }

  // ---------- Metrics helpers ----------
  function chosenRowIdx(x, rowEnds) {
    let best = -1, diff = Infinity;
    for (let i = 0; i < rowEnds.length; i++) {
      const d = x - rowEnds[i];
      if (d > 0 && d < diff) {
        diff = d;
        best = i;
      }
    }
    return best;
  }

  function computeUndercutCountForCard(c, rowIdx, endVal, rowEnds) {
    let count = 0;
    for (let u = endVal + 1; u <= c - 1; u++) {
    if ((cardState[u] || 'unknown') !== 'unknown') continue; // only unseen
      if (chosenRowIdx(u, rowEnds) === rowIdx) count++;
    }
    return count;
  }

  // ---------- Rendering ----------
  function updateCardsUI() {
    // Re-apply persisted reds (monotonic)
    for (const n of playedSet) setCardState(n, 'played');

    for (let i = 1; i <= CARD_COUNT; i++) {
      const el = byId(`tracker-card-${i}`);
      if (!el) continue;
      el.className = 'tracker-card';
      if (recommendedCards.has(i)) el.classList.add('recommend');
      const st = cardState[i] || 'unknown';
      if (st !== 'unknown') el.classList.add(`state-${st}`);
    }
  }

  function renderUndercutList() {
    if (!metricsWrap) return;

    const canonical = buildCanonicalState();
    const hand = canonical?.hand || [];
    const rowsSnapshot = canonical?.rows || [];

    if (!hand.length || !rowsSnapshot.length) {
      if (solverCoordinator) solverCoordinator.setCanonicalState(null, null);
      recommendedCards = new Set();
      metricsWrap.innerHTML = `<div style="color:#777;">Waiting for game data…</div>`;
      return;
    }

    const rowEnds = rowsSnapshot.map(r => r[r.length - 1]);
    const cardMetrics = new Map();
    for (const card of hand) {
      const idx = chosenRowIdx(card, rowEnds);
      let under = 0;
      if (idx !== -1) {
        const end = rowEnds[idx];
        under = computeUndercutCountForCard(card, idx, end, rowEnds);
      }
      cardMetrics.set(card, {
        card,
        under,
        visits: 0,
        expectedNow: null,
        expectedLater: null,
        expectedTotal: null
      });
    }

    const signature = computeSolverSignature(canonical);
    if (solverCoordinator) {
      solverCoordinator.setCanonicalState(canonical, signature);
    }

    const solverSnapshot = solverCoordinator
      ? solverCoordinator.getAggregatedSnapshot(hand)
      : { stats: new Map(), iterations: 0, running: false };

    let bestEv = Infinity;
    for (const card of hand) {
      const entry = cardMetrics.get(card) || {
        card,
        under: 0,
        visits: 0,
        expectedNow: null,
        expectedLater: null,
        expectedTotal: null
      };
      const solverInfo = solverSnapshot.stats.get(card);
      if (solverInfo && Number.isFinite(solverInfo.visits) && solverInfo.visits > 0) {
        const visits = solverInfo.visits;
        const totalReward = Number.isFinite(solverInfo.totalReward) ? solverInfo.totalReward : null;
        const totalImmediateRaw = Number.isFinite(solverInfo.totalImmediate) ? solverInfo.totalImmediate : null;
        const totalFutureRaw = Number.isFinite(solverInfo.totalFuture) ? solverInfo.totalFuture : null;
        const expectedNow = (totalImmediateRaw != null) ? (totalImmediateRaw / visits) : null;
        const expectedLater = (totalFutureRaw != null) ? (totalFutureRaw / visits) : null;
        let expectedTotal = null;
        if (totalReward != null) {
          expectedTotal = -(totalReward / visits);
        }
        if (!Number.isFinite(expectedTotal) && (Number.isFinite(expectedNow) || Number.isFinite(expectedLater))) {
          const nowVal = Number.isFinite(expectedNow) ? expectedNow : 0;
          const laterVal = Number.isFinite(expectedLater) ? expectedLater : 0;
          expectedTotal = nowVal + laterVal;
        }
        let resolvedNow = Number.isFinite(expectedNow) ? expectedNow : null;
        let resolvedLater = Number.isFinite(expectedLater) ? expectedLater : null;
        if (!Number.isFinite(resolvedNow) && Number.isFinite(expectedTotal) && Number.isFinite(resolvedLater)) {
          resolvedNow = expectedTotal - resolvedLater;
        } else if (!Number.isFinite(resolvedLater) && Number.isFinite(expectedTotal) && Number.isFinite(resolvedNow)) {
          resolvedLater = expectedTotal - resolvedNow;
        }
        entry.visits = visits;
        entry.expectedNow = Number.isFinite(resolvedNow) ? resolvedNow : null;
        entry.expectedLater = Number.isFinite(resolvedLater) ? resolvedLater : null;
        if (Number.isFinite(expectedTotal)) {
          entry.expectedTotal = expectedTotal;
          if (expectedTotal < bestEv) bestEv = expectedTotal;
        } else {
          entry.expectedTotal = null;
        }
      } else if (solverInfo) {
        entry.visits = solverInfo.visits || 0;
      }
      cardMetrics.set(card, entry);
    }

    const highlight = new Set();
    if (bestEv !== Infinity) {
      const tolerance = 0.05;
      for (const entry of cardMetrics.values()) {
        if (Number.isFinite(entry.expectedTotal) && Math.abs(entry.expectedTotal - bestEv) <= tolerance) {
          highlight.add(entry.card);
        }
      }
    } else {
      let minUnder = Infinity;
      for (const entry of cardMetrics.values()) {
        if (entry.under < minUnder) minUnder = entry.under;
      }
      for (const entry of cardMetrics.values()) {
        if (entry.under === minUnder) highlight.add(entry.card);
      }
    }
    recommendedCards = highlight;

    const sorted = Array.from(cardMetrics.values()).sort((a, b) => {
      const aHasEv = Number.isFinite(a.expectedTotal);
      const bHasEv = Number.isFinite(b.expectedTotal);
      if (aHasEv && bHasEv) {
        if (a.expectedTotal !== b.expectedTotal) return a.expectedTotal - b.expectedTotal;
        if (a.visits !== b.visits) return b.visits - a.visits;
      } else if (aHasEv) {
        return -1;
      } else if (bHasEv) {
        return 1;
      } else if (a.under !== b.under) {
        return a.under - b.under;
      }
      return a.card - b.card;
    });

    const formatEv = (value) => {
      if (!Number.isFinite(value)) return '—';
      return value.toFixed(3);
    };

    let html = `<table><thead><tr><th>Card</th><th>EV&nbsp;Total</th><th>EV&nbsp;Now</th><th>EV&nbsp;Later</th><th>Samples</th><th>Undercut&nbsp;#</th></tr></thead><tbody>`;
    for (const row of sorted) {
      const cls = highlight.has(row.card) ? ' class="best-card"' : '';
  const evTotalStr = formatEv(row.expectedTotal);
  const evNowStr = formatEv(row.expectedNow);
  const evLaterStr = formatEv(row.expectedLater);
  const samplesStr = row.visits > 0 ? row.visits : '—';
      html += `<tr${cls}><td>${row.card}</td><td>${evTotalStr}</td><td>${evNowStr}</td><td>${evLaterStr}</td><td>${samplesStr}</td><td>${row.under}</td></tr>`;
    }
    html += '</tbody></table>';

    const sampleCount = solverSnapshot.iterations ?? 0;
    let statusNote = '';
    if (!solverCoordinator || !solverCoordinator.isEnabled()) {
      statusNote = ' (paused)';
    } else if (!solverSnapshot.running || !sampleCount) {
      statusNote = ' (warming up)';
    }
    html += `<div style="margin-top:6px;font-size:11px;color:#666;">ISMCTS samples: ${sampleCount}${statusNote}</div>`;
    metricsWrap.innerHTML = html;
  }

  function liveHandArray() {
    const arr = [];
    for (let i = 1; i <= CARD_COUNT; i++) {
      if (cardState[i] === 'my_hand') arr.push(i);
    }
    return arr.sort((a, b) => a - b);
  }

  function refreshStateAndMetrics() {
    // Persist reds, scan latest GD, run heuristic, then paint
    syncTableMeta();
    for (const n of playedSet) setCardState(n, 'played');

    scanMyHand();
    scanTablePlayed();
    maybeHeuristicNewRound();

    renderUndercutList();
    updateCardsUI();
    invalidateCanonicalState();
  }

  // ---------- Observers / bootstrap ----------
  function observeLogContainer() {
    if (!logContainer) return;
    const observer = new MutationObserver((muts) => {
      let touched = false;
      for (const mut of muts) {
        if (mut.type !== 'childList' || !mut.addedNodes?.length) continue;
        for (const node of mut.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const text = node.innerText?.trim();
          if (!text) continue;
          if (applyLogLine(text, false)) touched = true;
        }
      }
      if (touched) {
        savePlayedToSession();
        invalidateCanonicalState();
        refreshStateAndMetrics();
      }
    });
    observer.observe(logContainer, { childList: true, subtree: true });
  }

  function createAndMount() {
    createTrackerUI();
    showStatus('Tracker mounted. Looking for game…');

    // Heartbeat (gentle)
    setInterval(refreshStateAndMetrics, 800);

    let tries = 0, maxTries = 240;
    const readyCheck = setInterval(() => {
      tries++;
      if (!logContainer) {
        logContainer =
          document.getElementById('log') ||
          document.querySelector('#logs') ||
          document.querySelector('.logs, .log_block') ||
          document.querySelector('[id^="logs_"]') ||
          document.querySelector('[id*="logscroll"]') ||
          document.querySelector('[id*="gamelog"]') ||
          document.querySelector('[id*="log"], [class*="log"]');
        if (logContainer) {
          // Check if this is a new round refresh
          const isNewRoundRefresh = checkAndClearNewRoundFlag();

          if (isNewRoundRefresh) {
            // This is a refresh after new round detection - start completely fresh
            clearRoundStorage();
            playedSet = new Set();
            resetRoundRevealCounts();
            invalidateCanonicalState();
            // Don't load any saved state
          } else {
            // Normal load - check for round signature match
            const currentSig = getRoundSignature();
            const savedSig = sessionStorage.getItem(SS_ROUND_SIG) || '';

            if (currentSig && savedSig && currentSig === savedSig) {
              // Same round - restore state
              playedSet = loadPlayedFromSession();
              for (const n of playedSet) setCardState(n, 'played');
            } else if (currentSig && savedSig && currentSig !== savedSig) {
              // Different round - clear everything
              clearRoundStorage();
              playedSet = new Set();
            } else if (!isNewRoundRefresh) {
              // Can't determine and not a new round refresh - load what we have
              playedSet = loadPlayedFromSession();
              for (const n of playedSet) setCardState(n, 'played');
            }
          }

          // Seed rows & hand from GD, then replay current-round log
          seedLiveRowsFromGD();
          scanTablePlayed();
          scanMyHand();

          replayExistingLogForCurrentRound();
          observeLogContainer();

          // If this looks like a new round setup, ensure proper initialization
          const snap = captureRowsWithBgaMapFromGD();
          if (snap.rows.length === 4 && snap.rowLens.every(l => l === 1)) {
            // Ensure only the 4 starting cards are red
            if (playedSet.size === 0 || isNewRoundRefresh) {
              for (let i = 1; i <= CARD_COUNT; i++) cardState[i] = 'unknown';
              playedSet = new Set();
              for (const e of snap.rowEnds) {
                setCardState(e, 'played');
                playedSet.add(e);
              }
              savePlayedToSession();
            }
          }
        }
      }

      const snap = snapshotRows();
      if (snap.rows.length || liveHandArray().length) {
        showStatus('Tracker: Game found. Running!', '#2E7D32');
        setTimeout(() => statusDiv && statusDiv.remove(), 1600);
        clearInterval(readyCheck);
      } else if (tries >= maxTries) {
        showStatus('Tracker active (waiting for game data)…', '#8E24AA');
        setTimeout(() => statusDiv && statusDiv.remove(), 3000);
        clearInterval(readyCheck);
      }
    }, 500);
  }

  // ---------- Go ----------
  createAndMount();

})();