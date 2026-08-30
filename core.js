/* Potion Fusion — core game logic: rules, level generator, solver.
 * Pure and dependency-free; loads in the browser (window.PF) and in node
 * (module.exports) so the same code is unit-tested and build-verified. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.PF = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CAP = 4;
  const PRIMARIES = ['R', 'Y', 'B'];
  // primaries fuse to secondaries; a secondary + one primary fuses on to a
  // tertiary (TEAL/MAGENTA/LIME) — tertiary recipes only activate on levels
  // that actually feature the color (see colorActive) so the base game
  // stays clean until each one is introduced
  const MIX = {
    RY: 'O', YR: 'O', YB: 'G', BY: 'G', RB: 'P', BR: 'P',
    GB: 'T', BG: 'T', PR: 'M', RP: 'M', GY: 'L', YG: 'L',
  };
  const COMPONENTS = {
    O: ['R', 'Y'], G: ['Y', 'B'], P: ['R', 'B'],
    T: ['G', 'B'], M: ['P', 'R'], L: ['G', 'Y'],
  };
  const NAMES = {
    R: 'RED', Y: 'YELLOW', B: 'BLUE', O: 'ORANGE', G: 'GREEN', P: 'PURPLE',
    T: 'TEAL', M: 'MAGENTA', L: 'LIME',
  };
  const TERTIARY = { T: 14, M: 22, L: 30 };   // color -> level it debuts

  function isPrimary(c) { return c === 'R' || c === 'Y' || c === 'B'; }
  function mixOf(a, b) { return MIX[a + b] || null; }
  // a tertiary recipe is live only when the level features the color
  function colorActive(st, c) {
    for (const f of st.flasks) {
      if (f.order === c) return true;
      for (const u of f.units) if (u === c) return true;
    }
    return false;
  }

  /* ---------- state ---------- */
  // flask: { units: ['R',...bottom→top], order: null|'O'|..., done: bool }
  // state: { flasks: [flask, ...] }

  function flask(units, order) {
    return { units: units.slice(), order: order || null, done: false };
  }
  function cloneState(st) {
    return {
      flasks: st.flasks.map(f => ({ units: f.units.slice(), order: f.order, done: f.done })),
    };
  }
  function topRun(units) {
    const n = units.length;
    if (!n) return null;
    const c = units[n - 1];
    let k = 1;
    while (k < n && units[n - 1 - k] === c) k++;
    return { color: c, len: k };
  }

  /* ---------- move legality & application ---------- */
  // Returns {legal, kind:'transfer'|'fusion', count, color, mixColor?, reason?}
  function moveInfo(st, i, j) {
    if (i === j) return { legal: false, reason: 'same' };
    const s = st.flasks[i], d = st.flasks[j];
    if (!s || !d) return { legal: false, reason: 'bad-index' };
    if (!s.units.length) return { legal: false, reason: 'empty-source' };
    if (s.order) return { legal: false, reason: 'order-oneway' };
    if (d.done) return { legal: false, reason: 'order-done' };
    const run = topRun(s.units);
    const c = run.color, k = run.len;

    if (d.order) {
      if (c !== d.order) return { legal: false, reason: 'order-color', want: d.order, got: c };
      const space = CAP - d.units.length;
      if (space <= 0) return { legal: false, reason: 'full' };
      return { legal: true, kind: 'transfer', count: Math.min(k, space), color: c };
    }
    if (!d.units.length) {
      return { legal: true, kind: 'transfer', count: Math.min(k, CAP), color: c };
    }
    const dRun = topRun(d.units);
    const t = dRun.color;
    if (t === c) {
      const space = CAP - d.units.length;
      if (space <= 0) return { legal: false, reason: 'full' };
      return { legal: true, kind: 'transfer', count: Math.min(k, space), color: c };
    }
    const mx = mixOf(c, t);
    if (mx && (isPrimary(c) && isPrimary(t) || colorActive(st, mx))) {
      const p = Math.min(k, dRun.len);
      return { legal: true, kind: 'fusion', count: p, color: c, other: t, mixColor: mx };
    }
    return { legal: false, reason: 'no-mix', got: c, top: t };
  }

  // Applies move in place on a clone; returns {state, info, completedOrder} or null.
  function applyMove(st, i, j) {
    const info = moveInfo(st, i, j);
    if (!info.legal) return null;
    const nst = cloneState(st);
    const s = nst.flasks[i], d = nst.flasks[j];
    if (info.kind === 'transfer') {
      for (let n = 0; n < info.count; n++) d.units.push(s.units.pop());
    } else { // fusion: each poured unit converts one top unit of d in place
      for (let n = 0; n < info.count; n++) s.units.pop();
      const dl = d.units.length;
      for (let n = 0; n < info.count; n++) d.units[dl - 1 - n] = info.mixColor;
    }
    let completedOrder = false;
    if (d.order && d.units.length === CAP) { d.done = true; completedOrder = true; }
    return { state: nst, info, completedOrder };
  }

  /* ---------- powerups (v3.0) ----------
   * Player tools that bend the pour rules. The solver deliberately does NOT
   * model them: every level stays solvable with pours alone, so a powerup is
   * always a shortcut or a rescue, never a requirement.
   *
   * PIPETTE  — draw off the top unit of a work flask (it is discarded).
   *            The answer to one contaminating drop on an otherwise clean stack.
   * CATALYST — un-fuse the top unit of a composite colour back into the two
   *            colours it was made from, in place. Fusion destroys volume
   *            (1+1 -> 1); the catalyst gives that unit back, so it needs one
   *            free space in the flask. */
  function pipetteInfo(st, i) {
    const f = st.flasks[i];
    if (!f) return { legal: false, reason: 'bad-index' };
    if (f.order) return { legal: false, reason: 'order-oneway' };
    if (!f.units.length) return { legal: false, reason: 'empty' };
    return { legal: true, color: f.units[f.units.length - 1] };
  }
  function applyPipette(st, i) {
    const info = pipetteInfo(st, i);
    if (!info.legal) return null;
    const nst = cloneState(st);
    nst.flasks[i].units.pop();
    return { state: nst, info };
  }
  function catalystInfo(st, i) {
    const f = st.flasks[i];
    if (!f) return { legal: false, reason: 'bad-index' };
    if (f.order) return { legal: false, reason: 'order-oneway' };
    if (!f.units.length) return { legal: false, reason: 'empty' };
    const c = f.units[f.units.length - 1];
    const comp = COMPONENTS[c];
    if (!comp) return { legal: false, reason: 'primary', got: c };
    if (f.units.length >= CAP) return { legal: false, reason: 'full', got: c };
    return { legal: true, color: c, into: comp };
  }
  function applyCatalyst(st, i) {
    const info = catalystInfo(st, i);
    if (!info.legal) return null;
    const nst = cloneState(st);
    const f = nst.flasks[i];
    f.units.pop();
    f.units.push(info.into[0], info.into[1]);
    return { state: nst, info };
  }
  // flasks a given powerup can legally target right now (for target highlighting)
  function powerTargets(st, kind) {
    const out = [];
    const probe = kind === 'catalyst' ? catalystInfo : pipetteInfo;
    for (let i = 0; i < st.flasks.length; i++) if (probe(st, i).legal) out.push(i);
    return out;
  }

  function legalMoves(st) {
    const out = [];
    for (let i = 0; i < st.flasks.length; i++) {
      if (!st.flasks[i].units.length || st.flasks[i].order) continue;
      for (let j = 0; j < st.flasks.length; j++) {
        if (i === j) continue;
        if (moveInfo(st, i, j).legal) out.push([i, j]);
      }
    }
    return out;
  }

  function isWon(st) {
    return st.flasks.every(f => !f.order || f.done);
  }

  /* Material feasibility: false => provably dead (not enough potion left).
     Tries all orders of allocating shared primary components (≤3 open orders). */
  function materialOk(st) {
    const counts = {};
    for (const f of st.flasks) if (!f.order) for (const u of f.units) counts[u] = (counts[u] || 0) + 1;
    const needs = [];
    for (const f of st.flasks) if (f.order && !f.done) needs.push({ color: f.order, q: CAP - f.units.length });
    if (!needs.length) return true;
    const perms = permutations(needs);
    outer: for (const perm of perms) {
      const c = Object.assign({}, counts);
      for (const nd of perm) {
        if (!takeUnits(c, nd.color, nd.q)) continue outer;
      }
      return true;
    }
    return false;
  }
  // consume q units of color from counts c, recursively manufacturing from
  // components (tertiary -> secondary -> primaries) when direct stock runs out
  function takeUnits(c, color, q) {
    const have = Math.min(q, c[color] || 0);
    c[color] = (c[color] || 0) - have;
    q -= have;
    if (q <= 0) return true;
    const comp = COMPONENTS[color];
    if (!comp) return false;   // primary shortfall is terminal
    return takeUnits(c, comp[0], q) && takeUnits(c, comp[1], q);
  }
  function permutations(arr) {
    if (arr.length <= 1) return [arr];
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const rest = arr.slice(0, i).concat(arr.slice(i + 1));
      for (const p of permutations(rest)) out.push([arr[i]].concat(p));
    }
    return out;
  }

  /* ---------- solver: best-first search ---------- */
  function stateKey(st) {
    return st.flasks
      .map(f => (f.order ? f.order + (f.done ? '!' : '?') : '.') + f.units.join(''))
      .sort()
      .join('#');
  }
  function heuristic(st) {
    let h = 0;
    for (const f of st.flasks) {
      if (f.order && !f.done) {
        const missing = CAP - f.units.length;
        h += missing; // deliveries
        if (COMPONENTS[f.order]) {
          h += missing; // fusions still required (≤ missing)
          const cc = COMPONENTS[f.order];
          // tertiary orders usually need the mid-tier color fused first too
          if (COMPONENTS[cc[0]] || COMPONENTS[cc[1]]) h += missing * 0.5;
        }
      }
    }
    // fragmentation: count color runs beyond 1 per flask
    for (const f of st.flasks) {
      if (f.order) continue;
      let runs = 0;
      for (let i = 0; i < f.units.length; i++) if (i === 0 || f.units[i] !== f.units[i - 1]) runs++;
      if (runs > 1) h += (runs - 1) * 0.25;
    }
    return h;
  }

  // Returns array of [i,j] moves or null. opts: {maxNodes, maxDepth}
  function solve(st, opts) {
    opts = opts || {};
    const maxNodes = opts.maxNodes || 80000;
    const maxDepth = opts.maxDepth || 64;
    if (isWon(st)) return [];
    const seen = new Set([stateKey(st)]);
    // simple binary heap on f = g*0.4 + h
    const heap = [{ st, g: 0, f: heuristic(st), path: [] }];
    let nodes = 0;
    while (heap.length && nodes < maxNodes) {
      // pop min f
      let bi = 0;
      for (let i = 1; i < heap.length; i++) if (heap[i].f < heap[bi].f) bi = i;
      const cur = heap[bi];
      heap[bi] = heap[heap.length - 1];
      heap.pop();
      nodes++;
      if (cur.g >= maxDepth) continue;
      for (const [i, j] of legalMoves(cur.st)) {
        const res = applyMove(cur.st, i, j);
        if (!res) continue;
        const key = stateKey(res.state);
        if (seen.has(key)) continue;
        seen.add(key);
        const path = cur.path.concat([[i, j]]);
        if (isWon(res.state)) return path;
        if (!materialOk(res.state)) continue;
        heap.push({ st: res.state, g: cur.g + 1, f: (cur.g + 1) * 0.4 + heuristic(res.state), path });
      }
    }
    return null;
  }

  /* ---------- deterministic PRNG ---------- */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rnd) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /* ---------- level generation ---------- */
  const HAND_MADE = {
    1: { work: [['R', 'R', 'R', 'R'], ['Y', 'Y', 'Y', 'Y']], empties: 0, orders: ['O'] },
    2: { work: [['Y', 'Y', 'B', 'B'], ['B', 'B', 'Y', 'Y']], empties: 1, orders: ['G'] },
    3: { work: [['R', 'B', 'R', 'B'], ['B', 'R', 'B', 'R']], empties: 1, orders: ['P'] },
  };

  function levelParams(n, rnd, tertN) {
    const orders = [];
    let nOrders = 1;
    if (n >= 4) nOrders = 2;
    if (n >= 6) nOrders = 2 + (rnd() < 0.6 ? 1 : 0);
    if (n >= 9) nOrders = 2 + (rnd() < 0.85 ? 1 : 0);
    const secs = shuffle(['O', 'G', 'P'], rnd);
    for (let i = 0; i < nOrders; i++) {
      if (n >= 8 && i === nOrders - 1 && rnd() < Math.min(0.2 + n * 0.01, 0.45)) {
        orders.push(PRIMARIES[Math.floor(rnd() * 3)]); // a primary order: don't over-fuse!
      } else {
        orders.push(secs[i % 3]);
      }
    }
    // tertiary colors join the rotation as they debut (guaranteed on the
    // debut level so the intro toast always matches the board); gate on the
    // REAL level (tertN) — the smith's difficulty jitter must neither leak a
    // color early nor miss a debut
    const tn = tertN == null ? n : tertN;
    const terts = [];
    for (const t in TERTIARY) if (tn >= TERTIARY[t]) terts.push(t);
    if (terts.length) {
      if (TERTIARY[terts[terts.length - 1]] === tn) orders[0] = terts[terts.length - 1];
      else if (rnd() < 0.4) orders[0] = terts[Math.floor(rnd() * terts.length)];
    }
    let leftovers = 0;
    if (n >= 4) leftovers = 2 + Math.floor(rnd() * Math.min(2 + Math.floor(n / 4), 7));
    // slack = spare space. Squeezing it is the single strongest difficulty dial.
    let slack = n < 4 ? 6 : n < 6 ? 4 : n < 12 ? 3 : 2;
    const minSol = n < 4 ? 2 : Math.min(8 + Math.floor(n / 2), 24);
    // premix: share of composite-order units that start on the board already
    // mixed; secLeftovers: distractor secondaries may appear among the
    // leftovers later on
    // less pre-mixed potion = more fusing to plan for
    const premix = n < 4 ? 0 : Math.max(0.05, Math.min(0.30 - n * 0.004, 0.28));
    return { orders, leftovers, slack, minSol, premix, secLeftovers: n >= 6 };
  }

  const SECONDARIES = ['O', 'G', 'P'];
  // shared raw-unit builder for all candidate generators
  function rawUnits(params, rnd) {
    const raw = [];
    const premix = params.premix || 0;
    for (const o of params.orders) {
      const comp = COMPONENTS[o];
      if (comp) {
        for (let i = 0; i < CAP; i++) {
          if (rnd() < premix) { raw.push(o); continue }  // ready-made unit
          for (const part of comp) {
            const sub = COMPONENTS[part];
            // tertiary chains: half the time the mid-tier color must itself
            // be fused from its primaries first
            if (sub && rnd() < 0.5) raw.push(sub[0], sub[1]);
            else raw.push(part);
          }
        }
      } else {
        for (let i = 0; i < CAP; i++) raw.push(o);
      }
    }
    for (let i = 0; i < params.leftovers; i++) {
      if (params.secLeftovers && rnd() < 0.25) raw.push(SECONDARIES[Math.floor(rnd() * 3)]);
      else raw.push(PRIMARIES[Math.floor(rnd() * 3)]);
    }
    return raw;
  }

  function buildCandidate(params, rnd) {
    const raw = rawUnits(params, rnd);
    shuffle(raw, rnd);
    const nWork = Math.ceil((raw.length + params.slack) / CAP);
    const work = [];
    for (let i = 0; i < nWork; i++) work.push([]);
    // deal units into random non-full work flasks
    for (const u of raw) {
      let idx;
      do { idx = Math.floor(rnd() * nWork); } while (work[idx].length >= CAP);
      work[idx].push(u);
    }
    const flasks = work.map(u => flask(u, null));
    for (const o of params.orders) flasks.push(flask([], o));
    return { flasks };
  }

  /* ---------- smith: bot-playtested level foundry (shared by the build
     tool and the in-game background generator) ---------- */
  function buildTrappy(params, rnd) {
    const raw = rawUnits(params, rnd);
    raw.sort();
    const nWork = Math.ceil((raw.length + params.slack) / CAP);
    const work = [];
    for (let i = 0; i < nWork; i++) work.push([]);
    let w = Math.floor(rnd() * nWork);
    for (const u of raw) {
      let guard = 0;
      while (work[w % nWork].length >= CAP && guard++ <= nWork) w++;
      work[w % nWork].push(u);
      w++;
    }
    const flasks = work.map(u => flask(u, null));
    for (const o of params.orders) flasks.push(flask([], o));
    return { flasks };
  }

  /* Designed difficulty curve: steady ramp + breathers + HARD spike every 8th.
   * Retuned in v3.0 against a measured bot-win-rate audit — the v2.7 curve
   * still let the greedy bot win ~99% of levels 1-10 and ~93% of 11-20, i.e.
   * the retention window was a free ride. Levels 1-3 stay trivial (they teach
   * the fusion rule); from 4 on the ramp is roughly twice as steep and starts
   * higher, and the ceiling lifts to 0.84. The v3.0 powerups are the safety
   * net that makes this fair. */
  function smithTarget(n) {
    if (n <= 3) return { d: 0.03, hard: false };
    let d = 0.20 + 0.64 * (1 - Math.exp(-(n - 3) / 16));
    let hard = false;
    if (n % 8 === 0) { d += 0.16; hard = true; }
    else if (n % 5 === 4) d -= 0.06;
    return { d: Math.max(0.03, Math.min(0.86, d)), hard };
  }

  // greedy human-like playtester: no lookahead, delivers eagerly, over-fuses
  function botRollout(state, rnd, moveCap) {
    let st = cloneState(state);
    let last = null;
    for (let mv = 0; mv < moveCap; mv++) {
      if (isWon(st)) return true;
      const moves = legalMoves(st);
      if (!moves.length || !materialOk(st)) return false;
      const scored = moves.map(function (m) {
        const i = m[0], j = m[1];
        const info = moveInfo(st, i, j);
        const s = st.flasks[i], d = st.flasks[j];
        let sc = 1;
        if (d.order) sc = 100;
        else if (info.kind === 'fusion') {
          let needed = 0;
          for (const f of st.flasks) if (f.order === info.mixColor && !f.done) needed += (CAP - f.units.length);
          sc = needed > 0 ? 55 + info.count * 4 : 6;
        } else if (!d.units.length) {
          const mono = s.units.every(u => u === s.units[0]);
          sc = mono && topRun(s.units).len === s.units.length ? 2 : 12;
        } else {
          sc = 28 + info.count * 4;
        }
        if (last && last[0] === j && last[1] === i) sc *= 0.15;
        return { m, sc };
      });
      scored.sort((a, b) => b.sc - a.sc);
      const pool = scored.slice(0, Math.min(4, scored.length));
      const tot = pool.reduce((a, x) => a + x.sc, 0);
      let r = rnd() * tot, pick = pool[0];
      for (const x of pool) { r -= x.sc; if (r <= 0) { pick = x; break; } }
      const res = applyMove(st, pick.m[0], pick.m[1]);
      if (!res) return false;
      st = res.state;
      last = pick.m;
    }
    return false;
  }

  const SMITH_BIG = { candidates: 26, candidatesHard: 52, rollouts: 64, maxNodes: 60000, hardNodes: 150000, moveCap: 90 };
  const SMITH_FAST = { candidates: 8, candidatesHard: 12, rollouts: 24, maxNodes: 30000, hardNodes: 50000, moveCap: 70 };

  /* Resumable job: each step() is one bounded chunk (a candidate's solve, or a
     batch of bot rollouts) so the game can brew levels during idle frames.
     Deterministic in n + budget — every player gets the same level. */
  function smithMakeJob(n, budget) {
    const B = budget || SMITH_FAST;
    const tgt = smithTarget(n);
    const K = tgt.hard ? B.candidatesHard : B.candidates;
    const job = { n, tgt, c: 0, best: null, cur: null, done: false, entry: null };
    function finalize() {
      let b = job.best;
      if (!b) {
        for (let a = 0; a < 40 && !b; a++) {
          const rnd = mulberry32(n * 1000 + a);
          const st = buildCandidate(levelParams(Math.max(4, n), rnd), rnd);
          if (!materialOk(st)) continue;
          const sol = solve(st, { maxNodes: 40000 });
          if (sol) b = { st, sol, d: 0.4 };
        }
      }
      job.entry = {
        f: b.st.flasks.map(fk => [fk.units.join(''), fk.order]),
        sol: b.sol, par: b.sol.length, hard: tgt.hard ? 1 : 0, d: b.d,
      };
      job.done = true;
    }
    job.step = function () {
      if (job.done) return true;
      if (!job.cur) {
        if (job.c >= K) { finalize(); return true; }
        const c = job.c;
        const seed = n * 7919 + c * 104729 + 555;
        const rnd = mulberry32(seed);
        const jn = Math.max(4, n + (c % 5) - 2 + (tgt.hard ? 12 + (c % 3) * 8 : 0));
        const params = levelParams(jn, rnd, n);
        if (tgt.hard) {
          params.slack = Math.max(2, params.slack - (1 + (c % 2)));
          params.leftovers += 1 + (c % 3);
        } else if (tgt.d > 0.55) {
          params.slack = Math.max(3, params.slack - 1);
        }
        const st = (tgt.d > 0.30 && c % 2 === 0) ? buildTrappy(params, rnd) : buildCandidate(params, rnd);
        if (!materialOk(st)) { job.c++; return false; }
        const sol = solve(st, { maxNodes: tgt.hard ? B.hardNodes : B.maxNodes });
        if (!sol || sol.length < 2) { job.c++; return false; }
        job.cur = { st, sol, rnd2: mulberry32(seed + 13), wins: 0, rolls: 0 };
        return false;
      }
      const cur = job.cur;
      const batch = Math.min(8, B.rollouts - cur.rolls);
      for (let r = 0; r < batch; r++) if (botRollout(cur.st, cur.rnd2, B.moveCap)) cur.wins++;
      cur.rolls += batch;
      if (cur.rolls >= B.rollouts) {
        const failRate = 1 - cur.wins / B.rollouts;
        const solLenNorm = Math.min(cur.sol.length / 26, 1);
        const sizeNorm = Math.min(Math.max(cur.st.flasks.length - 5, 0) / 7, 1);
        const d = +(0.70 * failRate + 0.20 * solLenNorm + 0.10 * sizeNorm).toFixed(3);
        const err = Math.abs(d - tgt.d);
        if (!job.best || err < job.best.err) job.best = { st: cur.st, sol: cur.sol, d, err };
        job.cur = null;
        job.c++;
      }
      return false;
    };
    job.result = function () { return job.entry; };
    return job;
  }

  function smithInflate(entry, n) {
    const flasks = entry.f.map(e => flask(e[0] ? e[0].split('') : [], e[1] || null));
    return { state: { flasks }, solution: entry.sol, level: n, hard: !!entry.hard, par: entry.par, d: entry.d };
  }

  let PACK = null;
  // Install a curated level pack: {levels:[{f:[[units,order],...], sol, par, hard, d}]}
  function usePack(pack) { PACK = pack && pack.levels ? pack : null; }
  function packSize() { return PACK ? PACK.levels.length : 0; }
  function fromPack(n) {
    const L = PACK.levels[n - 1];
    const flasks = L.f.map(e => flask(e[0] ? e[0].split('') : [], e[1] || null));
    return { state: { flasks }, solution: L.sol, level: n, hard: !!L.hard, par: L.par, d: L.d };
  }

  // Deterministic, solver-verified level. Curated pack first, procedural beyond it.
  function genLevel(n) {
    if (PACK && n >= 1 && n <= PACK.levels.length) return fromPack(n);
    const hm = HAND_MADE[n];
    if (hm) {
      const flasks = hm.work.map(u => flask(u, null));
      for (let i = 0; i < hm.empties; i++) flasks.push(flask([], null));
      for (const o of hm.orders) flasks.push(flask([], o));
      const st = { flasks };
      return { state: st, solution: solve(st, { maxNodes: 20000 }), level: n };
    }
    let fallback = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      const rnd = mulberry32(n * 7919 + attempt * 104729 + 12345);
      const params = levelParams(n, rnd);
      const st = buildCandidate(params, rnd);
      if (!materialOk(st)) continue;
      const sol = solve(st, { maxNodes: 60000 });
      if (!sol) continue;
      if (sol.length >= params.minSol) return { state: st, solution: sol, level: n };
      if (!fallback || sol.length > fallback.solution.length) fallback = { state: st, solution: sol, level: n };
    }
    if (fallback) return fallback;
    // last resort: an easy always-solvable layout
    const st = {
      flasks: [
        flask(['R', 'R', 'R', 'R'], null), flask(['Y', 'Y', 'Y', 'Y'], null),
        flask(['B', 'B', 'B', 'B'], null), flask([], null), flask([], null),
        flask([], 'O'), flask([], 'G'),
      ],
    };
    return { state: st, solution: solve(st, { maxNodes: 20000 }), level: n };
  }

  return {
    CAP, PRIMARIES, MIX, COMPONENTS, NAMES, TERTIARY,
    isPrimary, mixOf, colorActive, flask, cloneState, topRun,
    moveInfo, applyMove, legalMoves, isWon, materialOk,
    pipetteInfo, applyPipette, catalystInfo, applyCatalyst, powerTargets,
    stateKey, solve, genLevel, mulberry32,
    usePack, packSize, levelParams, buildCandidate,
    smith: {
      target: smithTarget, makeJob: smithMakeJob, inflate: smithInflate,
      botRollout, buildTrappy, BIG: SMITH_BIG, FAST: SMITH_FAST,
    },
  };
});
