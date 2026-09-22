/* One long operation at a time, with a watchdog. The dashboard's copy.
 *
 * Same shape and same reasoning as the plugin panel's guard from #25 — a second
 * click must not become a second set of outbound requests, and a request that
 * never answers must not leave a button disabled forever — but a separate file,
 * because that one ships inside the plugin zip and is loaded by WordPress on a
 * client's site. This one is served by the dashboard.
 *
 * DELIBERATELY WITHOUT A DOM. Everything here is a decision: may this start,
 * has it taken too long, what changed. Painting is the caller's job, through
 * onChange. That is what lets the whole thing be exercised by the test suite,
 * which has no browser and no dependency that would provide one.
 */
(function (global) {
  'use strict';

  function createGuard(options) {
    var opts = options || {};
    // Longer than the plugin's: this one can be fanning out across forty
    // websites, where that one talks to the site it is running on.
    var timeoutMs = opts.timeoutMs || 120000;
    var setTimer = opts.setTimeout || global.setTimeout;
    var clearTimer = opts.clearTimeout || global.clearTimeout;
    var onChange = typeof opts.onChange === 'function' ? opts.onChange : function () {};

    var running = null;
    var timer = null;

    function clearWatchdog() {
      if (timer !== null && timer !== undefined) { clearTimer(timer); timer = null; }
    }

    return {
      isRunning: function () { return running !== null; },
      current: function () { return running; },
      canStart: function () { return running === null; },

      /** Begins one, or refuses. Returns true only if it began. */
      begin: function (what) {
        if (running !== null) return false;
        running = what || 'work';
        timer = setTimer(function () {
          // The same ending as a failure, with its own reason. The screen has
          // to come back either way, and the work may well still be finishing
          // on the server — so the caller says that rather than "it failed".
          running = null;
          timer = null;
          onChange({ type: 'timeout', what: what });
        }, timeoutMs);
        onChange({ type: 'begin', what: running });
        return true;
      },

      /** The single way out. Idempotent, and safe to call from a finally. */
      end: function (how) {
        if (running === null) return false;
        clearWatchdog();
        var was = running;
        running = null;
        onChange({ type: how || 'end', what: was });
        return true;
      },

      timeoutMs: timeoutMs,
    };
  }

  var api = { createGuard: createGuard };
  global.WPU_GUARD = api;
  // Only when something required this as a module — in practice, the tests.
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
