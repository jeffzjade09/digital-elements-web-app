/* Team Members — adding Digital Elements colleagues to this website.
 *
 * Everything this script does is a request the server re-checks. The gate runs
 * in PHP on every handler, so nothing here is a control: disabling a button is
 * a courtesy to the person using the screen, not a restriction.
 *
 * Flow: roster -> select -> review (preflight) -> confirm -> assign -> poll ->
 * results. Nothing is created until the review has been seen and confirmed.
 *
 * HOW THIS RENDERS, AND WHY IT MATTERS.
 *
 * The panel's shell is built ONCE and then mutated in place. Filtering toggles
 * the `hidden` attribute on rows that already exist; selection sets .checked
 * and rewrites a few text nodes. Nothing that carries a listener, focus or a
 * caret is ever replaced.
 *
 * The earlier version rebuilt the whole panel with innerHTML on every keystroke
 * and every checkbox. That is the thing to avoid here: it drops every listener
 * attached to the markup it replaces (they were re-attached each pass, which is
 * why it worked), it throws focus back to the top of the page, and it would
 * reset the caret in the search box on every character typed.
 *
 * Where a whole region genuinely has to be re-drawn — the team cards after a
 * refresh, a results table on each poll — the listeners live on a STABLE
 * PARENT that is never replaced, so they survive the re-draw. Those regions
 * contain no focusable control that has to keep its state across the re-draw.
 */
(function () {
  var root = document.getElementById('deheled-tm-root');
  if (!root || typeof DEHELED_TM === 'undefined') return;

  var headerActions = document.getElementById('deheled-tm-header-actions');

  var state = {
    teams: [],
    roles: {},
    others: [],
    siteRoles: [],
    selected: {},          // staffUserId -> true
    role: '',              // '' = each person's own default
    search: '',
    team: '',              // '' = every team
    collapsed: {},         // teamId -> true
    loaded: false,         // whether a roster has ever arrived
    preflight: null,
    requestId: null,       // one per submission, reused on Retry
    jobId: null,
    poll: null,
    busy: false,
  };

  var ui = {};             // cached nodes for the panel shell
  var rows = [];           // one entry per rendered member row

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

  /* ------------------------------------------------- remembering the layout */

  /* Which cards this person had collapsed, for THIS website. A display
   * preference: it is read defensively and a failure is simply ignored, so a
   * private window or blocked site data costs nothing but the memory. */
  var STORE_KEY = 'deheled-tm-collapsed:' + (DEHELED_TM.siteKey || 'site');

  function loadCollapsed() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      if (!raw) return {};
      var ids = JSON.parse(raw);
      if (!Array.isArray(ids)) return {};
      var out = {};
      ids.forEach(function (id) { out[String(id)] = true; });
      return out;
    } catch (e) { return {}; }
  }

  function saveCollapsed() {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(Object.keys(state.collapsed).filter(function (id) {
        return state.collapsed[id];
      })));
    } catch (e) { /* not worth telling anyone about */ }
  }

  /* ----------------------------------------------------------- small pieces */

  function selectedIds() {
    return Object.keys(state.selected).filter(function (id) { return state.selected[id]; });
  }

  /** A member this screen may act on: on the roster, and not already here. */
  function isEligible(m) { return !m.present; }

  function initials(label, email) {
    var source = String(label || email || '').trim();
    var parts = source.split(/[\s._-]+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  /* Stable per-person tint, so the same colleague looks the same on every
   * visit and across sites. Presentational only. */
  function tone(seed) {
    var s = String(seed || ''), n = 0;
    for (var i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) >>> 0;
    return 't' + (n % 5 + 1);
  }

  /**
   * The one status badge on a member row.
   *
   * The five invitation states and their sentences come from the server and
   * are not re-decided here. Where the badge itself has to be short enough to
   * sit on a single-line row, the server's full sentence is kept verbatim as
   * the tooltip rather than dropped — the wording is the same wording the
   * dashboard uses, and two screens describing one account differently is how
   * somebody resends an invitation that already worked.
   *
   * Colour is never the only carrier: every badge states its meaning in words.
   */
  function statusBadge(m) {
    if (!m.present) {
      // The dashboard thought otherwise: somebody removed this account in WP
      // Admin, and whoever is reading this is probably wondering where it went.
      if (m.hubThought) {
        return { cls: 'warn', text: 'Removed on this website',
                 title: 'Digital Elements recorded this person as being on this website. The account isn\'t here now.' };
      }
      return { cls: '', text: 'Not on this site', title: '' };
    }

    var inv = m.invite || {};
    // An "Active" we inferred from a used set-password link is weaker evidence
    // than one we watched happen. Both read "Active"; the tooltip says which,
    // for whoever is looking into one specific account.
    var signal = inv.signal === 'meta' ? 'Observed: they completed a password reset.'
      : inv.signal === 'key_cleared' ? 'Inferred: their set-password link has been used.'
      : '';

    switch (inv.state) {
      case 'activated':
        return { cls: 'ok', text: inv.label || 'Active', title: signal };
      case 'pending_setup':
      case 'invited':
        return { cls: 'warn', text: 'Invitation pending', title: inv.label || '' };
      case 'delivery_failed':
        return { cls: 'bad', text: 'Failed', title: inv.label || inv.why || '' };
      case 'unknown':
        return { cls: '', text: inv.label || 'Not invited by us', title: inv.why || '' };
      default:
        return { cls: 'ok', text: 'Already here', title: '' };
    }
  }

  function announce(text, kind) {
    if (!ui.msg) return;
    ui.msg.className = 'deheled-tm-msg' + (kind ? ' ' + kind : ' info');
    ui.msg.textContent = text || '';
  }

  /* =========================================================== panel shell = */

  /**
   * Build the panel once. Every listener attached here is attached to a node
   * that is never replaced, either because it is a control in the shell or
   * because it is a stable container delegating for its children.
   */
  function buildShell() {
    root.innerHTML = ''
      + '<div class="deheled-tm-panel">'
      + '  <div id="deheled-tm-msg" class="deheled-tm-msg" role="status" aria-live="polite"></div>'
      + '  <div id="deheled-tm-notice" class="deheled-tm-notice" hidden>'
      + '    <span id="deheled-tm-notice-text"></span>'
      + '    <button type="button" class="button" id="deheled-tm-retry">Try again</button>'
      + '  </div>'
      + '  <div class="deheled-tm-summary">'
      + statTile('teams', 'Teams') + statTile('members', 'Members')
      + statTile('added', 'Already added') + statTile('chosen', 'Selected')
      + '  </div>'
      + '  <div class="deheled-tm-toolbar">'
      + '    <div class="deheled-tm-search">'
      + '      <label class="deheled-tm-sronly" for="deheled-tm-q">Search members by name or email</label>'
      + '      <input type="search" id="deheled-tm-q" placeholder="Search members (name or email)…" autocomplete="off" />'
      + '    </div>'
      + '    <div class="deheled-tm-field">'
      + '      <label class="deheled-tm-sronly" for="deheled-tm-team">Filter by team</label>'
      + '      <select id="deheled-tm-team"><option value="">All teams</option></select>'
      + '    </div>'
      + '    <div class="deheled-tm-field">'
      + '      <label class="deheled-tm-sronly" for="deheled-tm-role">Role to assign</label>'
      + '      <select id="deheled-tm-role"></select>'
      + '    </div>'
      + '    <span class="deheled-tm-spacer"></span>'
      + '    <span class="deheled-tm-count" id="deheled-tm-count">0 selected</span>'
      + '    <button type="button" class="button button-primary" id="deheled-tm-review-bar">Review selected</button>'
      + '  </div>'
      + '  <div class="deheled-tm-teams" id="deheled-tm-teams"></div>'
      + '  <div class="deheled-tm-empty" id="deheled-tm-empty" hidden></div>'
      + '  <div id="deheled-tm-others"></div>'
      + '  <div class="deheled-tm-stickybar" id="deheled-tm-sticky" hidden>'
      + '    <span class="deheled-tm-stickybar-count" id="deheled-tm-sticky-count">0 members selected</span>'
      + '    <span class="deheled-tm-stickybar-hint">Select one or more team members to review and continue.</span>'
      + '    <span class="deheled-tm-spacer"></span>'
      + '    <button type="button" class="button" id="deheled-tm-clear">Clear selection</button>'
      + '    <button type="button" class="button button-primary" id="deheled-tm-review-sticky">Review selected</button>'
      + '  </div>'
      + '</div>';

    ui = {
      msg:        document.getElementById('deheled-tm-msg'),
      notice:     document.getElementById('deheled-tm-notice'),
      noticeText: document.getElementById('deheled-tm-notice-text'),
      retry:      document.getElementById('deheled-tm-retry'),
      search:     document.getElementById('deheled-tm-q'),
      teamPick:   document.getElementById('deheled-tm-team'),
      rolePick:   document.getElementById('deheled-tm-role'),
      count:      document.getElementById('deheled-tm-count'),
      reviewBar:  document.getElementById('deheled-tm-review-bar'),
      teams:      document.getElementById('deheled-tm-teams'),
      empty:      document.getElementById('deheled-tm-empty'),
      others:     document.getElementById('deheled-tm-others'),
      sticky:     document.getElementById('deheled-tm-sticky'),
      stickyCount: document.getElementById('deheled-tm-sticky-count'),
      clear:      document.getElementById('deheled-tm-clear'),
      reviewSticky: document.getElementById('deheled-tm-review-sticky'),
      stat: {
        teams:   document.getElementById('deheled-tm-stat-teams'),
        members: document.getElementById('deheled-tm-stat-members'),
        added:   document.getElementById('deheled-tm-stat-added'),
        chosen:  document.getElementById('deheled-tm-stat-chosen'),
      },
    };

    buildHeaderActions();

    // Filtering runs on the existing rows. The input is never re-created, so
    // focus and caret position are untouched by definition.
    ui.search.addEventListener('input', function () {
      state.search = ui.search.value.trim().toLowerCase();
      applyFilter();
    });
    ui.teamPick.addEventListener('change', function () {
      state.team = ui.teamPick.value;
      applyFilter();
    });
    ui.rolePick.addEventListener('change', function () { state.role = ui.rolePick.value; });

    ui.retry.addEventListener('click', function () { loadRoster(true); });
    ui.clear.addEventListener('click', function () {
      state.selected = {};
      syncSelection();
      announce('Selection cleared.');
    });
    ui.reviewBar.addEventListener('click', doPreflight);
    ui.reviewSticky.addEventListener('click', doPreflight);

    // One listener for every card and row, on the container that outlives them
    // all. Re-drawing the cards after a refresh cannot detach it.
    ui.teams.addEventListener('change', onTeamsChange);
    ui.teams.addEventListener('click', onTeamsClick);
  }

  function statTile(key, label) {
    return '<div class="deheled-tm-stat">'
      + '<span class="deheled-tm-stat-icon is-' + key + '" aria-hidden="true">' + statGlyph(key) + '</span>'
      + '<span><span class="deheled-tm-stat-value" id="deheled-tm-stat-' + key + '">0</span>'
      + '<span class="deheled-tm-stat-label">' + esc(label) + '</span></span>'
      + '</div>';
  }

  function statGlyph(key) {
    return key === 'teams' ? '&#9783;' : key === 'members' ? '&#9679;' : key === 'added' ? '&#10003;' : '&#9711;';
  }

  /* Rebuilt whenever the shell is, so ui.refresh and ui.reviewHead always
   * refer to the buttons actually on the page. The review and results screens
   * empty this slot; coming back rebuilds it. */
  function buildHeaderActions() {
    if (!headerActions) return;
    headerActions.innerHTML = ''
      + '<button type="button" class="button" id="deheled-tm-refresh">Refresh</button>'
      + '<button type="button" class="button button-primary" id="deheled-tm-review-head">Review selected</button>';
    ui.refresh = document.getElementById('deheled-tm-refresh');
    ui.reviewHead = document.getElementById('deheled-tm-review-head');
    ui.refresh.addEventListener('click', function () { loadRoster(true); });
    ui.reviewHead.addEventListener('click', doPreflight);
  }

  /* ============================================================ team cards = */

  /**
   * Draw the cards for the roster currently in state.
   *
   * innerHTML here is a full data change, not an update: the listeners for
   * everything inside live on ui.teams, which is not replaced.
   */
  function buildTeams() {
    rows = [];

    ui.teams.innerHTML = state.teams.map(function (t, i) {
      var collapsed = !!state.collapsed[t.id];
      var eligible = t.members.filter(isEligible).length;
      var cardId = 'deheled-tm-body-' + i;

      return '<section class="deheled-tm-team' + (collapsed ? ' is-collapsed' : '') + '" data-team="' + esc(t.id) + '">'
        + '<div class="deheled-tm-team-head">'
        + '<h2>' + esc(t.name) + ' <span class="deheled-tm-team-count" data-count-for="' + esc(t.id) + '">'
        + t.members.length + '</span></h2>'
        + '<span class="deheled-tm-spacer"></span>'
        + (eligible
            ? '<button type="button" class="button" data-add-team="' + esc(t.id) + '">Add team</button>'
            : '<span class="description">Everyone is already here</span>')
        + '<button type="button" class="deheled-tm-toggle" data-toggle="' + esc(t.id) + '"'
        + ' aria-expanded="' + (collapsed ? 'false' : 'true') + '" aria-controls="' + cardId + '">'
        + '<span class="deheled-tm-caret" aria-hidden="true">&#9662;</span>'
        + '<span class="deheled-tm-sronly">' + esc(t.name) + ' members</span>'
        + '</button>'
        + '</div>'
        + '<div class="deheled-tm-selectall">'
        + (eligible
            ? '<label><input type="checkbox" data-select-team="' + esc(t.id) + '" /> Select all</label>'
            : '<span class="description">Nothing to select</span>')
        + '</div>'
        + '<ul class="deheled-tm-members" id="' + cardId + '">'
        + t.members.map(function (m) { return memberRow(m, t); }).join('')
        + '</ul>'
        + '</section>';
    }).join('');

    // Cache each row with what filtering needs, so a keystroke is a loop over
    // plain objects rather than a query of the document.
    //
    // Walked from the DOM rather than looked up by id, because ONE COLLEAGUE
    // CAN BE ON TWO TEAMS: querying by member id would find the first row
    // twice and leave the second uncached, permanently visible and immune to
    // the filter. Each rendered row is its own entry; they share a selection
    // through state.selected, which is keyed on the person, not the row.
    Array.prototype.forEach.call(ui.teams.querySelectorAll('.deheled-tm-member[data-row]'), function (el) {
      rows.push({
        el: el,
        id: el.getAttribute('data-row'),
        teamId: el.getAttribute('data-team-row'),
        eligible: el.getAttribute('data-eligible') === '1',
        box: el.querySelector('input[type=checkbox][data-id]'),
        text: (el.getAttribute('data-text') || '').toLowerCase(),
        visible: true,
      });
    });

    buildTeamFilter();
    applyFilter();
  }

  function memberRow(m, team) {
    var badge = statusBadge(m);
    var eligible = isEligible(m);
    var roleText = m.present ? (m.roles || []).join(', ') : m.role;
    var inv = m.invite || {};

    // Unique per ROW, not per person: the same colleague on two teams renders
    // twice, and two elements sharing an id would point every label at the
    // first of them.
    var boxId = 'deheled-tm-cb-' + esc(team.id) + '-' + esc(m.id);

    var control = eligible
      ? '<input type="checkbox" data-id="' + esc(m.id) + '" id="' + boxId + '"'
        + (state.selected[m.id] ? ' checked' : '') + ' />'
      // Already here: shown so the list is the whole team, but not selectable —
      // re-adding someone is not a thing this screen does.
      : '<input type="checkbox" disabled aria-hidden="true" tabindex="-1" />';

    var action = '';
    if (inv.canResend) {
      action = '<button type="button" class="button-link deheled-tm-resend" data-resend="' + esc(m.id) + '">'
        + 'Resend invitation</button>';
    } else if (inv.why) {
      // An absent button reads as a bug, so the sentence naming what they can
      // do instead stays available — as a tooltip, so the row stays one line.
      action = '<span class="deheled-tm-why" title="' + esc(inv.why) + '" tabindex="0"'
        + ' aria-label="' + esc(inv.why) + '">Why?</span>';
    }

    return '<li class="deheled-tm-member' + (m.present ? ' is-present' : '') + '"'
      + ' data-row="' + esc(m.id) + '" data-team-row="' + esc(team.id) + '"'
      + ' data-eligible="' + (eligible ? '1' : '0') + '"'
      + ' data-text="' + esc(String(m.label || '') + ' ' + String(m.email || '')) + '">'
      + control
      + '<span class="deheled-tm-avatar ' + tone(m.email) + '" aria-hidden="true">' + esc(initials(m.label, m.email)) + '</span>'
      + (eligible
          ? '<label class="deheled-tm-who" for="' + boxId + '">'
          : '<span class="deheled-tm-who">')
      + '<span class="deheled-tm-name">' + esc(m.label) + '</span>'
      + '<span class="deheled-tm-email">' + esc(m.email) + '</span>'
      + (eligible ? '</label>' : '</span>')
      + '<span class="deheled-tm-badges">'
      + (roleText ? '<span class="deheled-tm-chip role">' + esc(roleText) + '</span>' : '')
      + (m.present && !m.managed ? '<span class="deheled-tm-chip">Not managed by us</span>' : '')
      + '<span class="deheled-tm-chip ' + badge.cls + '"'
      + (badge.title ? ' title="' + esc(badge.title) + '"' : '') + '>' + esc(badge.text) + '</span>'
      + '</span>'
      + (action ? '<span class="deheled-tm-rowaction">' + action + '</span>' : '')
      + '</li>';
  }

  function buildTeamFilter() {
    var current = state.team;
    ui.teamPick.innerHTML = '<option value="">All teams</option>'
      + state.teams.map(function (t) {
          return '<option value="' + esc(t.id) + '">' + esc(t.name) + '</option>';
        }).join('');
    // A team that survived the refresh keeps the filter; one that didn't
    // silently widens it rather than showing nothing at all.
    ui.teamPick.value = current;
    if (ui.teamPick.value !== current) { state.team = ''; ui.teamPick.value = ''; }
  }

  function buildRoleOptions() {
    ui.rolePick.innerHTML = '<option value="">Use each person’s own role</option>'
      + Object.keys(state.roles).map(function (slug) {
          var r = state.roles[slug];
          return '<option value="' + esc(slug) + '">'
            + esc(r.name) + (r.site_admin ? ' — administers this site' : '') + '</option>';
        }).join('');
    ui.rolePick.value = state.role;
    if (ui.rolePick.value !== state.role) { state.role = ''; ui.rolePick.value = ''; }
  }

  function buildOthers() {
    if (!state.others.length) { ui.others.innerHTML = ''; return; }
    ui.others.innerHTML = '<details class="deheled-tm-others">'
      + '<summary>' + state.others.length + ' other user' + (state.others.length === 1 ? '' : 's') + ' on this website</summary>'
      + '<p class="description">Not managed by Digital Elements, and not changed from here. '
      + 'Shown so you can see whether a colleague already has an account under a different address.</p>'
      + '<ul class="deheled-tm-members">' + state.others.map(function (u) {
          return '<li class="deheled-tm-member is-present">'
            + '<span class="deheled-tm-avatar ' + tone(u.email) + '" aria-hidden="true">'
            + esc(initials(u.label, u.email)) + '</span>'
            + '<span class="deheled-tm-who"><span class="deheled-tm-name">' + esc(u.label) + '</span>'
            + '<span class="deheled-tm-email">' + esc(u.email) + '</span></span>'
            + '<span class="deheled-tm-badges"><span class="deheled-tm-chip role">'
            + esc((u.roles || []).join(', ')) + '</span></span></li>';
        }).join('') + '</ul></details>';
  }

  /* ============================================================== filtering = */

  /**
   * Client-side, over the roster already fetched. No request is made: Refresh
   * is the only thing that re-reads the roster, and observed[] — which the
   * server builds from the WHOLE roster on that call — is unaffected by what
   * is on screen here.
   *
   * Rows are hidden, never removed, so no listener, checkbox or focused
   * element is destroyed by typing.
   */
  function applyFilter() {
    var q = state.search;
    var shown = {};

    rows.forEach(function (r) {
      var match = (!q || r.text.indexOf(q) !== -1)
        && (!state.team || r.teamId === state.team);
      if (r.visible !== match) {
        r.el.hidden = !match;
        r.visible = match;
      }
      if (match) shown[r.teamId] = (shown[r.teamId] || 0) + 1;
    });

    var anyTeam = false;
    Array.prototype.forEach.call(ui.teams.querySelectorAll('.deheled-tm-team'), function (card) {
      var id = card.getAttribute('data-team');
      var n = shown[id] || 0;
      card.hidden = n === 0;
      if (n) anyTeam = true;
      var counter = card.querySelector('[data-count-for]');
      if (counter) counter.textContent = String(n);
    });

    // Two different empties, because they need two different things done.
    if (!state.teams.length) {
      ui.empty.textContent = 'There are no team members to add yet. They’re created in the Digital Elements dashboard.';
      ui.empty.hidden = false;
    } else if (!anyTeam) {
      ui.empty.textContent = 'No members match that search.';
      ui.empty.hidden = false;
    } else {
      ui.empty.hidden = true;
    }

    syncSelection();
  }

  /* ============================================================== selection = */

  /**
   * Push the current selection into the DOM by mutation only: .checked on
   * boxes that already exist, textContent on counters, attributes on buttons.
   * Nothing is rebuilt, so nothing loses its listeners or its focus.
   */
  function syncSelection() {
    var chosen = selectedIds().length;
    var members = 0, added = 0;
    state.teams.forEach(function (t) {
      members += t.members.length;
      t.members.forEach(function (m) { if (m.present) added++; });
    });

    setText(ui.stat.teams, state.teams.length);
    setText(ui.stat.members, members);
    setText(ui.stat.added, added);
    setText(ui.stat.chosen, chosen);
    setText(ui.count, chosen + ' selected');
    setText(ui.stickyCount, chosen + ' member' + (chosen === 1 ? '' : 's') + ' selected');

    rows.forEach(function (r) {
      if (!r.box || !r.eligible) return;
      var on = !!state.selected[r.id];
      if (r.box.checked !== on) r.box.checked = on;
    });

    // Select-all reflects only the rows it would actually act on: eligible,
    // and currently visible. Indeterminate when it is a partial selection.
    Array.prototype.forEach.call(ui.teams.querySelectorAll('[data-select-team]'), function (box) {
      var id = box.getAttribute('data-select-team');
      var pool = rows.filter(function (r) { return r.teamId === id && r.eligible && r.visible; });
      var on = pool.filter(function (r) { return state.selected[r.id]; }).length;
      box.checked = pool.length > 0 && on === pool.length;
      box.indeterminate = on > 0 && on < pool.length;
      box.disabled = pool.length === 0;
    });

    [ui.reviewBar, ui.reviewSticky, ui.reviewHead].forEach(function (btn) {
      if (!btn) return;
      btn.disabled = !chosen;
      btn.setAttribute('aria-disabled', chosen ? 'false' : 'true');
    });

    // Space for the bar is reserved in CSS at all times, so showing it here
    // overlays reserved space rather than pushing the page down.
    ui.sticky.hidden = !chosen;
  }

  function setText(el, value) {
    if (el && el.textContent !== String(value)) el.textContent = String(value);
  }

  function onTeamsChange(e) {
    var t = e.target;
    if (!t) return;

    if (t.hasAttribute && t.hasAttribute('data-id')) {
      state.selected[t.getAttribute('data-id')] = t.checked;
      syncSelection();
      return;
    }
    if (t.hasAttribute && t.hasAttribute('data-select-team')) {
      var id = t.getAttribute('data-select-team');
      var on = t.checked;
      // Only ever the eligible ones: nobody already on this site, and nobody
      // hidden by the current filter.
      rows.forEach(function (r) {
        if (r.teamId === id && r.eligible && r.visible) state.selected[r.id] = on;
      });
      syncSelection();
    }
  }

  function onTeamsClick(e) {
    var toggle = closest(e.target, '[data-toggle]');
    if (toggle) {
      var tid = toggle.getAttribute('data-toggle');
      var card = closest(toggle, '.deheled-tm-team');
      var nowCollapsed = !state.collapsed[tid];
      state.collapsed[tid] = nowCollapsed;
      if (!nowCollapsed) delete state.collapsed[tid];
      if (card) card.classList.toggle('is-collapsed', nowCollapsed);
      toggle.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
      saveCollapsed();
      return;
    }

    var add = closest(e.target, '[data-add-team]');
    if (add) {
      var teamId = add.getAttribute('data-add-team');
      rows.forEach(function (r) {
        if (r.teamId === teamId && r.eligible && r.visible) state.selected[r.id] = true;
      });
      syncSelection();
      announce('Selected everyone on this team who isn’t already here.');
      return;
    }

    var resend = closest(e.target, '[data-resend]');
    if (resend) onResend(resend);
  }

  function closest(el, selector) {
    while (el && el !== root) {
      if (el.nodeType === 1 && el.matches && el.matches(selector)) return el;
      el = el.parentNode;
    }
    return null;
  }

  /* ================================================================ resend = */

  function onResend(button) {
    var id = button.getAttribute('data-resend');
    if (!id) return;
    button.disabled = true;
    button.textContent = 'Sending…';
    announce('Sending…');
    post('deheled_tm_resend', { staffId: id }, function (err, data) {
      if (err) {
        button.disabled = false;
        button.textContent = 'Resend invitation';
        return announce(err.message || DEHELED_TM.strings.genericError, 'warn');
      }
      // Re-read rather than assume: whether the email actually went out is the
      // whole question, and only the website can answer it.
      announce(data.message || 'Sent.', data.delivered ? 'ok' : 'warn');
      loadRoster(true);
    });
  }

  /* ================================================================ roster = */

  function loadRoster(refresh) {
    announce(refresh ? DEHELED_TM.strings.refreshing : DEHELED_TM.strings.loading);
    if (ui.refresh) ui.refresh.disabled = true;

    post('deheled_tm_roster', { refresh: refresh ? 1 : '' }, function (err, data) {
      if (ui.refresh) ui.refresh.disabled = false;

      if (err) {
        // A VERDICT FROM THE GATE is not a failed request: the licence expired,
        // or permission was withdrawn, while this page sat open. The screen
        // really is unavailable now, and each of those states has its own title
        // and its own thing to do about it — so it replaces the panel rather
        // than sitting in a corner as a retry.
        if (err.state) {
          showUnavailable(err.title || 'Unavailable', err.message || DEHELED_TM.strings.genericError);
          return;
        }
        // Anything else is the request failing, and a failed request must not
        // cost the roster already on screen. Keep it, say so, offer a retry.
        if (state.loaded) {
          announce('');
          ui.noticeText.textContent = (err.message || DEHELED_TM.strings.genericError)
            + ' ' + DEHELED_TM.strings.kept;
          ui.notice.hidden = false;
          return;
        }
        showUnavailable('Unavailable', err.message || DEHELED_TM.strings.genericError);
        return;
      }

      ui.notice.hidden = true;
      state.teams = data.roster.teams || [];
      state.siteRoles = data.roster.siteRoles || [];
      state.roles = data.roles || {};
      state.others = data.others || [];
      state.selected = {};
      state.loaded = true;

      buildRoleOptions();
      buildTeams();
      buildOthers();
      announce(DEHELED_TM.strings.loaded, 'ok');
    });
  }

  function showUnavailable(title, message) {
    root.innerHTML = '<div class="deheled-license warn deheled-tm-unavailable">'
      + '<h2>' + esc(title) + '</h2>'
      + '<p class="description">' + esc(message) + '</p></div>';
    ui = {};
    rows = [];
  }

  /* ================================================================ review = */

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
    announce('Checking what would happen…');
    post('deheled_tm_preflight', { ids: ids, role: state.role }, function (err, data) {
      if (err) return announce(err.message || DEHELED_TM.strings.genericError, 'bad');
      state.preflight = data;
      renderReview();
    });
  }

  function renderReview() {
    var rowsOut = state.preflight.rows || [];
    var summary = state.preflight.summary || {};
    var adminSites = summary.adminSiteCount || 0;
    var actionable = summary.actionable || 0;

    var table = rowsOut.map(function (r) {
      var a = ACTION_LABEL[r.action] || ACTION_LABEL.blocked;
      var blockers = (r.blockers || []).map(function (b) {
        return '<div class="deheled-tm-blocker">' + esc(b.message) + '</div>';
      }).join('');
      return '<tr><td>' + esc(r.staffLabel) + '<small>' + esc(r.staffEmail) + '</small></td>'
        + '<td><span class="deheled-tm-chip role">' + esc(r.requestedRole) + '</span></td>'
        + '<td>' + (r.exists
            ? '<span class="deheled-tm-chip role">' + esc((r.currentRoles || []).join(', ') || 'no role') + '</span>'
            : '<span class="description">no account</span>') + '</td>'
        + '<td><span class="deheled-tm-chip ' + a[1] + '">' + esc(a[0]) + '</span>' + blockers + '</td></tr>';
    }).join('');

    root.innerHTML = ''
      + '<h2 class="deheled-tm-h2">Review</h2>'
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
      + '<div id="deheled-tm-msg" class="deheled-tm-msg" role="status" aria-live="polite"></div>'
      + '<p class="deheled-tm-actions">'
      + '<button type="button" class="button" id="deheled-tm-back">Back</button> '
      + '<button type="button" class="button button-primary" id="deheled-tm-apply"' + (actionable ? '' : ' disabled aria-disabled="true"') + '>'
      + 'Add ' + actionable + ' ' + (actionable === 1 ? 'person' : 'people') + '</button></p>';

    ui.msg = document.getElementById('deheled-tm-msg');
    if (headerActions) headerActions.innerHTML = '';

    document.getElementById('deheled-tm-back').addEventListener('click', showPanel);
    document.getElementById('deheled-tm-apply').addEventListener('click', function () {
      var box = document.getElementById('deheled-tm-admin');
      if (box && !box.checked) return announce('Tick the confirmation to continue.', 'bad');
      doAssign(box ? box.checked : false);
    });
  }

  /** Back to the roster: the shell is rebuilt from state, selection intact. */
  function showPanel() {
    buildShell();
    buildRoleOptions();
    buildTeams();
    buildOthers();
    ui.search.value = state.search;
    ui.teamPick.value = state.team;
  }

  /* ================================================================ assign = */

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
    announce('Asking Digital Elements to add them…');

    post('deheled_tm_assign', {
      ids: selectedIds(), role: state.role,
      requestId: state.requestId, confirmAdmin: confirmAdmin ? 1 : '',
    }, function (err, data) {
      state.busy = false;
      if (err) return announce(err.message || DEHELED_TM.strings.genericError, 'bad');
      state.jobId = data.jobId;
      buildResultsShell();
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
          if (state.poll) { clearInterval(state.poll); state.poll = null; }
          return announce(err.message || DEHELED_TM.strings.genericError, 'bad');
        }
        updateResults(data.job);
        if (data.job.done && state.poll) { clearInterval(state.poll); state.poll = null; }
      });
    };
    tick();
    state.poll = setInterval(tick, 1500);
  }

  /**
   * The results shell, built once per job.
   *
   * The poll ticks every 1.5s. Rebuilding the buttons on each tick would drop
   * their listeners and steal focus from anyone using the keyboard, so only
   * the notice and the table body — neither of which holds a control — are
   * rewritten, and the buttons are mutated in place.
   */
  function buildResultsShell() {
    root.innerHTML = ''
      + '<h2 class="deheled-tm-h2">Results</h2>'
      + '<div id="deheled-tm-res-warn"></div>'
      + '<table class="widefat deheled-tm-table"><thead><tr>'
      + '<th>Person</th><th>Role</th><th>Result</th></tr></thead>'
      + '<tbody id="deheled-tm-res-body"></tbody></table>'
      + '<div id="deheled-tm-msg" class="deheled-tm-msg" role="status" aria-live="polite"></div>'
      + '<p class="deheled-tm-actions">'
      + '<button type="button" class="button" id="deheled-tm-retry-failed" hidden></button> '
      + '<button type="button" class="button button-primary" id="deheled-tm-done">Run in background</button></p>';

    ui.msg = document.getElementById('deheled-tm-msg');
    ui.resWarn = document.getElementById('deheled-tm-res-warn');
    ui.resBody = document.getElementById('deheled-tm-res-body');
    ui.retryFailed = document.getElementById('deheled-tm-retry-failed');
    ui.done = document.getElementById('deheled-tm-done');
    if (headerActions) headerActions.innerHTML = '';

    // Same request id, so the hub replays rather than repeating.
    ui.retryFailed.addEventListener('click', function () { doAssign(false); });
    ui.done.addEventListener('click', function () {
      if (state.poll) { clearInterval(state.poll); state.poll = null; }
      state.requestId = null;
      state.jobId = null;
      state.selected = {};
      showPanel();
      loadRoster(true);
    });
  }

  function updateResults(job) {
    var ops = job.operations || [];
    var failed = ops.filter(function (o) { return o.status === 'failed' || o.status === 'interrupted'; });
    var warned = ops.filter(function (o) { return (o.warnings || []).length; });

    ui.resBody.innerHTML = ops.map(function (o) {
      var l = OP_LABEL[o.status] || OP_LABEL.pending;
      var warnings = (o.warnings || []).map(function (w) {
        return '<div class="deheled-tm-warn">' + esc(w.message) + '</div>';
      }).join('');
      return '<tr><td>' + esc(o.staffLabel || o.staffEmail) + '<small>' + esc(o.staffEmail) + '</small></td>'
        + '<td><span class="deheled-tm-chip role">' + esc(o.requestedRole || '') + '</span></td>'
        + '<td><span class="deheled-tm-chip ' + l[1] + '">' + esc(l[0]) + '</span>'
        + (o.replayed ? ' <span class="deheled-tm-chip">already done</span>' : '')
        + (o.error ? '<div class="deheled-tm-blocker">' + esc(o.error) + '</div>' : '')
        + warnings + '</td></tr>';
    }).join('');

    ui.resWarn.innerHTML = warned.length
      ? '<div class="deheled-license warn"><p><strong>' + warned.length + ' account'
        + (warned.length === 1 ? '' : 's') + ' created, but the set-password email couldn’t be sent.</strong> '
        + 'They can use the Lost Password link instead. Passwords are never shown or sent by this plugin.</p></div>'
      : '';

    var showRetry = !!(job.done && failed.length);
    ui.retryFailed.hidden = !showRetry;
    if (showRetry) ui.retryFailed.textContent = 'Retry failed (' + failed.length + ')';
    setText(ui.done, job.done ? 'Done' : 'Run in background');
  }

  /* ================================================================== boot = */

  state.collapsed = loadCollapsed();
  buildShell();

  try {
    var seeded = JSON.parse(root.getAttribute('data-roster') || '{}');
    state.teams = seeded.teams || [];
    state.siteRoles = seeded.siteRoles || [];
    state.roles = JSON.parse(root.getAttribute('data-roles') || '{}');
    state.others = JSON.parse(root.getAttribute('data-others') || '[]');
    state.loaded = true;
    buildRoleOptions();
    buildTeams();
    buildOthers();
  } catch (e) {
    loadRoster(false);
  }
})();
