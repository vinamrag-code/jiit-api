/**
 * Google sign-in handoff, for apps that are not the portal itself.
 *
 * Students can no longer sign in with a password (the portal switched them to Google in Sep 2026), and a
 * "Sign in with Google" button rendered on any other origin CANNOT work: the portal's OAuth client
 * authorizes only `webportal.jiit.ac.in`'s own origin, so Google answers `origin_mismatch` everywhere else -
 * in a browser, in a WebView, and from a native app (Android's Credential Manager applies the same rule
 * from the other side, needing the calling app registered under *JIIT's* Cloud project; confirmed dead on a
 * real device). Google also blocks its sign-in flow inside embedded WebViews entirely, which rules out
 * proxying or iframing the real page.
 *
 * What does work, with no cooperation from JIIT and no policy broken: the student signs in once on the
 * portal's own page, and a bookmarklet - running *as that page's own script*, so nothing is cross-origin -
 * captures the sign-in response and hands it to the app via a redirect.
 *
 * It reads the response off the wire rather than out of the page's `localStorage` afterward because the
 * portal's frontend does not persist every field a session needs (`memberid`, notably); only the live
 * response has all of them.
 */

export const PORTAL_ORIGIN = "https://webportal.jiit.ac.in:6011";
export const PORTAL_LOGIN_URL = `${PORTAL_ORIGIN}/studentportal/`;

/**
 * The capture script, as readable JS. `targetOrigin` is where the session is handed to - the script
 * redirects to `<targetOrigin><route>?<the response's fields as query params>`.
 *
 * It patches **both `XMLHttpRequest` and `fetch`**: the portal's frontend is Angular, whose `HttpClient`
 * goes through `XMLHttpRequest` unless the app opts into `withFetch()`, so a fetch-only patch never fires.
 * URL matching ignores `-`, `_` and case, so it catches both spellings seen in the wild
 * (`/token/generatetokengooglesignin` and `/token/generate-token-google-signin`).
 */
export function bookmarkletScript(targetOrigin, route = "/#/import-session") {
  return `(function(){
    var TARGET = ${JSON.stringify(targetOrigin)}, ROUTE = ${JSON.stringify(route)};
    if (window.__jiitCapture) { alert('Sign-in helper already running. Just click "Sign in with Google".'); return; }
    window.__jiitCapture = true;

    function isLoginUrl(u){
      try { return String(u).toLowerCase().replace(/[-_]/g, '').indexOf('generatetokengooglesignin') !== -1; }
      catch (e) { return false; }
    }
    function handle(text){
      if (!text || window.__jiitDone) return;
      var data; try { data = JSON.parse(text); } catch (e) { return; }
      var r = (data && data.response && data.response.token) ? data.response : (data && data.token ? data : null);
      if (!r) { alert('Sign-in helper: caught the response but found no token in it:\\n\\n' + String(text).slice(0, 300)); return; }
      window.__jiitDone = true;
      var qs = new URLSearchParams();
      Object.keys(r).forEach(function(k){
        var v = r[k];
        if (v !== null && v !== undefined && typeof v !== 'object' && typeof v !== 'function') qs.append(k, v);
      });
      var url = TARGET + ROUTE + '?' + qs.toString();
      try { window.location.href = url; }
      catch (e) { prompt('Sign-in helper: open this link to finish signing in:', url); }
    }

    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url){
      if (isLoginUrl(url)) {
        this.addEventListener('load', function(){
          try { handle(this.responseType === '' || this.responseType === 'text' ? this.responseText : JSON.stringify(this.response)); }
          catch (e) {}
        });
      }
      return origOpen.apply(this, arguments);
    };

    var origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function(){
        var args = arguments;
        return origFetch.apply(this, args).then(function(res){
          var u = (args[0] && args[0].url) || args[0];
          if (isLoginUrl(u)) { res.clone().text().then(handle).catch(function(){}); }
          return res;
        });
      };
    }

    alert('Ready. Now click "Sign in with Google" on this page.');
  })();`;
}

/**
 * The same script as a `javascript:` URI, for a bookmark's URL field. Note that Firefox, and any page
 * served with a strict `script-src` CSP, refuse to run bookmarklets - offer `bookmarkletScript()` for
 * pasting into devtools as a fallback.
 */
export function buildBookmarklet(targetOrigin, route) {
  return "javascript:" + encodeURIComponent(bookmarkletScript(targetOrigin, route));
}

/**
 * Turns the redirect's query params back into the response object `WebPortalSession.fromGoogleResponse`
 * expects. Accepts a `URLSearchParams`, a plain object, or a full URL string.
 */
export function parseImportParams(params) {
  if (typeof params === "string") {
    const q = params.includes("?") ? params.slice(params.indexOf("?") + 1) : params;
    return Object.fromEntries(new URLSearchParams(q).entries());
  }
  if (params instanceof URLSearchParams) return Object.fromEntries(params.entries());
  return { ...params };
}
