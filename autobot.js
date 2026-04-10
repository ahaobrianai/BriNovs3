/* ═══════════════════════════════════════════════════════════════════
   BriNovs FX Engine — autobot.js  v1.0
   THE AUTOBOT ENGINE
   ─────────────────────────────────────────────────────────────────
   Modules:
     1. BotSession     → Session state, run counter, NEWS log
     2. TradeEngine    → Deriv WebSocket proposal + buy + track
     3. BotRunner      → Manual START/STOP loop
     4. AutoRunEngine  → Persistent 24/7 AutoRun loop (≥50% conf)
     5. BotUI          → DOM bindings — buttons, status, NEWS feed
   ─────────────────────────────────────────────────────────────────
   Deriv trading flow:
     authorize(token)
     → proposal(symbol, direction, duration, stake)
     → buy(proposal_id, price)
     → track contract via proposal_open_contract subscription
     → read profit/loss on settlement
   ─────────────────────────────────────────────────────────────────
   Key rules:
     • Manual mode   → trades ALL signals regardless of confidence
     • AutoRun mode  → trades ONLY signals with confidence ≥ 50%
     • Tick mode     → uses M1 signal analysis, trades ticks contract
     • Boom markets  → direction forced BUY (index rises by nature)
     • Crash markets → direction forced SELL (index falls by nature)
     • Balance guard → halts if balance < stake × 2
     • Cooldown      → 2-candle gap between consecutive trades
     • Confirmation  → waits 1 closed candle after signal before entry
   ─────────────────────────────────────────────────────────────────
   Depends on: app.js  (BriNovs, DerivAuth, WatcherBrain, UIBridge)
   Load ORDER: <script src="app.js"> then <script src="autobot.js">
═══════════════════════════════════════════════════════════════════ */

'use strict';

/* ─────────────────────────────────────────────
   1. BOT SESSION STATE
───────────────────────────────────────────── */
const BotSession = {

  manual: {
    active:       false,
    runsTotal:    0,
    runsLeft:     0,
    runsDone:     0,
    wins:         0,
    losses:       0,
    netPL:        0,
    trades:       [],
    startBalance: null,
    startTime:    null,
  },

  autorun: {
    enabled:      false,
    runsDone:     0,
    wins:         0,
    losses:       0,
    netPL:        0,
    trades:       [],
    startBalance: null,
    startTime:    null,
  },

  // Shared inter-trade state
  waitingForSignal:  false,
  cooldownCandles:   0,
  confirmCountdown:  0,
  COOLDOWN:          2,     // confirmed candles to skip between trades
  CONFIRM_CANDLES:   1,     // confirmed candles to wait before entry

  // Unified news log (both manual and autorun entries)
  newsLog: [],

  // ── Log an entry ──
  log(type, text) {
    const entry = { time: new Date().toLocaleTimeString(), type, text };
    this.newsLog.unshift(entry);
    if (this.newsLog.length > 300) this.newsLog.pop();
    BotUI.pushNewsEntry(entry);
    if (window.WatcherBrain) WatcherBrain.narrate('system', '[BOT] ' + text);
  },

  // ── Reset manual session fields ──
  resetManual() {
    Object.assign(this.manual, {
      active: false, runsTotal: 0, runsLeft: 0,
      runsDone: 0, wins: 0, losses: 0, netPL: 0,
      trades: [], startBalance: null, startTime: null,
    });
    this.waitingForSignal = false;
    this.cooldownCandles  = 0;
    this.confirmCountdown = 0;
  },

  // ── Reset autorun session fields ──
  resetAutoRun() {
    Object.assign(this.autorun, {
      enabled: false, runsDone: 0, wins: 0, losses: 0,
      netPL: 0, trades: [], startBalance: null, startTime: null,
    });
  },
};

/* ─────────────────────────────────────────────
   2. TRADE ENGINE
───────────────────────────────────────────── */
const TradeEngine = {

  WS_URL:           'wss://ws.binaryws.com/websockets/v3?app_id=1089',
  _ws:              null,
  _pendingProposal: null,
  _pendingBuy:      null,
  _contractId:      null,
  _onSettled:       null,

  // ── Open dedicated trading WebSocket and authorise ──
  connect() {
    return new Promise((resolve, reject) => {
      const token = window.DerivAuth ? DerivAuth.getToken() : null;
      if (!token) { reject('No API token.'); return; }

      if (this._ws && this._ws.readyState === WebSocket.OPEN) { resolve(); return; }

      try {
        this._ws = new WebSocket(this.WS_URL);

        this._ws.onopen = () => {
          this._ws.send(JSON.stringify({ authorize: token }));
        };

        this._ws.onmessage = (e) => {
          const data = JSON.parse(e.data);
          if (data.msg_type === 'authorize') {
            if (data.error) { reject('Auth: ' + data.error.message); return; }
            // Auth done — swap handler to general message router
            this._ws.onmessage = (ev) => this._route(JSON.parse(ev.data));
            resolve();
          }
        };

        this._ws.onerror = () => reject('Trading WebSocket error.');
        this._ws.onclose = () => {
          this._ws = null;
          BotSession.log('warn', 'Trading WebSocket closed.');
        };

      } catch(e) {
        reject('WebSocket open failed: ' + e.message);
      }
    });
  },

  // ── Route incoming messages to correct handler ──
  _route(data) {
    if (data.msg_type === 'proposal' && this._pendingProposal) {
      if (data.error) this._pendingProposal.reject(data.error.message);
      else            this._pendingProposal.resolve(data.proposal);
      this._pendingProposal = null;
      return;
    }

    if (data.msg_type === 'buy' && this._pendingBuy) {
      if (data.error) {
        this._pendingBuy.reject(data.error.message);
      } else {
        this._contractId = data.buy.contract_id;
        this._pendingBuy.resolve(data.buy);
        // Subscribe to contract stream for settlement
        this._ws.send(JSON.stringify({
          proposal_open_contract: 1,
          contract_id: this._contractId,
          subscribe: 1,
        }));
      }
      this._pendingBuy = null;
      return;
    }

    if (data.msg_type === 'proposal_open_contract') {
      const c = data.proposal_open_contract;
      if (c && c.is_sold && this._onSettled) {
        this._onSettled({
          outcome: parseFloat(c.profit) >= 0 ? 'WIN' : 'LOSS',
          profit:  parseFloat(c.profit) || 0,
          contract: c,
        });
        this._onSettled  = null;
        this._contractId = null;
      }
    }
  },

  // ── Request a price proposal ──
  getProposal(symbol, direction, duration, durUnit, stake) {
    return new Promise((resolve, reject) => {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
        reject('Not connected.'); return;
      }
      this._pendingProposal = { resolve, reject };
      this._ws.send(JSON.stringify({
        proposal:      1,
        amount:        stake,
        basis:         'stake',
        contract_type: direction === 'BUY' ? 'CALL' : 'PUT',
        currency:      'USD',
        duration:      duration,
        duration_unit: durUnit,   // 't'=ticks  'm'=minutes  'h'=hours
        symbol:        symbol,
      }));
      setTimeout(() => {
        if (this._pendingProposal) {
          this._pendingProposal.reject('Proposal timeout.');
          this._pendingProposal = null;
        }
      }, 10000);
    });
  },

  // ── Buy from a proposal ──
  buyContract(proposalId, price) {
    return new Promise((resolve, reject) => {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
        reject('Not connected.'); return;
      }
      this._pendingBuy = { resolve, reject };
      this._ws.send(JSON.stringify({ buy: proposalId, price }));
      setTimeout(() => {
        if (this._pendingBuy) {
          this._pendingBuy.reject('Buy timeout.');
          this._pendingBuy = null;
        }
      }, 10000);
    });
  },

  // ── Await contract settlement ──
  waitForSettlement(timeoutMs) {
    return new Promise((resolve, reject) => {
      this._onSettled = resolve;
      setTimeout(() => {
        if (this._onSettled) {
          this._onSettled = null;
          reject('Settlement timeout.');
        }
      }, timeoutMs || 300000);
    });
  },

  // ── Full trade: proposal → buy → settlement ──
  async executeTrade(symbol, direction, duration, durUnit, stake) {
    const proposal   = await this.getProposal(symbol, direction, duration, durUnit, stake);
    const buyResult  = await this.buyContract(proposal.id, proposal.ask_price);
    const settlement = await this.waitForSettlement();
    return settlement;
  },

  // ── Simulation (no token present) ──
  simulateTrade(signal, stake) {
    return new Promise(resolve => {
      const winChance = (signal.confidence || 50) / 100;
      const win       = Math.random() < winChance;
      const profit    = win ? parseFloat((stake * 0.85).toFixed(2)) : -stake;
      setTimeout(() => {
        resolve({ outcome: win ? 'WIN' : 'LOSS', profit, simulated: true });
      }, 1500 + Math.random() * 1000);
    });
  },

  close() {
    if (this._ws) { try { this._ws.close(); } catch(e) {} this._ws = null; }
  },
};

/* ─────────────────────────────────────────────
   3. BOT RUNNER — Manual session logic
───────────────────────────────────────────── */
const BotRunner = {

  _pollInterval: null,

  // ── Start a manual session ──
  async start() {
    if (BotSession.manual.active) return;
    if (BotSession.autorun.enabled) {
      BotSession.log('warn', 'Disable AutoRun before starting a manual session.');
      return;
    }

    const B       = window.BriNovs;
    const stake   = B?.stake          || 10;
    const runs    = B?.botRuns        || 1;
    const symLbl  = B?.botSymbolLabel || 'Volatility 50';
    const gran    = B?.botGranularity || 60;
    const ticks   = B?.botTicks       || 5;
    const isTicks = gran === 'ticks';

    BotSession.resetManual();
    const s           = BotSession.manual;
    s.active          = true;
    s.runsTotal       = runs === 0 ? Infinity : runs;
    s.runsLeft        = runs === 0 ? Infinity : runs;
    s.startTime       = Date.now();
    s.startBalance    = _currentBalance();

    BotUI.setStarted('manual');
    BotSession.log('ok',
      `Manual session started. Market: ${symLbl}, ` +
      `TF: ${isTicks ? ticks + ' ticks (M1 analysis)' : _tfLabel(gran)}, ` +
      `Stake: $${stake}, Runs: ${runs === 0 ? '∞' : runs}.`
    );

    // Connect trading WebSocket
    const hasToken = window.DerivAuth && DerivAuth.isConnected();
    if (hasToken) {
      try {
        await TradeEngine.connect();
        BotSession.log('ok', 'Trading WebSocket connected. Ready to trade.');
      } catch(err) {
        BotSession.log('warn', `Trade WS failed (${err}). Simulation mode active.`);
      }
    } else {
      BotSession.log('warn', 'No API token — SIMULATION MODE. No real trades will be placed.');
    }

    this._waitForSignal('manual');
  },

  // ── Stop a manual session ──
  stop(reason) {
    if (!BotSession.manual.active) return;
    BotSession.manual.active = false;
    this._clearPoll();
    BotSession.log('system', reason || 'Session stopped by user.');
    BotUI.setStopped('manual');
    _logSummary('manual');
    BotUI.refreshNews();
  },

  // ── Clear the polling interval ──
  _clearPoll() {
    if (this._pollInterval) { clearInterval(this._pollInterval); this._pollInterval = null; }
    BotSession.waitingForSignal = false;
  },

  // ── Poll every 2s waiting for a qualifying signal ──
  _waitForSignal(mode) {
    BotSession.waitingForSignal = true;
    BotSession.confirmCountdown = 0;
    BotSession.log('system', `Watching ${window.BriNovs?.botSymbolLabel || 'market'} for next signal…`);

    this._pollInterval = setInterval(() => {
      // Stop if session ended
      if (mode === 'manual'  && !BotSession.manual.active)    { this._clearPoll(); return; }
      if (mode === 'autorun' && !BotSession.autorun.enabled)  { this._clearPoll(); return; }

      // Cooldown: skip until candle timer expires
      if (BotSession.cooldownCandles > 0) return;

      const signal = window.BriNovs?.currentSignal;
      if (!signal || signal.direction === 'WAIT') return;

      // AutoRun requires ≥50% confidence; manual takes everything
      if (mode === 'autorun' && signal.confidence < 50) {
        BotSession.log('system',
          `Signal ${signal.direction} at ${signal.confidence}% confidence — below AutoRun threshold (50%). Skipping.`
        );
        return;
      }

      // Confirmation delay — wait 1 candle after signal
      if (BotSession.confirmCountdown === 0) {
        BotSession.confirmCountdown = BotSession.CONFIRM_CANDLES;
        BotSession.log('system',
          `Signal: ${signal.direction} — ${signal.confidence}% confidence. ` +
          `Waiting ${BotSession.CONFIRM_CANDLES} candle to confirm…`
        );
        return;
      }
      BotSession.confirmCountdown--;
      if (BotSession.confirmCountdown > 0) return;

      // Confirmed — execute trade
      this._clearPoll();
      this._trade(signal, mode);

    }, 2000);
  },

  // ── Execute one trade ──
  async _trade(signal, mode) {
    const B       = window.BriNovs;
    const stake   = B?.stake          || 10;
    const symbol  = B?.botSymbol      || 'R_50';
    const symLbl  = B?.botSymbolLabel || 'Volatility 50';
    const gran    = B?.botGranularity || 60;
    const ticks   = B?.botTicks       || 5;
    const isTicks = gran === 'ticks';

    const direction  = _applyBias(symbol, signal.direction);
    const durUnit    = isTicks ? 't' : (gran >= 3600 ? 'h' : 'm');
    const duration   = isTicks ? ticks : (gran >= 3600 ? gran / 3600 : gran / 60);
    const hasToken   = window.DerivAuth && DerivAuth.isConnected();

    BotUI.setTrading(mode);
    BotSession.log('ok',
      `ENTERING ${direction} — ${symLbl}. ` +
      `Stake: $${stake}. Duration: ${duration}${durUnit}. ` +
      `Entry: ${signal.price}. Confidence: ${signal.confidence}%.`
    );

    let result;
    try {
      result = hasToken
        ? await TradeEngine.executeTrade(symbol, direction, duration, durUnit, stake)
        : await TradeEngine.simulateTrade(signal, stake);
    } catch(err) {
      BotSession.log('warn', `Trade error: ${err}. Skipping run.`);
      BotUI.setWaiting(mode);
      _postTrade(null, signal, mode);
      return;
    }

    // ── Record result ──
    const session = mode === 'manual' ? BotSession.manual : BotSession.autorun;
    const trade   = {
      time:       new Date().toLocaleString(),
      mode,
      direction,
      symbol:     symLbl,
      stake,
      outcome:    result.outcome,
      profit:     result.profit,
      simulated:  result.simulated || false,
      confidence: signal.confidence,
    };
    session.trades.unshift(trade);
    session.runsDone++;
    if (result.outcome === 'WIN')  { session.wins++;   session.netPL += result.profit; }
    if (result.outcome === 'LOSS') { session.losses++; session.netPL += result.profit; }

    const simTag  = result.simulated ? ' [SIM]' : '';
    const plSign  = result.profit >= 0 ? '+' : '';
    const netSign = session.netPL >= 0 ? '+' : '';
    BotSession.log(
      result.outcome === 'WIN' ? 'ok' : 'loss',
      `${result.outcome}${simTag} — P&L: ${plSign}$${result.profit.toFixed(2)}. ` +
      `Run ${session.runsDone}${session.runsTotal !== Infinity ? ' of ' + session.runsTotal : ''}. ` +
      `Net: ${netSign}$${session.netPL.toFixed(2)}.`
    );

    // Update live balance on the dashboard
    if (window.DerivAuth && DerivAuth.getAccount()) {
      const acc = DerivAuth.getAccount();
      acc.balance = (parseFloat(acc.balance) + result.profit).toFixed(2);
      if (window.UIBridge) UIBridge.setUserBalance(acc.balance, acc.currency);
    }

    BotUI.setWaiting(mode);
    BotUI.refreshNews();

    // Start cooldown countdown (one candle per tick of the candle close cycle)
    BotSession.cooldownCandles = BotSession.COOLDOWN;
    const cooldownMs = isTicks ? 3000 : Math.min(B?.botGranularity || 60, 60) * 1000;
    const cdInterval = setInterval(() => {
      if (BotSession.cooldownCandles > 0) { BotSession.cooldownCandles--; }
      else { clearInterval(cdInterval); _postTrade(result, signal, mode); }
    }, cooldownMs);
  },
};

/* ─────────────────────────────────────────────
   4. AUTO RUN ENGINE — Persistent 24/7 loop
───────────────────────────────────────────── */
const AutoRunEngine = {

  enable() {
    if (BotSession.autorun.enabled) return;
    if (BotSession.manual.active) {
      BotSession.log('warn', 'Stop the manual session before enabling AutoRun.');
      return;
    }
    const B = window.BriNovs;
    BotSession.autorun.enabled      = true;
    BotSession.autorun.startTime    = Date.now();
    BotSession.autorun.startBalance = _currentBalance();
    if (B) B.autoRunEnabled = true;
    BotUI.setAutoRunState(true);
    BotUI.setStarted('autorun');
    BotSession.log('ok',
      `AutoRun ENABLED. Market: ${B?.botSymbolLabel || '—'}. ` +
      `Min confidence: 50%. Running 24/7 until disabled.`
    );
    const hasToken = window.DerivAuth && DerivAuth.isConnected();
    if (hasToken) {
      TradeEngine.connect()
        .then(() => {
          BotSession.log('ok', 'AutoRun trading WebSocket ready.');
          BotRunner._waitForSignal('autorun');
        })
        .catch(err => {
          BotSession.log('warn', `AutoRun WS failed (${err}). Simulating.`);
          BotRunner._waitForSignal('autorun');
        });
    } else {
      BotSession.log('warn', 'No API token — AutoRun in SIMULATION MODE.');
      BotRunner._waitForSignal('autorun');
    }
  },

  disable(reason) {
    if (!BotSession.autorun.enabled) return;
    BotSession.autorun.enabled = false;
    if (window.BriNovs) window.BriNovs.autoRunEnabled = false;
    BotRunner._clearPoll();
    BotUI.setAutoRunState(false);
    BotUI.setStopped('autorun');
    BotSession.log('system', reason || 'AutoRun disabled by user.');
    _logSummary('autorun');
    BotUI.refreshNews();
  },

  toggle() {
    BotSession.autorun.enabled ? this.disable() : this.enable();
  },
};

/* ─────────────────────────────────────────────
   5. BOT UI
───────────────────────────────────────────── */
const BotUI = {

  init() {
    // START button
    const startBtn = document.querySelector('.bot-start');
    if (startBtn) startBtn.addEventListener('click', () => BotRunner.start());

    // STOP button
    const stopBtn = document.querySelector('.bot-stop');
    if (stopBtn) stopBtn.addEventListener('click', () => {
      if (BotSession.manual.active) BotRunner.stop('Stopped by user.');
      else BotSession.log('system', 'No active manual session to stop.');
    });

    // ENABLE/STOP AUTO-RUN button — inject glowing dot
    const autoBtn = document.querySelector('.autorun-btn');
    if (autoBtn) {
      if (!autoBtn.querySelector('.autorun-dot')) {
        const dot = document.createElement('span');
        dot.className = 'autorun-dot';
        autoBtn.insertBefore(dot, autoBtn.firstChild);
      }
      autoBtn.addEventListener('click', () => AutoRunEngine.toggle());
    }

    // NEWS button → news.html
    const newsBtn = document.querySelector('.bot-news');
    if (newsBtn) newsBtn.addEventListener('click', () => {
      window.location.href = 'news.html';
    });
  },

  setAutoRunState(enabled) {
    const btn = document.querySelector('.autorun-btn');
    const dot = btn?.querySelector('.autorun-dot');
    if (!btn) return;
    btn.classList.toggle('autorun-active', enabled);
    if (dot) dot.classList.toggle('autorun-dot-on', enabled);
  },

  setBotStatus(text, online) {
    const badge  = document.querySelector('.bot-status-badge');
    const textEl = document.getElementById('bot-status-text');
    const dot    = document.querySelector('.bot-dot');
    if (!badge) return;
    badge.classList.toggle('online',   online);
    badge.classList.toggle('offline', !online);
    if (textEl) textEl.textContent   = text;
    if (dot)    dot.style.background = online ? '#39ff14' : '#ff4444';
  },

  setStarted(mode) { this.setBotStatus('ONLINE', true);   BotUI.refreshNews(); },
  setStopped(mode) {
    if (!BotSession.manual.active && !BotSession.autorun.enabled)
      this.setBotStatus('OFFLINE', false);
    BotUI.refreshNews();
  },
  setTrading(mode) { this.setBotStatus('TRADING', true);  },
  setWaiting(mode) { this.setBotStatus('ONLINE',  true);  },

  pushNewsEntry(entry) {
    // Push to news.html feed if that page is open
    ['news-feed-all', 'news-feed-manual', 'news-feed-autorun'].forEach(id => {
      const feed = document.getElementById(id);
      if (!feed) return;
      // Filter by tab
      if (id === 'news-feed-manual'  && entry.mode === 'autorun') return;
      if (id === 'news-feed-autorun' && entry.mode === 'manual')  return;
      const div = _makeNewsEl(entry);
      feed.prepend(div);
      while (feed.children.length > 100) feed.removeChild(feed.lastChild);
    });
  },

  refreshNews() {
    if (typeof window.renderNewsPage === 'function') window.renderNewsPage();
  },
};

/* ─────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────── */

function _tfLabel(gran) {
  return { 60:'M1', 120:'M2', 300:'M5', 600:'M10', 900:'M15',
           1800:'M30', 3600:'H1', 14400:'H4' }[gran] || `${gran}s`;
}

// Force direction on Boom/Crash indices
function _applyBias(symbol, direction) {
  if (symbol && symbol.startsWith('BOOM'))  return 'BUY';
  if (symbol && symbol.startsWith('CRASH')) return 'SELL';
  return direction;
}

function _currentBalance() {
  return window.DerivAuth && DerivAuth.getAccount()
    ? parseFloat(DerivAuth.getAccount().balance) || 0
    : 0;
}

// Post-trade: balance guard + continue/end logic
function _postTrade(result, signal, mode) {
  const B     = window.BriNovs;
  const stake = B?.stake || 10;
  const bal   = _currentBalance();

  // Balance guard
  if (bal > 0 && bal < stake * 2) {
    const msg = `Balance guard: $${bal.toFixed(2)} < 2× stake ($${(stake*2).toFixed(2)}). Bot halted.`;
    BotSession.log('warn', msg);
    if (mode === 'manual')  BotRunner.stop(msg);
    else                    AutoRunEngine.disable(msg);
    return;
  }

  if (mode === 'manual') {
    const s = BotSession.manual;
    if (!s.active) return;
    if (s.runsLeft !== Infinity) {
      s.runsLeft--;
      if (s.runsLeft <= 0) { BotRunner.stop('All runs completed.'); return; }
    }
    BotSession.confirmCountdown = 0;
    BotRunner._waitForSignal('manual');
  } else {
    if (!BotSession.autorun.enabled) return;
    BotSession.confirmCountdown = 0;
    BotRunner._waitForSignal('autorun');
  }
}

function _logSummary(mode) {
  const s   = mode === 'manual' ? BotSession.manual : BotSession.autorun;
  const dur = s.startTime
    ? Math.round((Date.now() - s.startTime) / 60000) + ' min'
    : '—';
  const wr  = s.runsDone > 0 ? Math.round(s.wins / s.runsDone * 100) : 0;
  const nl  = s.netPL >= 0 ? '+' : '';
  BotSession.log('system',
    `── SESSION SUMMARY ── Trades: ${s.runsDone} | ` +
    `Wins: ${s.wins} | Losses: ${s.losses} | Win rate: ${wr}% | ` +
    `Net P&L: ${nl}$${s.netPL.toFixed(2)} | Duration: ${dur}`
  );
}

function _makeNewsEl(entry) {
  const div = document.createElement('div');
  div.className = `news-entry news-${entry.type}`;
  div.innerHTML =
    `<span class="ne-time">${entry.time}</span>` +
    `<span class="ne-text">${entry.text}</span>`;
  return div;
}

/* ─────────────────────────────────────────────
   INIT
───────────────────────────────────────────── */
function initAutoBot() {
  BotUI.init();
  window.BotSession    = BotSession;
  window.BotRunner     = BotRunner;
  window.AutoRunEngine = AutoRunEngine;
  window.TradeEngine   = TradeEngine;
  window.BotUI         = BotUI;
}

if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', initAutoBot);
else
  initAutoBot();
