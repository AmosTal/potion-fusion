/* Potion Fusion — live-ops remote config client (PFRC).
 *
 * Reads the versioned JSON published by the ops console (admin/) through the
 * public `get_remote_config` RPC (migration 0003). Offline-first: the last
 * config is cached in localStorage and applied synchronously at boot; a
 * background refresh follows when the network allows. With no PF_CONFIG the
 * module is inert and the game runs on its built-in defaults. */
(function (root) {
  'use strict';
  var KEY = 'pf_rc_cache';
  var cfg = {}, version = 0, cbs = [];

  function clampNum(v, lo, hi) {
    v = Number(v);
    return isFinite(v) && v >= lo && v <= hi ? v : null;
  }

  var PFRC = {
    get: function (k, d) {
      return Object.prototype.hasOwnProperty.call(cfg, k) ? cfg[k] : d;
    },
    // numeric override with sanity range; falls back to d when absent/invalid
    num: function (k, d, lo, hi) {
      var v = clampNum(this.get(k, null), lo, hi);
      return v === null ? d : v;
    },
    flag: function (k, d) {
      var v = this.get(k, null);
      return typeof v === 'boolean' ? v : d;
    },
    version: function () { return version; },
    onApply: function (fn) { cbs.push(fn); },
    _apply: function (data, fresh) {
      if (!data || !data.config || typeof data.config !== 'object') return;
      cfg = data.config;
      version = data.version | 0;
      for (var i = 0; i < cbs.length; i++) { try { cbs[i](fresh); } catch (e) {} }
    },
    init: function (conf) {
      try { this._apply(JSON.parse(localStorage.getItem(KEY) || 'null'), false); } catch (e) {}
      if (!conf || !conf.supabaseUrl || !conf.supabaseAnonKey) return;
      if (conf.supabaseUrl.indexOf('YOUR-') !== -1) return;
      var self = this, prev = version;
      try {
        fetch(conf.supabaseUrl.replace(/\/+$/, '') + '/rest/v1/rpc/get_remote_config', {
          method: 'POST',
          headers: {
            apikey: conf.supabaseAnonKey,
            Authorization: 'Bearer ' + conf.supabaseAnonKey,
            'Content-Type': 'application/json',
          },
          body: '{}',
        }).then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) {
            if (!data || typeof data !== 'object') return;
            try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {}
            self._apply(data, (data.version | 0) !== prev);
          })
          .catch(function () {});
      } catch (e) {}
    },
  };
  root.PFRC = PFRC;
})(typeof self !== 'undefined' ? self : this);
