/* Potion Fusion auth (Supabase Auth / GoTrue, no SDK dependency).
 *
 * OAuth flow, WebView-correct: Google (and Facebook) refuse to run OAuth
 * inside embedded WebViews, so on Android the buttons open the SYSTEM
 * browser via the JS bridge (Android.openUrl) and Supabase redirects back
 * into the app through the potionfusion://auth deep link; MainActivity
 * hands the redirect to PFAuth.handleRedirect(). In a plain http(s)
 * browser the same flow runs via location redirects. Implicit grant:
 * tokens arrive in the URL fragment, session persists in localStorage,
 * refresh_token keeps it alive. Signing in is always optional — guest
 * mode is first-class and the game never requires the network. */
(function (root) {
  'use strict';

  var cfg = (typeof PF_CONFIG !== 'undefined' && PF_CONFIG) || null;
  var AVAILABLE = !!(cfg && cfg.supabaseUrl && cfg.supabaseAnonKey && cfg.auth !== false);
  var BASE = AVAILABLE ? cfg.supabaseUrl.replace(/\/$/, '') + '/auth/v1' : '';
  var SKEY = 'pfauth_session', UKEY = 'pfauth_user', GKEY = 'pfauth_guest';

  function sget(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }
  function sset(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  var session = sget(SKEY, null);
  var user = sget(UKEY, null);
  var busy = false;

  function emit(kind) { if (A.onChange) try { A.onChange(kind); } catch (e) {} }

  function headers(tok) {
    return {
      'Content-Type': 'application/json',
      apikey: cfg.supabaseAnonKey,
      Authorization: 'Bearer ' + (tok || cfg.supabaseAnonKey),
    };
  }

  function saveSession(s, u) {
    session = s; user = u || user;
    sset(SKEY, session); sset(UKEY, user);
  }

  function redirectTarget() {
    if (root.Android && root.Android.openUrl) return 'potionfusion://auth';
    return location.origin + location.pathname; // http(s) page flow
  }

  function authorizeUrl(provider) {
    return BASE + '/authorize?provider=' + encodeURIComponent(provider) +
      '&redirect_to=' + encodeURIComponent(redirectTarget());
  }

  function fetchUser(tok) {
    return fetch(BASE + '/user', { headers: headers(tok) })
      .then(function (r) { if (!r.ok) throw new Error('user ' + r.status); return r.json(); })
      .then(function (u) {
        var md = u.user_metadata || {};
        return {
          id: u.id,
          name: md.full_name || md.name || (u.email ? u.email.split('@')[0] : 'Player'),
          provider: (u.app_metadata || {}).provider || 'oauth',
        };
      });
  }

  function refresh() {
    if (!AVAILABLE || !session || !session.refresh_token || busy) return Promise.resolve(false);
    busy = true;
    return fetch(BASE + '/token?grant_type=refresh_token', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    }).then(function (r) {
      busy = false;
      if (!r.ok) { if (r.status === 400 || r.status === 401) doSignOut(true); return false; }
      return r.json().then(function (j) {
        saveSession({
          access_token: j.access_token,
          refresh_token: j.refresh_token || session.refresh_token,
          expires_at: Date.now() + (j.expires_in || 3600) * 1000,
        });
        emit('refresh');
        return true;
      });
    }).catch(function () { busy = false; return false; });
  }

  function doSignOut(silent) {
    if (session && session.access_token) {
      try { fetch(BASE + '/logout', { method: 'POST', headers: headers(session.access_token), keepalive: true }); } catch (e) {}
    }
    session = null; user = null;
    sset(SKEY, null); sset(UKEY, null);
    sset(GKEY, true); // signed out => act as guest, don't re-gate
    if (!silent) emit('signout');
  }

  var A = {
    onChange: null,
    available: function () { return AVAILABLE; },
    user: function () { return user; },
    signedIn: function () { return !!(session && user); },
    shouldShowGate: function () {
      return AVAILABLE && !A.signedIn() && !sget(GKEY, false);
    },
    chooseGuest: function () { sset(GKEY, true); emit('guest'); },

    signIn: function (provider) {
      if (!AVAILABLE) return false;
      var url = authorizeUrl(provider);
      if (root.Android && root.Android.openUrl) {
        root.Android.openUrl(url);       // system browser, back via deep link
      } else if (/^https?:$/.test(location.protocol)) {
        location.href = url;             // page flow
      } else {
        return false;                    // file:// without the app bridge
      }
      return true;
    },

    // Accepts the full redirect URL (deep link or page URL with fragment).
    handleRedirect: function (uri) {
      if (!AVAILABLE || !uri || uri.indexOf('#') < 0) return Promise.resolve(false);
      var frag = uri.slice(uri.indexOf('#') + 1);
      var q = {};
      frag.split('&').forEach(function (kv) {
        var i = kv.indexOf('=');
        if (i > 0) q[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '));
      });
      if (q.error_description || q.error) {
        emit('error:' + (q.error_description || q.error));
        return Promise.resolve(false);
      }
      if (!q.access_token) return Promise.resolve(false);
      saveSession({
        access_token: q.access_token,
        refresh_token: q.refresh_token || null,
        expires_at: Date.now() + (parseInt(q.expires_in, 10) || 3600) * 1000,
      });
      return fetchUser(q.access_token).then(function (u) {
        saveSession(session, u);
        sset(GKEY, true);
        emit('signin');
        return true;
      }).catch(function () {
        emit('error:profile');
        return false;
      });
    },

    signOut: function () { doSignOut(false); },

    init: function () {
      if (!AVAILABLE) return;
      // page-flow return: tokens in our own URL fragment
      if (/access_token=/.test(location.hash)) {
        var href = location.href;
        try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
        A.handleRedirect(href);
      } else if (session && session.expires_at && Date.now() > session.expires_at - 120000) {
        refresh();
      }
    },
  };

  root.PFAuth = A;
})(typeof self !== 'undefined' ? self : this);
