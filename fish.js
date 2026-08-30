/* Potion Fusion — aquarium fish engine.
 * Pure model + parametric canvas renderer; loads in the browser (window.PFFish)
 * and in node (module.exports) so the growth math is unit-tested.
 *
 * GROWTH BALANCE ("never out of proportion"):
 *   Food supply: +1 flake per completed order vial (+2 on HARD levels),
 *   i.e. ~2.2 flakes per level on average.
 *   Growth is SATURATING, not linear:  frac = 1 - e^(-fed / k)
 *   - early flakes matter most (visible progress immediately),
 *   - k is per-species (small fish mature on ~25 flakes, a catfish on ~60),
 *   - no amount of food pushes frac past 1, and the on-screen size is
 *     additionally hard-clamped: px = base * (0.55 + 0.45 * frac).
 *   With ~10 fish sharing the supply a favorite reaches ~60% growth in
 *   roughly 25 focused levels; maxing a big species is a long-term goal. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.PFFish = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* Species table. Rarity drives the draw odds (`w` = default weight, higher
   * = more common); the ops console can override any weight live via the
   * fish_w_<slug> remote-config keys. IMPORTANT: fish are saved by INDEX into
   * this array, so new species are only ever APPENDED — never reordered. */
  var SPECIES = [
    { name: 'Goldfish',  h: 0.62, tail: 'fan',    base: 34, minCm: 3, maxCm: 10, k: 40, rarity: 0, w: 100 },
    { name: 'Tetra',     h: 0.40, tail: 'fork',   base: 26, minCm: 2, maxCm: 5,  k: 28, rarity: 0, w: 100 },
    { name: 'Angelfish', h: 0.98, tail: 'fork',   base: 30, minCm: 4, maxCm: 12, k: 50, tall: 1, rarity: 2, w: 24 },
    { name: 'Puffer',    h: 0.82, tail: 'small',  base: 30, minCm: 5, maxCm: 14, k: 55, spikes: 1, rarity: 3, w: 9 },
    { name: 'Betta',     h: 0.55, tail: 'flow',   base: 28, minCm: 3, maxCm: 7,  k: 34, rarity: 1, w: 55 },
    { name: 'Catfish',   h: 0.44, tail: 'fan',    base: 38, minCm: 6, maxCm: 18, k: 60, whiskers: 1, rarity: 2, w: 24 },
    { name: 'Clownfish', h: 0.58, tail: 'fan',    base: 28, minCm: 4, maxCm: 8,  k: 38, bands: 1, rarity: 1, w: 55 },
    { name: 'Guppy',     h: 0.48, tail: 'bigfan', base: 22, minCm: 2, maxCm: 4,  k: 24, rarity: 0, w: 100 },
    // v2.8 — appended for the album chase
    { name: 'Koi',       h: 0.60, tail: 'fan',    base: 40, minCm: 8, maxCm: 24, k: 62, bands: 1, rarity: 2, w: 22 },
    { name: 'Lionfish',  h: 0.72, tail: 'flow',   base: 32, minCm: 5, maxCm: 15, k: 56, spikes: 1, bands: 1, rarity: 3, w: 8 },
    { name: 'Dragonet',  h: 0.52, tail: 'flow',   base: 27, minCm: 3, maxCm: 7,  k: 36, rarity: 2, w: 20 },
    { name: 'Moonfish',  h: 1.02, tail: 'small',  base: 44, minCm: 10, maxCm: 30, k: 70, tall: 1, rarity: 4, w: 3 },
  ];
  var RARITY = [
    { name: 'COMMON',    col: '#9fb4d8' },
    { name: 'UNCOMMON',  col: '#3ddc84' },
    { name: 'RARE',      col: '#3fa9ff' },
    { name: 'EPIC',      col: '#c976ff' },
    { name: 'LEGENDARY', col: '#ffc93c' },
  ];
  // stable config slug for a species, e.g. 'fish_w_goldfish'
  function slug(sp) { return String(sp.name).toLowerCase().replace(/[^a-z0-9]+/g, ''); }

  /* Weighted species draw. `weights` (optional) maps slug -> weight and comes
   * from remote config, so live-ops can retune the drop table without a build.
   * Falls back to the table's own `w`; a total of 0 degrades to uniform. */
  function pickSpecies(rnd, weights) {
    var i, w, tot = 0, ws = [];
    for (i = 0; i < SPECIES.length; i++) {
      w = weights && weights[slug(SPECIES[i])];
      w = (typeof w === 'number' && isFinite(w) && w >= 0) ? w : SPECIES[i].w;
      ws.push(w); tot += w;
    }
    if (tot <= 0) return Math.floor(rnd() * SPECIES.length);
    var r = rnd() * tot;
    for (i = 0; i < ws.length; i++) { r -= ws[i]; if (r <= 0) return i; }
    return ws.length - 1;
  }
  // odds each species is drawn, as percentages (album + ops parity)
  function odds(weights) {
    var i, w, tot = 0, ws = [];
    for (i = 0; i < SPECIES.length; i++) {
      w = weights && weights[slug(SPECIES[i])];
      w = (typeof w === 'number' && isFinite(w) && w >= 0) ? w : SPECIES[i].w;
      ws.push(w); tot += w;
    }
    return ws.map(function (x) { return tot > 0 ? x / tot : 1 / ws.length; });
  }

  /* ---------- hunger (v2.8): fish must be fed or they swim away ----------
   * Stages by hours since the last flake: fed -> hungry -> starving -> lost.
   * Pure function of (fish, now, cfg) so the timings are unit-tested and the
   * ops console can retune them live. */
  var HUNGER = { hungryH: 24, starveH: 48, loseH: 72 };
  function hoursSinceFed(f, now) {
    if (!f || !f.lastFed) return 0;
    return Math.max(0, (now - f.lastFed) / 3600000);
  }
  function hungerState(f, now, cfg) {
    var c = cfg || HUNGER;
    var h = hoursSinceFed(f, now);
    if (h >= (c.loseH != null ? c.loseH : HUNGER.loseH)) return 'lost';
    if (h >= (c.starveH != null ? c.starveH : HUNGER.starveH)) return 'starving';
    if (h >= (c.hungryH != null ? c.hungryH : HUNGER.hungryH)) return 'hungry';
    return 'fed';
  }
  // hours left before this fish is lost (0 = gone)
  function hoursLeft(f, now, cfg) {
    var c = cfg || HUNGER;
    return Math.max(0, (c.loseH != null ? c.loseH : HUNGER.loseH) - hoursSinceFed(f, now));
  }

  var COLORS = ['#ff5f7e', '#ff9f2e', '#ffd93d', '#3ddc84', '#3fa9ff', '#c976ff',
                '#ff7ab8', '#5ee7d4', '#f4f6ff', '#ffb36b'];
  var NAMES = ['Bloop', 'Finn', 'Splash', 'Pearl', 'Coral', 'Echo', 'Marble', 'Sunny',
               'Pip', 'Nova', 'Biscuit', 'Wiggles', 'Momo', 'Zippy', 'Luna', 'Pesto',
               'Dot', 'Fizz', 'Gill', 'Comet', 'Taffy', 'Bubbla', 'Squirt', 'Mango'];

  function growthFrac(fed, sp) { return 1 - Math.exp(-Math.max(0, fed) / sp.k); }
  function sizePx(f) {
    var sp = SPECIES[f.sp];
    return sp.base * (0.55 + 0.45 * growthFrac(f.fed, sp));
  }
  function sizeCm(f) {
    var sp = SPECIES[f.sp];
    return +(sp.minCm + growthFrac(f.fed, sp) * (sp.maxCm - sp.minCm)).toFixed(1);
  }
  // growth fraction for a fish instance; >= 0.75 counts as fully grown
  function frac(f) { return growthFrac(f.fed, SPECIES[f.sp]); }
  function isAdult(f) { return frac(f) >= 0.75; }
  /* Beauty a fish contributes to its tank (v2.9): rarer is prettier, and a
   * well-grown specimen is worth more than a hatchling. Decor still carries
   * most of a tank's beauty — fish are the reward for collecting, not a
   * substitute for decorating. */
  function beauty(f) {
    var sp = SPECIES[f.sp];
    return Math.round((sp.rarity + 1) * 5 * (1 + frac(f) * 0.5));
  }

  // rnd: () => [0,1). Deterministic given the caller's PRNG.
  function mkFish(rnd, level, id, weights, now) {
    var sp = pickSpecies(rnd, weights);
    var c1 = COLORS[Math.floor(rnd() * COLORS.length)];
    var c2 = c1;
    while (c2 === c1) c2 = COLORS[Math.floor(rnd() * COLORS.length)];
    return {
      id: id || ('f' + Math.floor(rnd() * 1e9).toString(36) + level),
      name: NAMES[Math.floor(rnd() * NAMES.length)],
      sp: sp,
      c1: c1, c2: c2,
      pat: Math.floor(rnd() * 3),      // 0 solid, 1 stripes, 2 spots
      level: level,                     // origin level
      fed: 0,
      lastFed: now || Date.now(),       // hunger clock (v2.8)
      ph: rnd() * 7,                    // personal animation phase
    };
  }
  function randomName(rnd) { return NAMES[Math.floor((rnd ? rnd() : Math.random()) * NAMES.length)]; }
  function speciesName(f) { return SPECIES[f.sp].name; }

  /* ---------- renderer (side view, faces +x; pass dir=-1 to flip) ---------- */
  function draw(ctx, f, x, y, t, dir, scale) {
    var sp = SPECIES[f.sp];
    var L = sizePx(f) * (scale || 1);           // body length
    var H = L * (sp.tall ? 0.85 : sp.spikes ? 0.78 : 0.52);
    var sway = Math.sin(t * 6 + f.ph) * 0.10;
    var tailSw = Math.sin(t * 9 + f.ph) * 0.45;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(dir || 1, 1);
    ctx.rotate(sway * 0.25);

    // tail
    ctx.fillStyle = f.c2;
    ctx.save();
    ctx.translate(-L * 0.48, 0);
    ctx.rotate(tailSw * 0.35);
    ctx.beginPath();
    if (sp.tail === 'flow') {
      ctx.moveTo(0, 0);
      ctx.bezierCurveTo(-L * 0.55, -H * 0.9, -L * 0.95, -H * 0.2, -L * 0.7, tailSw * 4);
      ctx.bezierCurveTo(-L * 0.95, H * 0.5, -L * 0.5, H * 0.85, 0, 0);
    } else if (sp.tail === 'fork') {
      ctx.moveTo(0, 0); ctx.lineTo(-L * 0.42, -H * 0.62); ctx.lineTo(-L * 0.24, 0);
      ctx.lineTo(-L * 0.42, H * 0.62); ctx.closePath();
    } else if (sp.tail === 'bigfan') {
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, L * 0.52, Math.PI - 0.9 + tailSw * 0.2, Math.PI + 0.9 + tailSw * 0.2);
      ctx.closePath();
    } else if (sp.tail === 'small') {
      ctx.moveTo(0, 0); ctx.lineTo(-L * 0.28, -H * 0.35); ctx.lineTo(-L * 0.28, H * 0.35); ctx.closePath();
    } else { // fan
      ctx.moveTo(0, 0); ctx.lineTo(-L * 0.4, -H * 0.55); ctx.lineTo(-L * 0.3, 0);
      ctx.lineTo(-L * 0.4, H * 0.55); ctx.closePath();
    }
    ctx.fill();
    ctx.restore();

    // dorsal / ventral fins
    ctx.fillStyle = f.c2;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    if (sp.tall) { // angelfish sails
      ctx.moveTo(-L * 0.1, -H * 0.45); ctx.quadraticCurveTo(L * 0.05, -H * 1.15, L * 0.22, -H * 0.4);
      ctx.moveTo(-L * 0.1, H * 0.45); ctx.quadraticCurveTo(L * 0.05, H * 1.15, L * 0.22, H * 0.4);
    } else {
      ctx.moveTo(-L * 0.15, -H * 0.48); ctx.quadraticCurveTo(L * 0.02, -H * 0.95, L * 0.18, -H * 0.45);
    }
    ctx.fill();
    ctx.globalAlpha = 1;

    // body
    var grad = ctx.createLinearGradient(0, -H * 0.6, 0, H * 0.6);
    grad.addColorStop(0, f.c1);
    grad.addColorStop(1, shade(f.c1, -28));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(0, 0, L * 0.5, H * 0.5, 0, 0, 7);
    ctx.fill();

    // pattern
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(0, 0, L * 0.5, H * 0.5, 0, 0, 7);
    ctx.clip();
    if (sp.bands) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-L * 0.08, -H, L * 0.13, H * 2);
      ctx.fillRect(L * 0.22, -H, L * 0.11, H * 2);
      ctx.fillStyle = f.c2;
      ctx.fillRect(-L * 0.34, -H, L * 0.1, H * 2);
    } else if (f.pat === 1) {
      ctx.fillStyle = f.c2;
      ctx.globalAlpha = 0.8;
      for (var s = -1; s <= 1; s++) ctx.fillRect(s * L * 0.18 - L * 0.035, -H, L * 0.07, H * 2);
      ctx.globalAlpha = 1;
    } else if (f.pat === 2) {
      ctx.fillStyle = f.c2;
      ctx.globalAlpha = 0.85;
      dot(ctx, -L * 0.15, -H * 0.12, L * 0.06);
      dot(ctx, L * 0.1, H * 0.14, L * 0.05);
      dot(ctx, L * 0.02, -H * 0.22, L * 0.045);
      dot(ctx, -L * 0.28, H * 0.1, L * 0.045);
      ctx.globalAlpha = 1;
    }
    // belly shine
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.ellipse(-L * 0.05, H * 0.18, L * 0.34, H * 0.2, 0, 0, 7);
    ctx.fill();
    ctx.restore();

    // puffer spikes
    if (sp.spikes) {
      ctx.strokeStyle = shade(f.c1, -40);
      ctx.lineWidth = Math.max(1.5, L * 0.05);
      ctx.lineCap = 'round';
      for (var a = 0; a < 10; a++) {
        var ang = a / 10 * Math.PI * 2 + 0.3;
        ctx.beginPath();
        ctx.moveTo(Math.cos(ang) * L * 0.44, Math.sin(ang) * H * 0.44);
        ctx.lineTo(Math.cos(ang) * L * 0.56, Math.sin(ang) * H * 0.58);
        ctx.stroke();
      }
    }
    // whiskers
    if (sp.whiskers) {
      ctx.strokeStyle = shade(f.c1, -35);
      ctx.lineWidth = Math.max(1.2, L * 0.035);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(L * 0.42, H * 0.1); ctx.quadraticCurveTo(L * 0.62, H * 0.05, L * 0.68, H * 0.28);
      ctx.moveTo(L * 0.42, H * 0.18); ctx.quadraticCurveTo(L * 0.58, H * 0.28, L * 0.6, H * 0.46);
      ctx.stroke();
    }

    // side fin
    ctx.fillStyle = f.c2;
    ctx.save();
    ctx.translate(L * 0.02, H * 0.12);
    ctx.rotate(0.5 + Math.sin(t * 10 + f.ph) * 0.3);
    ctx.beginPath();
    ctx.ellipse(0, 0, L * 0.16, H * 0.16, 0, 0, 7);
    ctx.fill();
    ctx.restore();

    // eye + mouth
    ctx.fillStyle = '#ffffff';
    dot(ctx, L * 0.3, -H * 0.12, Math.max(2.4, L * 0.085));
    ctx.fillStyle = '#241a3a';
    dot(ctx, L * 0.32, -H * 0.12, Math.max(1.3, L * 0.045));
    ctx.strokeStyle = shade(f.c1, -45);
    ctx.lineWidth = Math.max(1.2, L * 0.03);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(L * 0.44, H * 0.06, L * 0.05, 0.4, 2.2);
    ctx.stroke();

    ctx.restore();
  }

  function dot(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); }
  function shade(hex, amt) {
    var n = parseInt(hex.slice(1), 16);
    var r = Math.max(0, Math.min(255, (n >> 16) + amt));
    var g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt));
    var b = Math.max(0, Math.min(255, (n & 255) + amt));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  return {
    SPECIES: SPECIES, COLORS: COLORS, NAMES: NAMES, RARITY: RARITY, HUNGER: HUNGER,
    mkFish: mkFish, growthFrac: growthFrac, sizePx: sizePx, sizeCm: sizeCm,
    frac: frac, isAdult: isAdult, beauty: beauty, slug: slug, pickSpecies: pickSpecies, odds: odds,
    hoursSinceFed: hoursSinceFed, hungerState: hungerState, hoursLeft: hoursLeft,
    randomName: randomName, speciesName: speciesName, draw: draw,
  };
});
