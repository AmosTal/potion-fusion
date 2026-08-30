/* Potion Fusion analytics SDK (Supabase transport).
 * Offline-first and fire-and-forget: events queue in localStorage, flush in
 * batches to the validated `ingest_events` RPC, retry with backoff, and
 * no-op entirely when no PF_CONFIG is present — the game never depends on
 * the network. Anonymous by design: a random install UUID, no PII. */
(function (root) {
  'use strict';

  var cfg = (typeof PF_CONFIG !== 'undefined' && PF_CONFIG) || null;
  var ENABLED = !!(cfg && cfg.supabaseUrl && cfg.supabaseAnonKey && cfg.analytics !== false);

  var QKEY = 'pfa_q', DKEY = 'pfa_device', CKEY = 'pf_consent';
  var MAX_QUEUE = 400, BATCH_AT = 20, MAX_BATCH = 50, FLUSH_MS = 25000;

  function sget(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }
  function sset(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  function uuid() {
    try {
      var b = new Uint8Array(16);
      (root.crypto || {}).getRandomValues ? root.crypto.getRandomValues(b) : b.forEach(function (_, i) { b[i] = Math.random() * 256; });
      b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
      var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
      return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
    } catch (e) {
      return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, function () { return (Math.random() * 16 | 0).toString(16); });
    }
  }

  var deviceId = sget(DKEY, null);
  if (!deviceId) { deviceId = uuid(); sset(DKEY, deviceId); }
  var sessionId = uuid();
  var seq = 0;
  var userId = null;
  var q = ENABLED ? sget(QKEY, []) : [];
  var inflight = false, fails = 0, backoffUntil = 0, errorsSent = 0;
  var platform = /Android/i.test(navigator.userAgent)
    ? (/\bwv\b|Version\/\d/.test(navigator.userAgent) ? 'android-webview' : 'android-browser')
    : 'web';

  // GDPR-style consent: when analytics is configured, nothing is queued or
  // sent until the player has explicitly opted in (the game shows the choice
  // once at first launch and keeps a toggle in the shop).
  function consent() { return sget(CKEY, null); }
  function setConsent(v) {
    sset(CKEY, v ? 1 : 0);
    if (!v) { q = []; sset(QKEY, q); }   // opting out also drops anything pending
  }

  function track(event, props) {
    if (!ENABLED || consent() !== 1) return;
    var p = props || {};
    q.push({
      device_id: deviceId,
      session_id: sessionId,
      seq: seq++,
      client_ts: new Date().toISOString(),
      app_version: String(cfg.appVersion || ''),
      platform: platform,
      event: String(event),
      level: typeof p.level === 'number' ? p.level : null,
      user_id: userId,
      props: p,
    });
    if (q.length > MAX_QUEUE) q.splice(0, q.length - MAX_QUEUE); // drop oldest
    sset(QKEY, q);
    if (q.length >= BATCH_AT) flush();
  }

  function flush(final_) {
    if (!ENABLED || inflight || !q.length) return;
    if (!final_ && Date.now() < backoffUntil) return;
    var batch = q.slice(0, MAX_BATCH);
    inflight = true;
    fetch(cfg.supabaseUrl.replace(/\/$/, '') + '/rest/v1/rpc/ingest_events', {
      method: 'POST',
      keepalive: !!final_,
      headers: {
        'Content-Type': 'application/json',
        apikey: cfg.supabaseAnonKey,
        Authorization: 'Bearer ' + cfg.supabaseAnonKey,
      },
      body: JSON.stringify({ payload: batch }),
    }).then(function (r) {
      inflight = false;
      if (r.ok) {
        q.splice(0, batch.length);
        sset(QKEY, q);
        fails = 0; backoffUntil = 0;
        if (q.length >= BATCH_AT) flush();
      } else {
        bumpBackoff();
      }
    }).catch(function () {
      inflight = false;
      bumpBackoff();
    });
  }

  function bumpBackoff() {
    fails++;
    backoffUntil = Date.now() + Math.min(120000, 5000 * Math.pow(2, Math.min(fails, 5)));
  }

  if (ENABLED) {
    setInterval(function () { flush(); }, FLUSH_MS);
    var finalFlush = function () { flush(true); };
    root.addEventListener('pagehide', finalFlush);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') finalFlush();
    });
    // crash telemetry, capped per session
    root.addEventListener('error', function (e) {
      if (errorsSent >= 5) return;
      errorsSent++;
      track('client_error', {
        msg: String(e.message || '').slice(0, 200),
        src: String(e.filename || '').split('/').pop().slice(0, 60),
        line: e.lineno || 0,
      });
    });
  }

  root.PFA = {
    enabled: ENABLED,
    deviceId: deviceId,
    consent: consent,
    setConsent: setConsent,
    track: track,
    flush: flush,
    setUser: function (id) { userId = id || null; },
    // test hooks
    _debug: function () { return { qlen: q.length, fails: fails, backoffUntil: backoffUntil, inflight: inflight }; },
    _forceFlush: function () { backoffUntil = 0; fails = 0; flush(); },
  };
})(typeof self !== 'undefined' ? self : this);
