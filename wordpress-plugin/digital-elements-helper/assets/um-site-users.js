/* Team Members — adding Digital Elements colleagues to this website.
 *
 * Everything this script does is a request the server re-checks. The gate runs
 * in PHP on every handler, so nothing here is a control: disabling a button is
 * a courtesy to the person using the screen, not a restriction.
 *
 * Flow: roster -> select -> review (preflight) -> confirm -> assign -> poll ->
 * results. Nothing is created until the review has been seen and confirmed.
 */
(function () {
  var root = document.getElementById('deheled-tm-root');
  if (!root || typeof DEHELED_TM === 'undefined') return;

  var state = {
    teams: [],
    roles: {},
    others: [],
    siteRoles: [],
    selected: {},          // staffUserId -> true
    role: '',              // '' = each person's own default
    preflight: null,
    requestId: null,       // one per submission, reused on Retry
    jobId: null,
    poll: null,
    busy: false,
  };

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function post(action, data, done) {
    var body = new URLSearchParams();
    body.set('action', action);
    body.set('_wpnonce', DEHELED_TM.nonce);
    Object.keys(data || {}).forEach(function (k) {
      var v = data[k];
      if (Array.isArray(v)) v.forEach(function (one) { body.append(k + '[]', one); });
      else if (v !== undefined && v !== null) body.set(k, v);
    });

    fetch(DEHELED_TM.ajaxUrl, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
      .then(function (r) { return r.json().catch(function () { return null; }); })
      .then(function (json) {
        if (!json) return done({ message: DEHELED_TM.strings.genericError });
        if (!json.success) return done(json.data || { message: DEHELED_TM.strings.genericError });
        done(null, json.data);
      })
      .catch(function () { done({ message: DEHELED_TM.strings.genericError }); });
  }

  /* ------------------------------------------------------------ rendering */

  function selectedIds() { return Object.keys(state.selected).filter(function (id) { return state.selected[id]; }); }

  function memberRow(m) {
    // Already here: shown so the list is the whole team, but not selectable —
    // re-adding someone is not a thing this screen does.
    if (m.present) {
      return '<li class="deheled-tm-member is-present">'
        + '<span class="deheled-tm-name">' + esc(m.label) + '<small>' + esc(m.email) + '</small></span>'
        + '<span class="deheled-tm-badges">'
        + '<span class="deheled-tm-chip ok">Already here</span>'
        + (m.roles.length ? '<span class="deheled-tm-chip">' + esc(m.roles.join(', ')) + '</span>' : '')
        + (m.managed ? '' : '<span class="deheled-tm-chip warn">not managed by us</span>')
        + '</span></li>';
    }
    // Not here. If the dashboard thought otherwise, say so rather than quietly
    // showing a different list than it did last time: somebody removed this
    // account in WP Admin, and the person reading this is probably the one
    // wondering where it went.
    return '<li class="deheled-tm-member">'
      + '<label><input type="checkbox" data-id="' + esc(m.id) + '"' + (state.selected[m.id] ? ' checked' : '') + ' /> '
      + '<span class="deheled-tm-name">' + esc(m.label) + '<small>' + esc(m.email) + '</small></span></label>'
      + '<span class="deheled-tm-badges">'
      + (m.hubThought ? '<span class="deheled-tm-chip warn">removed on this website</span>' : '')
      + '<span class="deheled-tm-chip">' + esc(m.role) + '</span></span>'
      + '</li>';
  }

  function render() {
    var chosen = selectedIds().length;
    var roleOptions = Object.keys(state.roles).map(function (slug) {
      var r = state.roles[slug];
      return '<option value="' + esc(slug) + '"' + (state.role === slug ? ' selected' : '') + '>'
        + esc(r.name) + (r.site_admin ? ' — administers this site' : '') + '</option>';
    }).join('');

    var teams = state.teams.map(function (t) {
      var addable = t.members.filter(function (m) { return !m.present; });
      return '<div class="deheled-tm-team">'
        + '<div class="deheled-tm-team-head">'
        + '<h3>' + esc(t.name) + ' <span class="deheled-tm-count">' + t.members.length + '</span></h3>'
        + (addable.length
            ? '<button class="button" data-team="' + esc(t.id) + '">Add this team (' + addable.length + ')</button>'
            : '<span class="description">Everyone on this team is already here</span>')
        + '</div>'
        + '<ul class="deheled-tm-members">' + t.members.map(memberRow).join('') + '</ul>'
        + '</div>';
    }).join('');

    root.innerHTML = ''
      + '<div class="deheled-tm-bar">'
      + '  <label class="deheled-tm-role">Role'
      + '    <select id="deheled-tm-role"><option value="">Use each person’s own role</option>' + roleOptions + '</select>'
      + '  </label>'
      + '  <button class="button" id="deheled-tm-refresh">Refresh</button>'
      + '  <span class="deheled-tm-spacer"></span>'
      + '  <span class="deheled-tm-selected">' + chosen + ' selected</span>'
      + '  <button class="button button-primary" id="deheled-tm-review"' + (chosen ? '' : ' disabled') + '>Review</button>'
      + '</div>'
      + '<div id="deheled-tm-msg" class="deheled-tm-msg"></div>'
      + teams
      + othersBlock();

    wire();
  }

  function othersBlock() {
    if (!state.others.length) return '';
    return '<details class="deheled-tm-others">'
      + '<summary>' + state.others.length + ' other user' + (state.others.length === 1 ? '' : 's') + ' on this website</summary>'
      + '<p class="description">Not managed by Digital Elements, and not changed from here. '
      + 'Shown so you can see whether a colleague already has an account under a different address.</p>'
      + '<ul class="deheled-tm-members">' + state.others.map(function (u) {
          return '<li class="deheled-tm-member is-present"><span class="deheled-tm-name">' + esc(u.label)
            + '<small>' + esc(u.email) + '</small></span>'
            + '<span class="deheled-tm-badges"><span class="deheled-tm-chip">' + esc(u.roles.join(', ')) + '</span></span></li>';
        }).join('') + '</ul></details>';
  }

  function message(text, kind) {
    var el = document.getElementById('deheled-tm-msg');
    if (!el) return;
    el.className = 'deheled-tm-msg' + (kind ? ' ' + kind : '');
    el.textContent = text || '';
  }

  function wire() {
    root.querySelectorAll('input[type=checkbox][data-id]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        state.selected[cb.getAttribute('data-id')] = cb.checked;
        render();
      });
    });
    root.querySelectorAll('button[data-team]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var team = state.teams.filter(function (t) { return t.id === btn.getAttribute('data-team'); })[0];
        if (!team) return;
        team.members.forEach(function (m) { if (!m.present) state.selected[m.id] = true; });
        render();
      });
    });
    var role = document.getElementById('deheled-tm-role');
    if (role) role.addEventListener('change', function () { state.role = role.value; });
    var refresh = document.getElementById('deheled-tm-refresh');
    if (refresh) refresh.addEventListener('click', function () { loadRoster(true); });
    var review = document.getElementById('deheled-tm-review');
    if (review) review.addEventListener('click', doPreflight);
  }

  /* -------------------------------------------------------------- roster */

  function loadRoster(refresh) {
    message('Loading the roster…');
    post('deheled_tm_roster', { refresh: refresh ? 1 : '' }, function (err, data) {
      if (err) {
        // A gate failure comes back with its own state and title, so the
        // screen says what is actually wrong rather than "error".
        root.innerHTML = '<div class="deheled-license warn deheled-tm-unavailable">'
          + '<h2>' + esc(err.title || 'Unavailable') + '</h2>'
          + '<p class="description">' + esc(err.message || DEHELED_TM.strings.genericError) + '</p></div>';
        return;
      }
      state.teams = data.roster.teams || [];
      state.siteRoles = data.roster.siteRoles || [];
      state.roles = data.roles || {};
      state.others = data.others || [];
      state.selected = {};
      render();
    });
  }

  /* ------------------------------------------------------------- review */

  var ACTION_LABEL = {
    create: ['Will be added', 'ok'],
    update: ['Role will change', 'ok'],
    link_required: ['Already exists — needs linking', 'warn'],
    skip: ['Nothing to do', ''],
    blocked: ['Blocked', 'bad'],
  };

  function doPreflight() {
    var ids = selectedIds();
    if (!ids.length) return;
    message('Checking what would happen…');
    post('deheled_tm_preflight', { ids: ids, role: state.role }, function (err, data) {
      if (err) return message(err.message || DEHELED_TM.strings.genericError, 'bad');
      state.preflight = data;
      renderReview();
    });
  }

  function renderReview() {
    var rows = state.preflight.rows || [];
    var summary = state.preflight.summary || {};
    var adminSites = summary.adminSiteCount || 0;
    var actionable = summary.actionable || 0;

    var table = rows.map(function (r) {
      var a = ACTION_LABEL[r.action] || ACTION_LABEL.blocked;
      var blockers = (r.blockers || []).map(function (b) {
        return '<div class="deheled-tm-blocker">' + esc(b.message) + '</div>';
      }).join('');
      return '<tr><td>' + esc(r.staffLabel) + '<small>' + esc(r.staffEmail) + '</small></td>'
        + '<td><span class="deheled-tm-chip">' + esc(r.requestedRole) + '</span></td>'
        + '<td>' + (r.exists
            ? '<span class="deheled-tm-chip">' + esc((r.currentRoles || []).join(', ') || 'no role') + '</span>'
            : '<span class="description">no account</span>') + '</td>'
        + '<td><span class="deheled-tm-chip ' + a[1] + '">' + esc(a[0]) + '</span>' + blockers + '</td></tr>';
    }).join('');

    root.innerHTML = ''
      + '<h2>Review</h2>'
      + '<p class="description">Nothing has been created yet. '
      + 'Accounts are created by Digital Elements, which sends each person a set-password email — '
      + 'no password is ever shown here.</p>'
      + (adminSites
          ? '<div class="deheled-license bad deheled-tm-confirm">'
            + '<p><strong>This grants Administrator to ' + (summary.needsAdminConfirmation || 0) + ' '
            + ((summary.needsAdminConfirmation === 1) ? 'person' : 'people') + ' on this website.</strong></p>'
            + '<label><input type="checkbox" id="deheled-tm-admin" /> '
            + 'I confirm they should be able to administer this website.</label></div>'
          : '')
      + '<table class="widefat deheled-tm-table"><thead><tr>'
      + '<th>Person</th><th>Role</th><th>Currently</th><th>Outcome</th></tr></thead>'
      + '<tbody>' + table + '</tbody></table>'
      + '<div id="deheled-tm-msg" class="deheled-tm-msg"></div>'
      + '<p class="deheled-tm-actions">'
      + '<button class="button" id="deheled-tm-back">Back</button> '
      + '<button class="button button-primary" id="deheled-tm-apply"' + (actionable ? '' : ' disabled') + '>'
      + 'Add ' + actionable + ' ' + (actionable === 1 ? 'person' : 'people') + '</button></p>';

    document.getElementById('deheled-tm-back').addEventListener('click', render);
    document.getElementById('deheled-tm-apply').addEventListener('click', function () {
      var box = document.getElementById('deheled-tm-admin');
      if (box && !box.checked) return message('Tick the confirmation to continue.', 'bad');
      doAssign(box ? box.checked : false);
    });
  }

  /* ------------------------------------------------------------- assign */

  function newRequestId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }

  function doAssign(confirmAdmin) {
    if (state.busy) return;
    state.busy = true;
    // Generated ONCE per submission. Retry reuses it, which is what makes a
    // retry safe — the hub returns the same job instead of adding everyone
    // again.
    if (!state.requestId) state.requestId = newRequestId();
    message('Asking Digital Elements to add them…');

    post('deheled_tm_assign', {
      ids: selectedIds(), role: state.role,
      requestId: state.requestId, confirmAdmin: confirmAdmin ? 1 : '',
    }, function (err, data) {
      state.busy = false;
      if (err) return message(err.message || DEHELED_TM.strings.genericError, 'bad');
      state.jobId = data.jobId;
      pollJob();
    });
  }

  var OP_LABEL = {
    pending: ['Waiting', ''], processing: ['Working…', 'warn'],
    synced: ['Added', 'ok'], updated: ['Updated', 'ok'], linked: ['Linked', 'ok'],
    skipped: ['No change', ''], removed: ['Removed', ''],
    failed: ['Failed', 'bad'], interrupted: ['Interrupted', 'warn'],
  };

  function pollJob() {
    if (state.poll) clearInterval(state.poll);
    var tick = function () {
      post('deheled_tm_job', { jobId: state.jobId }, function (err, data) {
        if (err) {
          if (state.poll) clearInterval(state.poll);
          return message(err.message || DEHELED_TM.strings.genericError, 'bad');
        }
        renderResults(data.job);
        if (data.job.done && state.poll) { clearInterval(state.poll); state.poll = null; }
      });
    };
    tick();
    state.poll = setInterval(tick, 1500);
  }

  function renderResults(job) {
    var ops = job.operations || [];
    var failed = ops.filter(function (o) { return o.status === 'failed' || o.status === 'interrupted'; });
    var warned = ops.filter(function (o) { return (o.warnings || []).length; });

    var rows = ops.map(function (o) {
      var l = OP_LABEL[o.status] || OP_LABEL.pending;
      var warnings = (o.warnings || []).map(function (w) {
        return '<div class="deheled-tm-warn">' + esc(w.message) + '</div>';
      }).join('');
      return '<tr><td>' + esc(o.staffLabel || o.staffEmail) + '<small>' + esc(o.staffEmail) + '</small></td>'
        + '<td><span class="deheled-tm-chip">' + esc(o.requestedRole || '') + '</span></td>'
        + '<td><span class="deheled-tm-chip ' + l[1] + '">' + esc(l[0]) + '</span>'
        + (o.replayed ? ' <span class="deheled-tm-chip">already done</span>' : '')
        + (o.error ? '<div class="deheled-tm-blocker">' + esc(o.error) + '</div>' : '')
        + warnings + '</td></tr>';
    }).join('');

    root.innerHTML = ''
      + '<h2>Results</h2>'
      + (warned.length
          ? '<div class="deheled-license warn"><p><strong>' + warned.length + ' account'
            + (warned.length === 1 ? '' : 's') + ' created, but the set-password email couldn’t be sent.</strong> '
            + 'They can use the Lost Password link instead. Passwords are never shown or sent by this plugin.</p></div>'
          : '')
      + '<table class="widefat deheled-tm-table"><thead><tr>'
      + '<th>Person</th><th>Role</th><th>Result</th></tr></thead><tbody>' + rows + '</tbody></table>'
      + '<div id="deheled-tm-msg" class="deheled-tm-msg"></div>'
      + '<p class="deheled-tm-actions">'
      + (job.done && failed.length
          ? '<button class="button" id="deheled-tm-retry">Retry failed (' + failed.length + ')</button> '
          : '')
      + '<button class="button button-primary" id="deheled-tm-done">'
      + (job.done ? 'Done' : 'Run in background') + '</button></p>';

    var retry = document.getElementById('deheled-tm-retry');
    if (retry) retry.addEventListener('click', function () {
      // Same request id, so the hub replays rather than repeating.
      doAssign(false);
    });
    document.getElementById('deheled-tm-done').addEventListener('click', function () {
      if (state.poll) { clearInterval(state.poll); state.poll = null; }
      state.requestId = null;
      state.jobId = null;
      loadRoster(true);
    });
  }

  /* ---------------------------------------------------------------- boot */

  try {
    var seeded = JSON.parse(root.getAttribute('data-roster') || '{}');
    state.teams = seeded.teams || [];
    state.siteRoles = seeded.siteRoles || [];
    state.roles = JSON.parse(root.getAttribute('data-roles') || '{}');
    state.others = JSON.parse(root.getAttribute('data-others') || '[]');
    render();
  } catch (e) {
    loadRoster(false);
  }
})();
