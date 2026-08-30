/* Potion Fusion — WebGL aquarium renderer (PixiJS v7).
 * A full graphics upgrade for the aquarium: baked high-res sprite fish with
 * animated tails, real underwater refraction (displacement filter), additive
 * god-rays and caustics, parallax rocks, coral & swaying seaweed, bubble and
 * mote particles. The game UI stays on the 2D canvas layered above; if WebGL
 * is unavailable the old canvas scene is used automatically. */
(function (root) {
  'use strict';

  var app = null, view = null, okGL = null, shown = false, built = false;
  var refs = null;                     // { fish(), swim(), flakes(), sizePx(f) }
  var world, vignette, raysBox, caustics, caustics2, noiseSpr, motes = [], bubbles = [], weeds = [];
  var fishNodes = {}, flakePool = [];
  var T = 0;

  function supported() {
    if (okGL !== null) return okGL;
    try {
      var c = document.createElement('canvas');
      okGL = !!(root.PIXI && (c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch (e) { okGL = false; }
    return okGL;
  }

  /* ---------- texture bakery (offscreen 2D canvases) ---------- */
  function cnv(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function tex(c) { return PIXI.Texture.from(c); }

  function gradTex(stops, w, h) {
    var c = cnv(w || 8, h || 512), x = c.getContext('2d');
    var g = x.createLinearGradient(0, 0, 0, c.height);
    for (var i = 0; i < stops.length; i++) g.addColorStop(stops[i][0], stops[i][1]);
    x.fillStyle = g; x.fillRect(0, 0, c.width, c.height);
    return tex(c);
  }
  function glowTex(r, color) {
    var c = cnv(r * 2, r * 2), x = c.getContext('2d');
    var g = x.createRadialGradient(r, r, 0, r, r, r);
    g.addColorStop(0, color || 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, r * 2, r * 2);
    return tex(c);
  }
  function bubbleTex() {
    var c = cnv(32, 32), x = c.getContext('2d');
    x.strokeStyle = 'rgba(255,255,255,0.85)'; x.lineWidth = 2.4;
    x.beginPath(); x.arc(16, 16, 12, 0, 7); x.stroke();
    x.fillStyle = 'rgba(255,255,255,0.28)';
    x.beginPath(); x.arc(16, 16, 12, 0, 7); x.fill();
    x.fillStyle = 'rgba(255,255,255,0.95)';
    x.beginPath(); x.arc(11, 10, 3.4, 0, 7); x.fill();
    return tex(c);
  }
  function causticsTex() {
    // fine interlocking light web (reads as caustics, not as circles)
    var c = cnv(256, 256), x = c.getContext('2d');
    x.strokeStyle = 'rgba(255,255,255,0.8)';
    x.shadowColor = 'rgba(255,255,255,0.8)'; x.shadowBlur = 3;
    x.lineCap = 'round';
    for (var i = 0; i < 64; i++) {
      var px = Math.random() * 256, py = Math.random() * 256;
      var r = 10 + Math.random() * 18;
      var a0 = Math.random() * 7, sw = 1.4 + Math.random() * 2.6;
      x.lineWidth = 0.8 + Math.random() * 1.1;
      x.beginPath(); x.arc(px, py, r, a0, a0 + sw); x.stroke();
      // wrap seams so the tile repeats cleanly
      if (px < 30 || px > 226 || py < 30 || py > 226) {
        x.beginPath();
        x.arc(((px + 128) % 256 + 256) % 256, ((py + 128) % 256 + 256) % 256, r, a0, a0 + sw);
        x.stroke();
      }
    }
    var t = tex(c);
    t.baseTexture.wrapMode = PIXI.WRAP_MODES.REPEAT;
    return t;
  }
  function noiseTex() {
    var c = cnv(256, 256), x = c.getContext('2d');
    x.fillStyle = 'rgb(128,128,128)'; x.fillRect(0, 0, 256, 256);
    for (var i = 0; i < 60; i++) {
      var r = 20 + Math.random() * 50, px = Math.random() * 256, py = Math.random() * 256;
      var v = 90 + Math.floor(Math.random() * 76);
      var g = x.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, 'rgba(' + v + ',' + v + ',' + v + ',0.5)');
      g.addColorStop(1, 'rgba(' + v + ',' + v + ',' + v + ',0)');
      x.fillStyle = g;
      x.fillRect(px - r, py - r, r * 2, r * 2);
    }
    var t = tex(c);
    t.baseTexture.wrapMode = PIXI.WRAP_MODES.REPEAT;
    return t;
  }
  function rayTex() {
    var c = cnv(180, 700), x = c.getContext('2d');
    var g = x.createLinearGradient(0, 0, 0, 700);
    g.addColorStop(0, 'rgba(255,255,235,0.55)');
    g.addColorStop(1, 'rgba(255,255,235,0)');
    x.fillStyle = g;
    x.beginPath();
    x.moveTo(70, 0); x.lineTo(110, 0); x.lineTo(180, 700); x.lineTo(0, 700);
    x.closePath(); x.fill();
    return tex(c);
  }
  function rocksTex(w) {
    var c = cnv(w, 240), x = c.getContext('2d');
    function mounds(step, hi, col) {
      x.fillStyle = col;
      x.beginPath(); x.moveTo(0, 241);
      var px = 0, py = 240 - 40 - Math.random() * hi;
      x.lineTo(0, py);
      while (px < w + step) {
        var st = step * (0.55 + Math.random() * 0.9);
        var ny = 240 - 30 - Math.random() * hi;
        x.quadraticCurveTo(px + st * 0.5, Math.min(py, ny) - 20 - Math.random() * 60, px + st, ny);
        py = ny; px += st;
      }
      x.lineTo(w, 241); x.closePath(); x.fill();
    }
    mounds(120, 140, '#2a6bb0');           // far ridge
    mounds(90, 80, '#16457f');             // near ridge, darker
    // moonlit tops
    x.globalCompositeOperation = 'source-atop';
    var g = x.createLinearGradient(0, 0, 0, 240);
    g.addColorStop(0, 'rgba(140,210,255,0.35)');
    g.addColorStop(0.5, 'rgba(140,210,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, w, 240);
    x.globalCompositeOperation = 'source-over';
    return tex(c);
  }
  function sandTex(w) {
    var c = cnv(w, 70), x = c.getContext('2d');
    var g = x.createLinearGradient(0, 0, 0, 70);
    g.addColorStop(0, '#f0d9a6'); g.addColorStop(1, '#cfae72');
    x.fillStyle = g;
    x.beginPath(); x.moveTo(0, 16);
    for (var px = 0; px <= w + 20; px += 24) x.quadraticCurveTo(px + 12, 16 + Math.sin(px * 0.05) * 7 - 7, px + 24, 16);
    x.lineTo(w, 70); x.lineTo(0, 70); x.closePath(); x.fill();
    x.fillStyle = 'rgba(150,110,55,0.4)';
    for (var i = 0; i < w / 9; i++) { x.beginPath(); x.arc(Math.random() * w, 30 + Math.random() * 36, 1.6 + Math.random() * 2, 0, 7); x.fill(); }
    return tex(c);
  }
  function coralTex() {
    var c = cnv(200, 150), x = c.getContext('2d');
    function branch(bx, col, n) {
      x.strokeStyle = col; x.lineCap = 'round';
      for (var i = 0; i < n; i++) {
        var a = -Math.PI / 2 + (i / (n - 1) - 0.5) * 1.7;
        x.lineWidth = 10 - i % 3 * 2;
        x.beginPath(); x.moveTo(bx, 150);
        x.quadraticCurveTo(bx + Math.cos(a) * 30, 110, bx + Math.cos(a) * 52, 150 - 60 - Math.random() * 26);
        x.stroke();
      }
    }
    branch(50, '#ff7ab8', 5);
    branch(120, '#ff9f5e', 4);
    x.fillStyle = '#c976ff';
    for (var i = 0; i < 3; i++) {
      x.beginPath();
      x.ellipse(165 + i * 11, 132 - i * 5, 8, 16 - i * 3, 0, 0, 7);
      x.fill();
    }
    return tex(c);
  }
  function weedTex() {
    var c = cnv(46, 190), x = c.getContext('2d');
    var g = x.createLinearGradient(0, 0, 0, 190);
    g.addColorStop(0, '#4fd68b'); g.addColorStop(1, '#187a4a');
    x.fillStyle = g;
    x.beginPath();
    x.moveTo(23, 190);
    x.bezierCurveTo(2, 130, 40, 90, 16, 10);
    x.quadraticCurveTo(23, 0, 30, 12);
    x.bezierCurveTo(46, 95, 8, 128, 27, 190);
    x.closePath(); x.fill();
    return tex(c);
  }
  function flakeTex() {
    var c = cnv(18, 14), x = c.getContext('2d');
    x.fillStyle = '#ffe9a8';
    x.strokeStyle = 'rgba(120,80,10,0.6)'; x.lineWidth = 1.5;
    x.beginPath();
    x.moveTo(3, 7); x.lineTo(8, 2); x.lineTo(15, 5); x.lineTo(13, 11); x.lineTo(5, 12);
    x.closePath(); x.fill(); x.stroke();
    return tex(c);
  }

  /* ---------- upgraded fish sprites (baked body + animated tail) ---------- */
  function shade(hex, amt) {
    var n = parseInt(hex.slice(1), 16);
    var r = Math.max(0, Math.min(255, (n >> 16) + amt));
    var g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt));
    var b = Math.max(0, Math.min(255, (n & 255) + amt));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }
  function bakeFish(f) {
    var sp = PFFish.SPECIES[f.sp];
    var S = 3;                                   // bake resolution
    var L = sp.base * S;                         // adult body length
    var H = L * (sp.tall ? 0.85 : sp.spikes ? 0.78 : 0.52);
    // --- body ---
    var bw = Math.ceil(L * 1.5), bh = Math.ceil(Math.max(H * 2.6, L * 1.1));
    var c = cnv(bw, bh), x = c.getContext('2d');
    x.translate(bw * 0.46, bh / 2);
    x.lineJoin = 'round';
    // dorsal + ventral fins (translucent membranes)
    x.fillStyle = f.c2; x.globalAlpha = 0.75;
    x.beginPath();
    if (sp.tall) {
      x.moveTo(-L * 0.1, -H * 0.42); x.quadraticCurveTo(L * 0.06, -H * 1.25, L * 0.24, -H * 0.38);
      x.moveTo(-L * 0.1, H * 0.42); x.quadraticCurveTo(L * 0.06, H * 1.25, L * 0.24, H * 0.38);
    } else {
      x.moveTo(-L * 0.18, -H * 0.44); x.quadraticCurveTo(L * 0.02, -H * 1.05, L * 0.2, -H * 0.42);
      x.moveTo(-L * 0.05, H * 0.46); x.quadraticCurveTo(L * 0.06, H * 0.8, L * 0.17, H * 0.44);
    }
    x.fill();
    x.globalAlpha = 0.35; x.strokeStyle = '#ffffff'; x.lineWidth = S;
    x.stroke();
    x.globalAlpha = 1;
    // body with rich gradient + white outline
    var g = x.createLinearGradient(0, -H * 0.55, 0, H * 0.55);
    g.addColorStop(0, shade(f.c1, 55));
    g.addColorStop(0.45, f.c1);
    g.addColorStop(1, shade(f.c1, -55));
    x.fillStyle = g;
    x.strokeStyle = 'rgba(255,255,255,0.9)';
    x.lineWidth = S * 1.1;
    x.beginPath(); x.ellipse(0, 0, L * 0.5, H * 0.5, 0, 0, 7); x.fill(); x.stroke();
    // pattern
    x.save();
    x.beginPath(); x.ellipse(0, 0, L * 0.5 - S, H * 0.5 - S, 0, 0, 7); x.clip();
    if (sp.bands) {
      x.fillStyle = '#ffffff';
      x.fillRect(-L * 0.09, -H, L * 0.15, H * 2);
      x.fillRect(L * 0.22, -H, L * 0.12, H * 2);
      x.fillStyle = 'rgba(30,20,40,0.55)';
      x.fillRect(-L * 0.12, -H, S * 1.2, H * 2);
      x.fillRect(L * 0.06 - S, -H, S * 1.2, H * 2);
    } else if (f.pat === 1) {
      x.fillStyle = f.c2; x.globalAlpha = 0.7;
      for (var s2 = -1; s2 <= 1; s2++) {
        x.beginPath();
        x.ellipse(s2 * L * 0.18, 0, L * 0.045, H * 0.55, 0.12, 0, 7);
        x.fill();
      }
      x.globalAlpha = 1;
    } else if (f.pat === 2) {
      x.fillStyle = f.c2; x.globalAlpha = 0.8;
      [[-0.16, -0.1, 0.07], [0.1, 0.13, 0.055], [0.02, -0.2, 0.05], [-0.29, 0.09, 0.05], [0.24, -0.06, 0.045]]
        .forEach(function (d) { x.beginPath(); x.arc(L * d[0], H * d[1] * 2, L * d[2], 0, 7); x.fill(); });
      x.globalAlpha = 1;
    }
    // belly light + top sheen
    x.fillStyle = 'rgba(255,255,255,0.3)';
    x.beginPath(); x.ellipse(-L * 0.04, H * 0.2, L * 0.36, H * 0.18, 0, 0, 7); x.fill();
    x.fillStyle = 'rgba(255,255,255,0.35)';
    x.beginPath(); x.ellipse(L * 0.08, -H * 0.3, L * 0.26, H * 0.1, -0.15, 0, 7); x.fill();
    x.restore();
    // spikes / whiskers
    if (sp.spikes) {
      x.strokeStyle = shade(f.c1, -60); x.lineWidth = S * 1.6; x.lineCap = 'round';
      for (var a2 = 0; a2 < 11; a2++) {
        var an = a2 / 11 * Math.PI * 2 + 0.25;
        x.beginPath();
        x.moveTo(Math.cos(an) * L * 0.45, Math.sin(an) * H * 0.45);
        x.lineTo(Math.cos(an) * L * 0.58, Math.sin(an) * H * 0.6);
        x.stroke();
      }
    }
    if (sp.whiskers) {
      x.strokeStyle = shade(f.c1, -45); x.lineWidth = S; x.lineCap = 'round';
      x.beginPath();
      x.moveTo(L * 0.42, H * 0.1); x.quadraticCurveTo(L * 0.66, H * 0.02, L * 0.72, H * 0.3);
      x.moveTo(L * 0.42, H * 0.2); x.quadraticCurveTo(L * 0.6, H * 0.32, L * 0.62, H * 0.5);
      x.stroke();
    }
    // gill + glossy eye + smile
    x.strokeStyle = 'rgba(0,0,0,0.15)'; x.lineWidth = S;
    x.beginPath(); x.arc(L * 0.16, 0, H * 0.3, -1.1, 1.1); x.stroke();
    x.fillStyle = '#ffffff';
    x.beginPath(); x.arc(L * 0.3, -H * 0.12, Math.max(4, L * 0.1), 0, 7); x.fill();
    x.strokeStyle = 'rgba(0,0,0,0.25)'; x.lineWidth = S * 0.7; x.stroke();
    x.fillStyle = '#241a3a';
    x.beginPath(); x.arc(L * 0.33, -H * 0.11, Math.max(2.2, L * 0.05), 0, 7); x.fill();
    x.fillStyle = '#ffffff';
    x.beginPath(); x.arc(L * 0.345, -H * 0.15, Math.max(1.1, L * 0.02), 0, 7); x.fill();
    x.strokeStyle = shade(f.c1, -60); x.lineWidth = S; x.lineCap = 'round';
    x.beginPath(); x.arc(L * 0.44, H * 0.07, L * 0.05, 0.4, 2.1); x.stroke();

    // --- tail (pivot at its right edge) ---
    var tw2 = Math.ceil(L * 1.05), th2 = Math.ceil(Math.max(H * 2.1, L * 0.9));
    var ct = cnv(tw2, th2), xt = ct.getContext('2d');
    xt.translate(tw2 - S, th2 / 2);
    var gt = xt.createLinearGradient(-L, 0, 0, 0);
    gt.addColorStop(0, shade(f.c2, -30));
    gt.addColorStop(1, f.c2);
    xt.fillStyle = gt;
    xt.strokeStyle = 'rgba(255,255,255,0.85)';
    xt.lineWidth = S; xt.lineJoin = 'round';
    xt.beginPath();
    if (sp.tail === 'flow') {
      xt.moveTo(0, 0);
      xt.bezierCurveTo(-L * 0.6, -H * 1.0, -L * 1.0, -H * 0.25, -L * 0.72, 0);
      xt.bezierCurveTo(-L * 1.0, H * 0.55, -L * 0.55, H * 0.95, 0, 0);
    } else if (sp.tail === 'fork') {
      xt.moveTo(0, 0); xt.lineTo(-L * 0.46, -H * 0.68); xt.lineTo(-L * 0.26, 0);
      xt.lineTo(-L * 0.46, H * 0.68); xt.closePath();
    } else if (sp.tail === 'bigfan') {
      xt.moveTo(0, 0);
      xt.arc(0, 0, L * 0.56, Math.PI - 0.95, Math.PI + 0.95);
      xt.closePath();
    } else if (sp.tail === 'small') {
      xt.moveTo(0, 0); xt.lineTo(-L * 0.3, -H * 0.38); xt.lineTo(-L * 0.3, H * 0.38); xt.closePath();
    } else {
      xt.moveTo(0, 0); xt.lineTo(-L * 0.44, -H * 0.6); xt.lineTo(-L * 0.32, 0);
      xt.lineTo(-L * 0.44, H * 0.6); xt.closePath();
    }
    xt.fill(); xt.stroke();
    xt.globalAlpha = 0.4;
    xt.strokeStyle = '#ffffff'; xt.lineWidth = S * 0.6;
    for (var m = -1; m <= 1; m++) {
      xt.beginPath(); xt.moveTo(-S, m * H * 0.1);
      xt.lineTo(-L * 0.4, m * H * 0.5); xt.stroke();
    }
    xt.globalAlpha = 1;

    return {
      body: tex(c), bodyAX: 0.46, bodyAY: 0.5,
      tail: tex(ct), tailAX: (tw2 - S) / tw2, tailAY: 0.5,
      L: L,                                    // body length in texture px
    };
  }

  /* ---------- scene ---------- */
  function build() {
    var Wp = root.innerWidth, Hp = root.innerHeight;
    world = new PIXI.Container();
    app.stage.addChild(world);

    var bg = new PIXI.Sprite(gradTex([[0, '#46b7f0'], [0.45, '#1d6cb8'], [1, '#082a55']]));
    bg.width = Wp; bg.height = Hp; bg.name = 'bg';
    world.addChild(bg);

    // god rays (additive)
    raysBox = new PIXI.Container();
    for (var i = 0; i < 4; i++) {
      var r = new PIXI.Sprite(rayTex());
      r.anchor.set(0.5, 0);
      r.x = Wp * (0.12 + i * 0.26);
      r.y = -30;
      r.height = Hp * 1.05;
      r.width = 120 + i * 40;
      r.alpha = 0.16;
      r.blendMode = PIXI.BLEND_MODES.ADD;
      r.base = r.x; r.ph = i * 1.7;
      raysBox.addChild(r);
    }
    world.addChild(raysBox);

    var rocks = new PIXI.Sprite(rocksTex(Wp));
    rocks.anchor.set(0, 1); rocks.y = Hp - 20; rocks.alpha = 0.75;
    world.addChild(rocks);

    // caustics live in a masked box so they fade out with depth
    var ctex = causticsTex();
    var cbox = new PIXI.Container();
    caustics = new PIXI.TilingSprite(ctex, Wp, Hp);
    caustics.alpha = 0.14;
    caustics.blendMode = PIXI.BLEND_MODES.ADD;
    cbox.addChild(caustics);
    caustics2 = new PIXI.TilingSprite(ctex, Wp, Hp);
    caustics2.alpha = 0.08;
    caustics2.blendMode = PIXI.BLEND_MODES.ADD;
    caustics2.tileScale.set(1.9);
    cbox.addChild(caustics2);
    var cmask = new PIXI.Sprite(gradTex([
      [0, 'rgba(255,255,255,1)'], [0.45, 'rgba(255,255,255,0.55)'], [1, 'rgba(255,255,255,0.12)'],
    ]));
    cmask.width = Wp; cmask.height = Hp;
    cbox.addChild(cmask);
    cbox.mask = cmask;
    world.addChild(cbox);

    // bright water-surface glow just under the top edge
    var surf = new PIXI.Sprite((function () {
      var c = cnv(8, 160), x = c.getContext('2d');
      var g = x.createLinearGradient(0, 0, 0, 160);
      g.addColorStop(0, 'rgba(210,245,255,0.55)');
      g.addColorStop(0.35, 'rgba(180,235,255,0.18)');
      g.addColorStop(1, 'rgba(180,235,255,0)');
      x.fillStyle = g; x.fillRect(0, 0, 8, 160);
      return tex(c);
    })());
    surf.width = Wp; surf.height = 130;
    surf.blendMode = PIXI.BLEND_MODES.ADD;
    world.addChild(surf);

    // drifting motes
    var moteT = glowTex(6);
    for (var m = 0; m < 60; m++) {
      var s = new PIXI.Sprite(moteT);
      s.anchor.set(0.5);
      s.x = Math.random() * Wp; s.y = Math.random() * Hp;
      s.alpha = 0.05 + Math.random() * 0.15;
      s.scale.set(0.3 + Math.random() * 0.7);
      s.vx = 2 + Math.random() * 6; s.vy = 3 + Math.random() * 5; s.ph = Math.random() * 7;
      motes.push(s); world.addChild(s);
    }

    var sand = new PIXI.Sprite(sandTex(Wp));
    sand.anchor.set(0, 1); sand.y = Hp;
    world.addChild(sand);

    for (var w2 = 0; w2 < 6; w2++) {
      var weed = new PIXI.Sprite(weedTex());
      weed.anchor.set(0.5, 1);
      weed.x = Wp * (0.06 + w2 * 0.18) + (w2 % 2) * 14;
      weed.y = Hp - 26 - (w2 % 3) * 6;
      weed.scale.set(0.6 + (w2 % 3) * 0.28);
      weed.ph = w2 * 1.3;
      weeds.push(weed); world.addChild(weed);
    }
    var coral1 = new PIXI.Sprite(coralTex());
    coral1.anchor.set(0.5, 1); coral1.x = Wp * 0.24; coral1.y = Hp - 24; coral1.scale.set(0.8);
    world.addChild(coral1);
    var coral2 = new PIXI.Sprite(coralTex());
    coral2.anchor.set(0.5, 1); coral2.x = Wp * 0.82; coral2.y = Hp - 22; coral2.scale.set(0.65);
    coral2.scale.x *= -0.65 / 0.65; coral2.scale.x = -0.65;
    world.addChild(coral2);

    world.fishLayer = new PIXI.Container();
    world.addChild(world.fishLayer);
    world.flakeLayer = new PIXI.Container();
    world.addChild(world.flakeLayer);

    // bubbles
    var bt = bubbleTex();
    for (var b = 0; b < 26; b++) {
      var bs = new PIXI.Sprite(bt);
      bs.anchor.set(0.5);
      bs.x = Math.random() * Wp; bs.y = Math.random() * (Hp + 160) - 80;
      bs.scale.set(0.18 + Math.random() * 0.4);
      bs.alpha = 0.5;
      bs.v = 26 + Math.random() * 40; bs.ph = Math.random() * 7;
      bubbles.push(bs); world.addChild(bs);
    }

    // refraction
    noiseSpr = new PIXI.TilingSprite(noiseTex(), Wp, Hp);
    app.stage.addChild(noiseSpr);
    var disp = new PIXI.DisplacementFilter(noiseSpr);
    disp.scale.set(10, 14);
    world.filters = [disp];
    noiseSpr.renderable = false;

    vignette = new PIXI.Sprite((function () {
      var c = cnv(512, 512), x = c.getContext('2d');
      var g = x.createRadialGradient(256, 236, 150, 256, 256, 330);
      g.addColorStop(0, 'rgba(2,12,40,0)');
      g.addColorStop(1, 'rgba(2,12,40,0.42)');
      x.fillStyle = g; x.fillRect(0, 0, 512, 512);
      return tex(c);
    })());
    vignette.width = Wp; vignette.height = Hp;
    app.stage.addChild(vignette);
    built = true;
  }

  function ensure() {
    if (app || !supported()) return !!app;
    try {
      app = new PIXI.Application({
        width: root.innerWidth, height: root.innerHeight,
        resolution: Math.min(root.devicePixelRatio || 1, 2),
        autoDensity: true, antialias: true, backgroundColor: 0x0b3f7a,
      });
      app.ticker.stop();                       // rendered manually from the game loop
      view = app.view;
      view.id = 'aqgl';
      // GPU context loss (common on Android after backgrounding): tear down and
      // let the game's canvas-scene fallback take over permanently this session
      view.addEventListener('webglcontextlost', function (e) {
        e.preventDefault();
        var v = view;
        try { app.destroy(true, { children: true, texture: true, baseTexture: true }); } catch (err) {}
        app = null; view = null; okGL = false; shown = false; built = false;
        fishNodes = {}; flakePool = [];
        motes.length = 0; bubbles.length = 0; weeds.length = 0;
        try { if (v && v.parentNode) v.parentNode.removeChild(v); } catch (err) {}
      }, false);
      // set properties individually — writing cssText would wipe the style
      // width/height that autoDensity manages (breaks on dpr>1 screens)
      view.style.position = 'fixed';
      view.style.left = '0';
      view.style.top = '0';
      view.style.zIndex = '1';
      view.style.display = 'none';
      document.body.insertBefore(view, document.body.firstChild);
      build();
      root.addEventListener('resize', function () {
        if (!app) return;
        app.renderer.resize(root.innerWidth, root.innerHeight);
      });
      return true;
    } catch (e) { okGL = false; app = null; return false; }
  }

  function syncFish() {
    var list = refs.fish();
    var seen = {};
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      seen[f.id] = true;
      if (!fishNodes[f.id]) {
        var baked = bakeFish(f);
        var node = new PIXI.Container();
        var tail = new PIXI.Sprite(baked.tail);
        tail.anchor.set(baked.tailAX, baked.tailAY);
        tail.x = -baked.L * 0.44;
        var body = new PIXI.Sprite(baked.body);
        body.anchor.set(baked.bodyAX, baked.bodyAY);
        var sh = new PIXI.Sprite(glowTex(40, 'rgba(3,20,50,0.55)'));
        sh.anchor.set(0.5); sh.y = 6; sh.scale.set(1.1, 0.5);
        node.addChild(sh); node.addChild(tail); node.addChild(body);
        node.tailSpr = tail; node.baseL = baked.L; node.f = f;
        fishNodes[f.id] = node;
        world.fishLayer.addChild(node);
      }
    }
    for (var id in fishNodes) {
      if (!seen[id]) { world.fishLayer.removeChild(fishNodes[id]); fishNodes[id].destroy({ children: true }); delete fishNodes[id]; }
    }
  }

  var AquaGL = {
    _d: function () { return { app: app, world: world, fishNodes: fishNodes }; },
    init: function (r) { refs = r; },
    on: function () { return shown && !!app; },
    supported: supported,
    show: function () {
      if (!ensure()) { shown = false; return false; }
      shown = true;
      view.style.display = 'block';
      syncFish();
      return true;
    },
    hide: function () {
      shown = false;
      if (view) view.style.display = 'none';
    },
    render: function (dt, t) {
      if (!shown || !app) return;
      T = t;
      var Wp = root.innerWidth, Hp = root.innerHeight;
      syncFish();
      caustics.tilePosition.x = t * 9;
      caustics.tilePosition.y = t * 5;
      caustics2.tilePosition.x = -t * 6;
      caustics2.tilePosition.y = t * 3.5;
      noiseSpr.tilePosition.x = t * 22;
      noiseSpr.tilePosition.y = t * 14;
      raysBox.children.forEach(function (r) {
        r.x = r.base + Math.sin(t * 0.22 + r.ph) * 26;
        r.rotation = Math.sin(t * 0.16 + r.ph) * 0.05;
        r.alpha = 0.11 + 0.07 * (1 + Math.sin(t * 0.5 + r.ph)) / 2;
      });
      weeds.forEach(function (wd) { wd.rotation = Math.sin(t * 1.1 + wd.ph) * 0.09; });
      motes.forEach(function (m2) {
        m2.x += Math.sin(t * 0.4 + m2.ph) * m2.vx * dt;
        m2.y -= m2.vy * dt;
        if (m2.y < -8) { m2.y = Hp + 8; m2.x = Math.random() * Wp; }
      });
      bubbles.forEach(function (b) {
        b.y -= b.v * dt;
        b.x += Math.sin(t * 2 + b.ph) * 12 * dt;
        if (b.y < -14) { b.y = Hp + 14; b.x = Math.random() * Wp; }
      });
      // flakes
      var fl = refs.flakes();
      while (flakePool.length < fl.length) {
        var fs = new PIXI.Sprite(flakeTex());
        fs.anchor.set(0.5);
        flakePool.push(fs);
        world.flakeLayer.addChild(fs);
      }
      for (var i = 0; i < flakePool.length; i++) {
        var vis = i < fl.length;
        flakePool[i].visible = vis;
        if (vis) {
          flakePool[i].x = fl[i].x; flakePool[i].y = fl[i].y;
          flakePool[i].rotation = fl[i].t * 2;
        }
      }
      // fish
      var swim = refs.swim();
      for (var id in fishNodes) {
        var node = fishNodes[id], s = swim[id];
        if (!s) continue;
        // 1.8× the logical size: the GL tank reads better with larger fish
        var k = refs.sizePx(node.f) * 1.8 / node.baseL;
        node.x = s.x; node.y = s.y;
        node.scale.set((s.dir < 0 ? -1 : 1) * k, k);
        node.rotation = Math.sin(t * 5 + node.f.ph) * 0.06;
        node.tailSpr.rotation = Math.sin(t * 9 + node.f.ph) * 0.45;
      }
      app.renderer.render(app.stage);
    },
  };
  root.AquaGL = AquaGL;
})(typeof self !== 'undefined' ? self : this);
