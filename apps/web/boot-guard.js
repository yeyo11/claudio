// The boot guard: inlined into index.html's <head> by vite.config.ts, ahead of the app's module
// script, so it runs even when the bundle never does.
//
// Why it exists: the browser may stop a service worker at any moment, and Chrome then aborts the
// requests that worker was answering (`net::ERR_ABORTED`). When those are the entry module's
// preloaded chunks, the module map keeps the failure for the life of the document: the entry never
// runs, nothing is thrown where a console would show it, and the page stays an empty #root forever
// (docs/plans/e2e-blank-page.md). Only a new document can load the module graph again.
//
// So: module scripts run before DOMContentLoaded, and the app's first module calls
// `__claudioBooted()` as it evaluates. A DOMContentLoaded that finds it uncalled means the module
// graph failed. The page then reloads once; a second failure in a row shows a plain fallback with a
// Reload button instead, so a server that really lost its files never turns into a reload loop.
//
// A parenthesised function, not an IIFE: the build appends the call with the strings, and the tests
// run the same source against fakes.
(function bootGuard(win, strings) {
  var KEY = 'claudio:boot-retry';
  // A failure longer ago than this is not the same failure: it gets its own reload
  var WINDOW_MS = 60000;
  var booted = false;

  function clearRetry() {
    try {
      win.sessionStorage.removeItem(KEY);
    } catch (e) {
      // no storage: nothing was recorded either
    }
  }

  win.__claudioBooted = function () {
    booted = true;
    clearRetry();
  };

  /** Records this attempt; true when a reload is allowed, false when one already failed (or cannot be counted). */
  function mayReload() {
    try {
      var last = Number(win.sessionStorage.getItem(KEY));
      var now = Date.now();
      if (last && now - last < WINDOW_MS) return false;
      win.sessionStorage.setItem(KEY, String(now));
      return true;
    } catch (e) {
      // Without storage a reload could not know it was the second one: never risk the loop
      return false;
    }
  }

  function language() {
    try {
      var stored = win.localStorage.getItem('claudio-language');
      if (stored === 'en' || stored === 'es') return stored;
    } catch (e) {
      // blocked storage: follow the browser
    }
    var tags = (win.navigator && (win.navigator.languages || [win.navigator.language])) || [];
    for (var i = 0; i < tags.length; i++) {
      var code = String(tags[i] || '').toLowerCase().split(/[-_.@]/)[0];
      if (code === 'es' || code === 'en') return code;
    }
    return 'en';
  }

  /** The app's compact empty state, written by hand: React is exactly what did not load. */
  function showFallback() {
    var doc = win.document;
    var root = doc.getElementById('root');
    if (!root) return;
    // The splash (packages/ui/src/splash) waits for a hand-off that will never come: it must not
    // cover the way back, and what it kept out of reach is reachable again
    var splash = doc.getElementById('claudio-splash');
    if (splash && splash.remove) splash.remove();
    root.inert = false;
    var copy = strings[language()] || strings.en;
    var box = doc.createElement('div');
    box.className = 'state state-empty boot-failed';
    box.setAttribute('role', 'alert');
    var title = doc.createElement('strong');
    title.textContent = copy.title;
    var hint = doc.createElement('div');
    hint.className = 'muted';
    hint.textContent = copy.hint;
    var action = doc.createElement('div');
    action.className = 'state-action';
    var button = doc.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-primary';
    button.textContent = copy.action;
    button.addEventListener('click', function () {
      // A person asked: this reload is theirs, and it may again try once on its own
      clearRetry();
      win.location.reload();
    });
    action.appendChild(button);
    box.appendChild(title);
    box.appendChild(hint);
    box.appendChild(action);
    root.replaceChildren(box);
  }

  function check() {
    if (booted) return;
    if (mayReload()) win.location.reload();
    else showFallback();
  }

  win.document.addEventListener('DOMContentLoaded', function () {
    // After the listeners the app added itself: a module that evaluated calls in synchronously
    win.setTimeout(check, 0);
  });
})
