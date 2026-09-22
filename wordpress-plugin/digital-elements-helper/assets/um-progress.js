/* The Team Members panel's operation guard, kept apart from the panel itself.
 *
 * WHY ITS OWN FILE. Everything here is a decision — may this start, has it
 * taken too long, what should it say — and none of it touches the document.
 * Separated so those decisions can be exercised directly by the test suite,
 * which has no DOM and deliberately no dependency that would give it one. The
 * panel does the DOM half and asks this the questions.
 *
 * WHAT IT IS FOR. Two failures, both seen in the wild:
 *
 *   1. A second click starts a second operation. The screen looked idle while
 *      a request was in flight, so people clicked again and fired a duplicate.
 *   2. A request that never answers leaves the screen disabled forever, with
 *      no way back but a reload.
 *
 * The first is answered by refusing to begin while one is running; the second
 * by a watchdog that always fires unless it was cleared, and a clear that runs
 * on EVERY ending — success, failure, refusal and the poll loop's own end.
 */
(function (global) {
  'use strict';

  // Long enough that a slow site isn't cut off mid-answer; short enough that
  // nobody sits looking at a frozen screen wondering. A job that outlives it
  // is not lost — the panel offers a retry and the job keeps running.
  var DEFAULT_TIMEOUT_MS = 45000;

  var LABELS = {
    roster:    'Loading team members',
    refresh:   'Refreshing team members',
    preflight: 'Checking what would happen',
    assign:    'Adding users',
    roles:     'Updating roles',
    sync:      'Synchronising with the web app',
    resend:    'Sending the invitation',
  };

  function createGuard(options) {
    var opts = options || {};
    var timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    var setTimer = opts.setTimeout || global.setTimeout;
    var clearTimer = opts.clearTimeout || global.clearTimeout;

    var running = null;   // { kind, startedAt, timer }
    var listeners = [];

    function emit(event) {
      for (var i = 0; i < listeners.length; i++) listeners[i](event);
    }

    function clearWatchdog() {
      if (running && running.timer !== null && running.timer !== undefined) {
        clearTimer(running.timer);
        running.timer = null;
      }
    }

    /** Ends the current operation whatever the ending was. Idempotent. */
    function settle(outcome, detail) {
      if (!running) return false;
      clearWatchdog();
      var kind = running.kind;
      running = null;
      emit({ type: outcome, kind: kind, detail: detail || null });
      return true;
    }

    return {
      /** Whether anything is in flight. */
      isRunning: function () { return running !== null; },
      current: function () { return running ? running.kind : null; },

      /**
       * Whether a new operation may start.
       *
       * One at a time, full stop. Two operations against the same roster can
       * disagree, and the second is nearly always an impatient second click
       * rather than a second intention.
       */
      canStart: function () { return running === null; },

      /**
       * Begins one, or refuses. Returns true if it began.
       *
       * The watchdog is armed here and is the ONLY thing that guarantees the
       * controls come back: every path out of an operation goes through
       * succeed/fail/cancel, and if somehow none of them runs, this fires.
       */
      begin: function (kind) {
        if (running) return false;
        running = { kind: kind, startedAt: Date.now(), timer: null };
        running.timer = setTimer(function () {
          // Deliberately the same ending as a failure, with its own reason:
          // the screen must come back either way, and "it took too long" is
          // what to tell someone rather than a generic error.
          settle('timeout', { kind: kind, timeoutMs: timeoutMs });
        }, timeoutMs);
        emit({ type: 'begin', kind: kind, detail: null });
        return true;
      },

      /**
       * "It is still alive" — re-arms the watchdog without ending anything.
       *
       * A job across a dozen websites can legitimately outlive one timeout,
       * and a poll that came back is proof it hasn't hung. Without this the
       * watchdog would cut off exactly the long jobs it exists to protect.
       * A poll that stops answering stops touching, and the watchdog fires.
       */
      touch: function () {
        if (!running) return false;
        clearWatchdog();
        var kind = running.kind;
        running.timer = setTimer(function () {
          settle('timeout', { kind: kind, timeoutMs: timeoutMs });
        }, timeoutMs);
        return true;
      },

      succeed: function (detail) { return settle('succeed', detail); },
      fail: function (detail) { return settle('fail', detail); },
      /** For an operation abandoned deliberately, e.g. leaving the screen. */
      cancel: function (detail) { return settle('cancel', detail); },

      on: function (fn) { listeners.push(fn); return this; },

      /** What to call the thing currently happening. */
      label: function (kind) { return LABELS[kind || (running && running.kind)] || 'Working'; },

      /**
       * "Processing 2 of 5", where the data supports it.
       *
       * Counted from operations that have actually finished, not from ones
       * started: a row still in flight has not been processed, and counting it
       * would show progress that hasn't happened.
       */
      progress: function (operations) {
        if (!operations || !operations.length) return null;
        var done = 0;
        for (var i = 0; i < operations.length; i++) {
          var s = operations[i] && operations[i].status;
          if (s && s !== 'pending' && s !== 'processing') done++;
        }
        return { done: done, total: operations.length,
                 text: 'Processing ' + Math.min(done + 1, operations.length) + ' of ' + operations.length,
                 finishedText: done + ' of ' + operations.length + ' done' };
      },

      timeoutMs: timeoutMs,
    };
  }

  var api = { createGuard: createGuard, LABELS: LABELS, DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS };

  global.DEHELED_TM_PROGRESS = api;
  // Present only when something required this as a module, which in practice
  // means the test suite. The browser never takes this branch.
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
