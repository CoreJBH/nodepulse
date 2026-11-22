/* Network: the native bridge the Android shell exposes, the one GET path that walks the
   three mempool mirrors and falls to the bridge, and the online/offline guard. */

  /* --------------------------------------------------------- native bridge */
  /* MainActivity exposes NPBridge.fetch(id, url) and calls back
     window.NPBridgeOnData(id, ok, text). It exists because bitnodes.io sends no
     Access-Control-Allow-Origin, and because the app should not depend on the
     WebView's own network stack for the primary dataset. */
  var hasOwn = Object.prototype.hasOwnProperty;
  var BR = {
    /* A null-prototype map: the id is a number the page chose, but a bridge callback is
       outside input, and on a plain {} an id such as "constructor" or "__proto__" would
       read back an inherited value instead of "no such request". */
    on: false, seq: 0, wait: Object.create(null),
    init: function () {
      if (!window.NPBridge || typeof window.NPBridge.fetch !== 'function') return false;
      /* The native side hands a body over in bounded chunks — one evaluateJavascript()
         call per chunk, each carrying (id, true, chunk, fin, seq) — so that neither its
         quoted copy nor the call string ever scales with the body size. Parts are
         buffered here and joined in sequence order when the final call arrives; a
         three-argument caller (an older harness, a direct test) skips all of that:
         an undefined fin means the whole body arrived in one piece. */
      window.NPBridgeOnData = function (id, ok, text, fin, seq) {
        var p = hasOwn.call(BR.wait, id) ? BR.wait[id] : null;
        if (!p) return;
        if (ok && fin === false) {
          if (num(seq) && seq > 0) {
            if (!p.parts) p.parts = {};
            p.parts[seq] = String(text || '');
          }
          return;
        }
        delete BR.wait[id];
        if (p.timer) clearTimeout(p.timer);
        if (!ok) { p.rej(new Error('bridge ' + id)); return; }
        var full = String(text || '');
        if (p.parts) {
          /* A hole in the sequence means a part was lost: joining around it would splice
             a body the page never saw, so the request fails and the next mirror or the
             bundled snapshot takes over. */
          if (!(num(seq) && seq > 0)) { p.rej(new Error('bridge ' + id)); return; }
          p.parts[seq] = String(text || '');
          var acc = '';
          for (var i = 1; i <= seq; i++) {
            if (!hasOwn.call(p.parts, i)) { p.rej(new Error('bridge ' + id)); return; }
            acc += p.parts[i];
          }
          full = acc;
        }
        p.res(full);
      };
      BR.on = true;
      return true;
    },
    get: function (url, ms) {
      var id = ++BR.seq;
      /* No caller can ask for less than the native side may take: a shorter page timer
         only discards an answer the bridge is still fetching (see BRIDGE_MS). */
      var wait = Math.max(num(ms) ? ms : 0, BRIDGE_MS);
      return new Promise(function (res, rej) {
        var timer = setTimeout(function () {
          if (hasOwn.call(BR.wait, id)) { delete BR.wait[id]; rej(new Error('bridge timeout')); }
        }, wait);
        BR.wait[id] = { res: res, rej: rej, timer: timer };
        try { window.NPBridge.fetch(String(id), String(url)); }
        catch (e) { delete BR.wait[id]; clearTimeout(timer); rej(e); }
      });
    }
  };

  /* ------------------------------------------------------------------- api */
  /* A Lightning public key is 33 compressed bytes in hex and is the only API input that
     lands in a URL path, so it is checked against that exact shape and escaped before it
     is concatenated. Anything else never reaches the network. */
  var PK_RE = /^[0-9a-f]{66}$/i;
  function validPk(v) { return typeof v === 'string' && PK_RE.test(v); }
  function pkPath(v) { return validPk(v) ? encodeURIComponent(v.toLowerCase()) : null; }

  /* 4xx (except 429, a limit another mirror may not share) is the request's fault, not the
     mirror's: it stops the rotation immediately instead of asking three hosts. 5xx and
     transport errors still move to the next mirror. */
  function httpError(r) {
    var e = new Error('HTTP ' + r.status);
    e.status = r.status;
    if (r.status >= 400 && r.status < 500 && r.status !== 429) e.fatal = true;
    return e;
  }

  /* A phone that has told the page it is offline does not need three 9 s fetch timeouts and
     a 42 s bridge wait to say so. navigator.onLine is only read where the platform provides
     it, and it is only ever consulted to give up early — a request is still attempted on
     every other path, so a wrong answer there costs a retry, not an answer. */
  function offline() {
    return typeof navigator !== 'undefined' && navigator ? navigator.onLine === false : false;
  }

  /* One path's whole walk is bounded by this: three mirrors at FETCH_MS each and then one
     bridge attempt. The old walk rotated all three mirrors through the bridge as well —
     three 42 s waits after three 9 s ones, 153 s before a dead network was reported and
     before the next poll could even start. */
  var REQ_BUDGET_MS = 3 * FETCH_MS + BRIDGE_MS;

  function request(path, kind) {
    var i = 0, bridged = false, deadline = Date.now() + REQ_BUDGET_MS;
    function go() {
      if (i >= API_HOSTS.length || offline()) return null;
      var left = deadline - Date.now();
      if (left <= 0) return null;
      var host = API_HOSTS[i++];
      var opt = { cache: 'no-store', credentials: 'omit', mode: 'cors' };
      var ctrl = null, timer = null;
      if (typeof AbortController !== 'undefined') {
        ctrl = new AbortController();
        opt.signal = ctrl.signal;
        timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { } }, Math.min(FETCH_MS, left));
      }
      /* The timer is cleared only once the BODY has settled, not when the headers
         arrive: clearing it early left a mirror that stalls mid-body hanging forever
         (the abort signal covers the body read too). */
      return fetch(host + path, opt).then(function (r) {
        if (!r.ok) { if (timer) clearTimeout(timer); throw httpError(r); }
        return (kind === 'text' ? r.text() : r.json()).then(function (body) {
          if (timer) clearTimeout(timer);
          return body;
        }, function (e) {
          if (timer) clearTimeout(timer);
          throw e;
        });
      }).catch(function (e) {
        if (timer) clearTimeout(timer);
        if (e && e.fatal) throw e;
        var next = go();
        if (next) return next;
        return viaBridge();
      });
    }
    /* A file:// page is an opaque origin: a host that sends no CORS header refuses the
       fetch even though it answers. The native bridge performs the same GET when it is
       there (the Android shell), so the mirrors get a second chance through it — one
       attempt, not another three: the same three hosts have just failed over fetch, a
       host that is down does not answer the bridge either, and the mempool mirrors all
       send Access-Control-Allow-Origin, so a rotation here only ever repeated a failure
       after 42 s. */
    function viaBridge() {
      if (!BR.on || bridged || offline()) {
        return Promise.reject(new Error(offline() ? 'offline' : 'no host answered ' + path));
      }
      bridged = true;
      return BR.get(API_HOSTS[0] + path).then(function (t) {
        return kind === 'text' ? t : JSON.parse(t);
      }).catch(function () { return Promise.reject(new Error('no host answered ' + path)); });
    }
    return go() || viaBridge();
  }

  /* one absolute GET, through the native bridge when it exists */
  function getJSON(url, ms, asText) {
    if (offline()) return Promise.reject(new Error('offline'));
    if (BR.on) {
      return BR.get(url, ms).then(function (t) { if (asText) return t; try { return JSON.parse(t); } catch (e) { throw new Error('bad json'); } });
    }
    var opt = { cache: 'no-store', credentials: 'omit', mode: 'cors' };
    var ctrl = null, timer = null;
    if (typeof AbortController !== 'undefined') {
      ctrl = new AbortController();
      opt.signal = ctrl.signal;
      timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { } }, ms || 15000);
    }
    /* Same rule as request(): the timeout spans the body read, not just the headers. */
    return fetch(url, opt).then(function (r) {
      if (!r.ok) { if (timer) clearTimeout(timer); throw httpError(r); }
      return (asText ? r.text() : r.json()).then(function (body) {
        if (timer) clearTimeout(timer);
        return body;
      }, function (e) {
        if (timer) clearTimeout(timer);
        throw e;
      });
    });
  }

  function ok() { S.lastOk = Date.now(); if (S.fail > 0) S.fail = 0; }

