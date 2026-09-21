/* Centralized WordPress user management — Teams and staff roster.
 *
 * Loaded after index.html's inline script, so the shared helpers defined there
 * (esc, escJs, ICON, ME) are available. Kept in its own file because
 * index.html is already ~2,400 lines, and because this whole feature is
 * destined to move to Nexus as a unit.
 *
 * This phase is entirely app-side: nothing here talks to a WordPress site.
 * Website assignments, role sync and the per-site progress views arrive with
 * the phases that add plugin calls.
 */

const WPU = {
  tab: "teams",
  teams: [],
  users: [],
  roles: [],
  roleSiteTotal: 0,
  loaded: false,
  websites: [],
  assignments: [],
  filters: { q: "", team: "", role: "", status: "", website: "", sync: "" },
  selected: new Set(),
};

const WPU_TABS = [
  { id: "teams", label: "Teams" },
  { id: "users", label: "Users" },
  { id: "websites", label: "Websites" },
  { id: "sync", label: "Sync status" },
  { id: "audit", label: "Activity log" },
];

// How a site's readiness is presented. One place decides the wording and colour
// so the Websites tab and every site picker agree.
const WPU_READINESS = {
  ready:                  { label: "Ready",           cls: "ok" },
  needs_enrollment:       { label: "Not connected",   cls: "warn" },
  plugin_update_required: { label: "Update required", cls: "warn" },
  helper_disabled:        { label: "Helper off",      cls: "none" },
  unreachable:            { label: "Unreachable",     cls: "disabled" },
  unknown:                { label: "Not checked",     cls: "none" },
};

/* ------------------------------------------------------------------ helpers */

// Every response from /api/wpusers is { ok, ... }. Errors carry a message
// written for an administrator, so they can be shown as-is.
async function wpuApi(path, options = {}) {
  const res = await fetch("/api/wpusers" + path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) { location.href = "/login"; throw new Error("Signed out"); }
  let json;
  try { json = await res.json(); } catch (e) { throw new Error(`Server error (HTTP ${res.status})`); }
  if (!json.ok) {
    const err = new Error(json.error || `Request failed (HTTP ${res.status})`);
    err.code = json.code;
    throw err;
  }
  return json;
}

function wpuRoleChip(role, inherited) {
  const def = WPU.roles.find((r) => r.slug === role);
  const cls = "wpu-chip role" + (def && def.adminLike ? " admin-like" : "") + (inherited ? " inherited" : "");
  return `<span class="${cls}" title="${inherited ? "Inherited from the team" : "Set on this person"}">${esc(role)}</span>`;
}

/**
 * Every role we could store as a default: the core five plus everything
 * discovered on a connected website.
 *
 * Administering roles ARE offered — see the policy note in roles.js. What still
 * protects a client is the per-site users:admin scope and the confirmation
 * before a job runs, neither of which lives in this dropdown.
 *
 * The display name is shown and the slug is stored, and a role only some sites
 * have says so, rather than presenting a plugin-specific role as universal.
 */
function wpuRoleOptions(selected, { includeInherit = false, inheritLabel = "" } = {}) {
  const total = WPU.roleSiteTotal || 0;
  const opts = WPU.roles.map((r) => {
    const partial = !r.core && r.siteCount > 0 && total > 0 && r.siteCount < total;
    const note = r.siteAdmin ? " — administers the site"
      : partial ? ` — on ${r.siteCount} of ${total} websites` : "";
    return `<option value="${esc(r.slug)}"${r.slug === selected ? " selected" : ""}>${esc(r.name)}${esc(note)}</option>`;
  });
  if (includeInherit) {
    opts.unshift(`<option value=""${!selected ? " selected" : ""}>${esc(inheritLabel || "Use the team default")}</option>`);
  }
  return opts.join("");
}

function wpuTeamOptions(selected, { noneLabel = "No team" } = {}) {
  return [`<option value=""${!selected ? " selected" : ""}>${esc(noneLabel)}</option>`]
    .concat(WPU.teams.map((t) => `<option value="${esc(t.id)}"${t.id === selected ? " selected" : ""}>${esc(t.name)}</option>`))
    .join("");
}

function wpuWhen(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/* -------------------------------------------------------------------- modal */

function wpuModalEl() {
  let el = document.getElementById("wpuModal");
  if (!el) {
    el = document.createElement("div");
    el.className = "modal";
    el.id = "wpuModal";
    el.addEventListener("click", (e) => { if (e.target === el) wpuCloseModal(); });
    document.body.appendChild(el);
  }
  return el;
}

function wpuOpenModal({ eyebrow, title, body, actions }) {
  const el = wpuModalEl();
  el.innerHTML = `
    <div class="modal-panel">
      <div class="modal-head">
        <div><div class="modal-eyebrow">${esc(eyebrow || "User management")}</div><h2>${esc(title)}</h2></div>
        <button class="modal-x" onclick="wpuCloseModal()">&times;</button>
      </div>
      <div class="modal-form">${body}</div>
      <div class="modal-actions"><span class="wpu-msg err" id="wpuModalMsg" style="margin-right:auto"></span>${actions}</div>
    </div>`;
  el.classList.add("show");
  document.body.style.overflow = "hidden";
  const first = el.querySelector("input, select, textarea");
  if (first) first.focus();
}

function wpuCloseModal() {
  const el = document.getElementById("wpuModal");
  if (el) el.classList.remove("show");
  document.body.style.overflow = "";
}

function wpuModalError(message) {
  const el = document.getElementById("wpuModalMsg");
  if (el) el.textContent = message || "";
}

// Escape closes whichever of this feature's modals is open.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const el = document.getElementById("wpuModal");
    if (el && el.classList.contains("show")) wpuCloseModal();
  }
});

/* --------------------------------------------------------------------- view */

async function renderWpUsers() {
  const root = document.getElementById("wpusersRoot");
  if (!root) return;
  if (!WPU.loaded) {
    root.innerHTML = '<div class="wpu-empty">Loading…</div>';
    try {
      const [teams, users, roles] = await Promise.all([
        wpuApi("/teams"), wpuApi("/users"), wpuApi("/roles"),
      ]);
      WPU.teams = teams.teams;
      WPU.users = users.users;
      WPU.roles = roles.roles;
      WPU.roleSiteTotal = roles.siteTotal || 0;
      WPU.loaded = true;
      // Website names are needed by the Users and Activity filters. Loaded
      // without re-probing every site, and a failure here must not stop the
      // rest of the screen working.
      try {
        const sites = await wpuApi("/websites");
        WPU.websites = sites.websites || [];
      } catch (e) { WPU.websites = []; }
      try {
        const assigned = await wpuApi("/assignments");
        WPU.assignments = assigned.assignments || [];
      } catch (e) { WPU.assignments = []; }
    } catch (err) {
      root.innerHTML = `<div class="wpu-empty"><h4>Couldn’t load user management</h4>
        <div class="wpu-note">${esc(err.message)}</div>
        <div style="margin-top:14px"><button class="btn" onclick="WPU.loaded=false; renderWpUsers()">Try again</button></div></div>`;
      return;
    }
  }
  root.innerHTML = `
    <div class="wpu-tabs">
      ${WPU_TABS.map((t) => `<button class="wpu-tab${WPU.tab === t.id ? " on" : ""}" onclick="wpuSetTab('${t.id}')">${esc(t.label)}</button>`).join("")}
    </div>
    <div id="wpuPanel"></div>`;
  wpuRenderPanel();
}

function wpuSetTab(tab) {
  WPU.tab = tab;
  WPU.selected.clear();
  renderWpUsers();
}

function wpuRenderPanel() {
  if (WPU.tab === "teams") return wpuRenderTeams();
  if (WPU.tab === "users") return wpuRenderUsers();
  if (WPU.tab === "websites") return wpuRenderWebsites();
  if (WPU.tab === "sync") return wpuRenderSync();
  if (WPU.tab === "audit") return wpuRenderAudit();
}

async function wpuRefresh({ teams = false, users = false } = {}) {
  if (teams) WPU.teams = (await wpuApi("/teams")).teams;
  if (users) WPU.users = (await wpuApi("/users")).users;
  wpuRenderPanel();
}

/* -------------------------------------------------------------------- teams */

function wpuRenderTeams() {
  const panel = document.getElementById("wpuPanel");
  const rows = WPU.teams.map((t) => `
    <tr>
      <td data-label="Team"><span class="wpu-name">${esc(t.name)}</span><span class="wpu-sub">${esc(t.slug)}</span></td>
      <td data-label="Description">${t.description ? esc(t.description) : '<span class="wpu-chip none">—</span>'}</td>
      <td data-label="Default role">${wpuRoleChip(t.defaultWpRole)}</td>
      <td data-label="Members">${t.memberCount}</td>
      <td class="wpu-actions">
        ${t.memberCount ? `<button class="wpu-linkbtn" onclick="wpuStartAssign({ teamId: '${escJs(t.id)}', teamName: '${escJs(t.name)}' })">Add to websites…</button>` : ""}
        <button class="wpu-linkbtn" onclick="wpuEditTeam('${escJs(t.id)}')">Edit</button>
        <button class="wpu-linkbtn danger" onclick="wpuDeleteTeam('${escJs(t.id)}')">Delete</button>
      </td>
    </tr>`).join("");

  panel.innerHTML = `
    <div class="wpu-bar">
      <div class="grow wpu-note">Teams group internal staff. A team’s default role is what its members get on a website unless something overrides it — Administrator is never a default.</div>
      <button class="btn primary" onclick="wpuEditTeam()">${ICON.plus} New team</button>
    </div>
    <div class="wpu-card">
      ${WPU.teams.length ? `<table class="wpu-table">
        <thead><tr><th>Team</th><th>Description</th><th>Default role</th><th>Members</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table>`
      : '<div class="wpu-empty"><h4>No teams yet</h4><div class="wpu-note">Create a team to start grouping staff.</div></div>'}
    </div>`;
}

function wpuEditTeam(id) {
  const team = id ? WPU.teams.find((t) => t.id === id) : null;
  wpuOpenModal({
    eyebrow: "Teams",
    title: team ? `Edit ${team.name}` : "New team",
    body: `
      <div class="wpu-field">
        <label for="wpu-t-name">Name</label>
        <input id="wpu-t-name" type="text" maxlength="60" value="${esc(team ? team.name : "")}" placeholder="e.g. Content" />
      </div>
      <div class="wpu-field">
        <label for="wpu-t-desc">Description</label>
        <input id="wpu-t-desc" type="text" maxlength="200" value="${esc(team ? team.description : "")}" placeholder="Optional" />
      </div>
      <div class="wpu-field">
        <label for="wpu-t-role">Default WordPress role</label>
        <select id="wpu-t-role">${wpuRoleOptions(team ? team.defaultWpRole : "editor")}</select>
        <div class="hint">
          Applied to this team’s members on a website unless a per-person or per-website
          override says otherwise. Administrator is allowed here — a website still only
          accepts it if its own administrator has permitted it, and you’ll confirm once
          before anything is applied.
        </div>
      </div>`,
    actions: `<button class="btn-ghost" onclick="wpuCloseModal()">Cancel</button>
              <button class="btn-primary" onclick="wpuSaveTeam(${team ? `'${escJs(team.id)}'` : "null"})">${team ? "Save changes" : "Create team"}</button>`,
  });
}

async function wpuSaveTeam(id) {
  const body = {
    name: document.getElementById("wpu-t-name").value,
    description: document.getElementById("wpu-t-desc").value,
    defaultWpRole: document.getElementById("wpu-t-role").value,
  };
  try {
    await wpuApi(id ? `/teams/${id}` : "/teams", { method: id ? "PUT" : "POST", body });
    wpuCloseModal();
    await wpuRefresh({ teams: true, users: true });
  } catch (err) { wpuModalError(err.message); }
}

/**
 * Deleting a team never deletes anyone's WordPress account, and never silently
 * strands its members — the administrator has to say where they go.
 */
function wpuDeleteTeam(id) {
  const team = WPU.teams.find((t) => t.id === id);
  if (!team) return;
  const others = WPU.teams.filter((t) => t.id !== id);
  const hasMembers = team.memberCount > 0;

  wpuOpenModal({
    eyebrow: "Teams",
    title: `Delete ${team.name}?`,
    body: `
      <div class="wpu-danger">
        <strong>This can’t be undone.</strong> Deleting a team never deletes a WordPress
        account. At most it stops us managing those accounts — they keep their role,
        content and access either way.
      </div>
      ${hasMembers ? `
        <div class="wpu-field">
          <label>${team.memberCount} ${team.memberCount === 1 ? "person is" : "people are"} in this team. What happens to them?</label>
          <select id="wpu-t-disp" onchange="document.getElementById('wpu-t-move').style.display = this.value === 'move' ? 'block' : 'none'">
            <option value="unassign">Leave them with no team</option>
            ${others.length ? '<option value="move">Move them to another team</option>' : ""}
          </select>
        </div>
        <div class="wpu-field" id="wpu-t-move" style="display:none">
          <label for="wpu-t-moveto">Move them to</label>
          <select id="wpu-t-moveto">${others.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("")}</select>
        </div>
        <div class="wpu-field">
          <label>And their website accounts?</label>
          <select id="wpu-t-assign">
            <option value="keep">Keep managing them (nothing changes on any website)</option>
            <option value="remove">Stop managing them</option>
          </select>
          <div class="hint">
            “Stop managing” releases the accounts — they keep their role, their content
            and their access, we simply stop administering them. It does <strong>not</strong>
            delete anyone’s WordPress account. Deleting an account is a separate action
            with its own content checks.
          </div>
        </div>` : '<div class="wpu-note" style="margin-bottom:14px">This team has no members.</div>'}
      <div class="wpu-field">
        <label for="wpu-t-confirm">Type <strong>DELETE</strong> to confirm</label>
        <input id="wpu-t-confirm" type="text" autocomplete="off" placeholder="DELETE" />
      </div>`,
    actions: `<button class="btn-ghost" onclick="wpuCloseModal()">Cancel</button>
              <button class="btn-primary" style="background:var(--fail)" onclick="wpuConfirmDeleteTeam('${escJs(id)}')">Delete team</button>`,
  });
}

async function wpuConfirmDeleteTeam(id) {
  if (document.getElementById("wpu-t-confirm").value.trim().toUpperCase() !== "DELETE") {
    return wpuModalError("Type DELETE to confirm.");
  }
  const dispEl = document.getElementById("wpu-t-disp");
  const assignEl = document.getElementById("wpu-t-assign");
  const body = {};
  if (dispEl) {
    body.onUsers = dispEl.value;
    if (dispEl.value === "move") body.moveToTeamId = document.getElementById("wpu-t-moveto").value;
  }
  if (assignEl) body.onAssignments = assignEl.value;
  try {
    await wpuApi(`/teams/${id}`, { method: "DELETE", body });
    wpuCloseModal();
    await wpuRefresh({ teams: true, users: true });
  } catch (err) { wpuModalError(err.message); }
}

/* -------------------------------------------------------------------- users */

// Every person's website assignments, keyed for the filters and the row detail.
function wpuAssignmentsFor(staffUserId) {
  return (WPU.assignments || []).filter((a) => a.staffUserId === staffUserId);
}

function wpuFilteredUsers() {
  const f = WPU.filters;
  const q = f.q.trim().toLowerCase();
  return WPU.users.filter((u) => {
    if (f.team === "none" ? u.teamId : f.team && u.teamId !== f.team) return false;
    if (f.role && u.effectiveWpRole !== f.role) return false;
    if (f.status && u.status !== f.status) return false;
    if (q && !(u.email.toLowerCase().includes(q) || u.label.toLowerCase().includes(q))) return false;

    const mine = wpuAssignmentsFor(u.id);
    if (f.website && !mine.some((a) => a.websiteId === f.website)) return false;
    if (f.sync) {
      if (f.sync === "none") { if (mine.length) return false; }
      else if (!mine.some((a) => a.state === f.sync)) return false;
    }
    return true;
  });
}

function wpuClearFilters() {
  WPU.filters = { q: "", team: "", role: "", status: "", website: "", sync: "" };
  wpuRenderUsers();
}

function wpuRenderUsers() {
  const panel = document.getElementById("wpuPanel");
  const list = wpuFilteredUsers();
  const f = WPU.filters;

  const rows = list.map((u) => {
    const inherited = !u.defaultWpRole;
    return `
    <tr>
      <td style="width:34px"><input type="checkbox" ${WPU.selected.has(u.id) ? "checked" : ""} onchange="wpuToggleSelect('${escJs(u.id)}', this.checked)" aria-label="Select ${esc(u.label)}" /></td>
      <td data-label="Person"><span class="wpu-name">${esc(u.label)}</span><span class="wpu-sub">${esc(u.email)}</span></td>
      <td data-label="Team">${u.teamId ? `<span class="wpu-chip team">${esc(u.teamName)}</span>` : '<span class="wpu-chip none">No team</span>'}</td>
      <td data-label="Role">${wpuRoleChip(u.effectiveWpRole, inherited)}</td>
      <td data-label="Websites">${(() => {
        const mine = wpuAssignmentsFor(u.id);
        if (!mine.length) return '<span class="wpu-chip none">none</span>';
        const failed = mine.filter((a) => a.state === "failed").length;
        const ok = mine.filter((a) => ["synced", "updated", "linked"].includes(a.state)).length;
        return `<span class="wpu-chip ${ok ? "ok" : "none"}">${ok}/${mine.length} synced</span>` +
               (failed ? ` <span class="wpu-chip bad">${failed} failed</span>` : "");
      })()}</td>
      <td data-label="Status">
        ${u.status === "disabled" ? '<span class="wpu-chip disabled">Disabled</span>' : '<span class="wpu-chip">Active</span>'}
        ${u.domainOverride ? ' <span class="wpu-chip ext" title="Outside the agency domain">External</span>' : ""}
      </td>
      <td class="wpu-actions">
        <button class="wpu-linkbtn" onclick="wpuStartAssign({ staffIds: ['${escJs(u.id)}'] })">Websites…</button>
        <button class="wpu-linkbtn" onclick="wpuEditUser('${escJs(u.id)}')">Edit</button>
        <button class="wpu-linkbtn danger" onclick="wpuStartDelete('${escJs(u.id)}')">Delete from websites…</button>
        <button class="wpu-linkbtn" onclick="wpuDeleteUser('${escJs(u.id)}')">Take off roster</button>
      </td>
    </tr>`;
  }).join("");

  panel.innerHTML = `
    <div class="wpu-bar">
      <input class="grow" type="search" id="wpu-q" placeholder="Search by name or email…" value="${esc(f.q)}" oninput="wpuSetFilter('q', this.value)" autocomplete="off" />
      <select onchange="wpuSetFilter('team', this.value)">
        <option value=""${!f.team ? " selected" : ""}>All teams</option>
        <option value="none"${f.team === "none" ? " selected" : ""}>No team</option>
        ${WPU.teams.map((t) => `<option value="${esc(t.id)}"${f.team === t.id ? " selected" : ""}>${esc(t.name)}</option>`).join("")}
      </select>
      <select onchange="wpuSetFilter('role', this.value)">
        <option value=""${!f.role ? " selected" : ""}>All roles</option>
        ${WPU.roles.map((r) => `<option value="${esc(r.slug)}"${f.role === r.slug ? " selected" : ""}>${esc(r.name)}</option>`).join("")}
      </select>
      <select onchange="wpuSetFilter('status', this.value)">
        <option value=""${!f.status ? " selected" : ""}>Any status</option>
        <option value="active"${f.status === "active" ? " selected" : ""}>Active</option>
        <option value="disabled"${f.status === "disabled" ? " selected" : ""}>Disabled</option>
      </select>
      <select onchange="wpuSetFilter('website', this.value)">
        <option value=""${!f.website ? " selected" : ""}>All websites</option>
        ${(WPU.websites || []).map((w) => `<option value="${esc(w.websiteId)}"${f.website === w.websiteId ? " selected" : ""}>${esc(w.name)}</option>`).join("")}
      </select>
      <select onchange="wpuSetFilter('sync', this.value)">
        <option value=""${!f.sync ? " selected" : ""}>Any sync status</option>
        <option value="synced"${f.sync === "synced" ? " selected" : ""}>Synced</option>
        <option value="updated"${f.sync === "updated" ? " selected" : ""}>Updated</option>
        <option value="failed"${f.sync === "failed" ? " selected" : ""}>Failed</option>
        <option value="pending"${f.sync === "pending" ? " selected" : ""}>Pending</option>
        <option value="none"${f.sync === "none" ? " selected" : ""}>No websites yet</option>
      </select>
      ${Object.values(f).some(Boolean) ? '<button class="wpu-linkbtn" onclick="wpuClearFilters()">Clear</button>' : ""}
      <button class="btn" onclick="wpuAssignFromToolbar()">Add to websites…</button>
      <button class="btn primary" onclick="wpuEditUser()">${ICON.plus} Add person</button>
    </div>

    <div class="wpu-selbar${WPU.selected.size ? " show" : ""}">
      <span class="count">${WPU.selected.size} selected</span>
      <select id="wpu-bulk-team">${wpuTeamOptions("", { noneLabel: "No team" })}</select>
      <button class="btn" onclick="wpuBulkMove()">Move to team</button>
      <button class="btn primary" onclick="wpuStartAssign({ staffIds: [...WPU.selected] })">Add to websites…</button>
      <button class="wpu-linkbtn" onclick="wpuClearSelection()">Clear</button>
      <span class="wpu-msg" id="wpuBulkMsg"></span>
    </div>

    <div class="wpu-card">
      ${list.length ? `<table class="wpu-table">
        <thead><tr>
          <th style="width:34px"><input type="checkbox" onchange="wpuToggleSelectAll(this.checked)" aria-label="Select all" /></th>
          <th>Person</th><th>Team</th><th>Role</th><th>Websites</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>${rows}</tbody></table>`
      : `<div class="wpu-empty"><h4>${WPU.users.length ? "No one matches those filters" : "No staff on the roster yet"}</h4>
         <div class="wpu-note">${WPU.users.length ? "Try clearing the search or filters." : "Add the people who should have WordPress accounts on client sites."}</div></div>`}
    </div>
    <div class="wpu-note" style="margin-top:12px">Showing ${list.length} of ${WPU.users.length}. Roles shown in italics are inherited from the person’s team.</div>`;

  // Re-focus the search box after the re-render so typing isn't interrupted.
  const q = document.getElementById("wpu-q");
  if (q && f.q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
}

/**
 * "Add to websites…" without having ticked anything first.
 *
 * The bulk toolbar only appeared once rows were selected, so the main thing
 * this feature exists to do was invisible until you happened to tick a
 * checkbox. This button is always there and works on whatever is in front of
 * you: the selection if there is one, otherwise everyone the current filters
 * are showing — which is what someone who just filtered to a team means.
 */
function wpuAssignFromToolbar() {
  if (WPU.selected.size) {
    return wpuStartAssign({ staffIds: [...WPU.selected] });
  }
  const visible = wpuFilteredUsers().filter((u) => u.status === "active");
  if (!visible.length) {
    return wpuOpenModal({
      eyebrow: "Website assignment",
      title: "Nobody to add",
      body: '<div class="wpu-note">No active people match the current filters. Clear them, or add someone to the roster first.</div>',
      actions: '<button class="btn-primary" onclick="wpuCloseModal()">Close</button>',
    });
  }
  // Acting on a filtered set is easy to misread, so it is stated and confirmed
  // rather than assumed.
  const filtered = Object.values(WPU.filters).some(Boolean);
  wpuOpenModal({
    eyebrow: "Website assignment",
    title: `Add ${visible.length} ${visible.length === 1 ? "person" : "people"} to websites`,
    body: `
      <div class="wpu-note" style="margin-bottom:14px">
        ${filtered
          ? `Nothing is selected, so this uses everyone the current filters are showing —
             <strong>${visible.length} ${visible.length === 1 ? "person" : "people"}</strong>.`
          : `Nothing is selected, so this uses the whole active roster —
             <strong>${visible.length} ${visible.length === 1 ? "person" : "people"}</strong>.`}
        You'll pick the websites next, and review everything before anything is applied.
      </div>
      <div class="wpu-card" style="max-height:34vh;overflow:auto">
        <table class="wpu-table"><tbody>
          ${visible.slice(0, 40).map((u) => `<tr><td>${esc(u.label)}<span class="wpu-sub">${esc(u.email)}</span></td>
            <td>${u.teamName ? `<span class="wpu-chip team">${esc(u.teamName)}</span>` : '<span class="wpu-chip none">No team</span>'}</td></tr>`).join("")}
        </tbody></table>
        ${visible.length > 40 ? `<div class="wpu-note" style="padding:10px 12px">…and ${visible.length - 40} more</div>` : ""}
      </div>`,
    actions: `<button class="btn-ghost" onclick="wpuCloseModal()">Cancel</button>
              <button class="btn-primary" onclick="wpuStartAssign({ staffIds: ${JSON.stringify(visible.map((u) => u.id))} })">Choose websites</button>`,
  });
}

function wpuSetFilter(key, value) {
  WPU.filters[key] = value;
  wpuRenderUsers();
}

function wpuToggleSelect(id, on) {
  if (on) WPU.selected.add(id); else WPU.selected.delete(id);
  wpuRenderUsers();
}

function wpuToggleSelectAll(on) {
  if (on) wpuFilteredUsers().forEach((u) => WPU.selected.add(u.id));
  else WPU.selected.clear();
  wpuRenderUsers();
}

function wpuClearSelection() {
  WPU.selected.clear();
  wpuRenderUsers();
}

async function wpuBulkMove() {
  const teamId = document.getElementById("wpu-bulk-team").value || null;
  const msg = document.getElementById("wpuBulkMsg");
  try {
    const res = await wpuApi("/users/move-team", { method: "POST", body: { ids: [...WPU.selected], teamId } });
    WPU.users = res.users;
    WPU.selected.clear();
    await wpuRefresh({ teams: true });
  } catch (err) {
    msg.className = "wpu-msg err";
    msg.textContent = err.message;
  }
}

function wpuEditUser(id) {
  const user = id ? WPU.users.find((u) => u.id === id) : null;
  const teamName = user && user.teamName ? user.teamName : "their team";
  wpuOpenModal({
    eyebrow: "Staff",
    title: user ? `Edit ${user.label}` : "Add person",
    body: `
      <div class="wpu-field">
        <label for="wpu-u-email">Email address</label>
        <input id="wpu-u-email" type="email" value="${esc(user ? user.email : "")}" placeholder="name@digitalelementsgroup.com" />
        <div class="hint">This is what we match on when checking whether an account already exists on a website.</div>
      </div>
      <div class="wpu-row2">
        <div class="wpu-field"><label for="wpu-u-first">First name</label>
          <input id="wpu-u-first" type="text" value="${esc(user ? user.firstName : "")}" /></div>
        <div class="wpu-field"><label for="wpu-u-last">Last name</label>
          <input id="wpu-u-last" type="text" value="${esc(user ? user.lastName : "")}" /></div>
      </div>
      <div class="wpu-row2">
        <div class="wpu-field"><label for="wpu-u-team">Team</label>
          <select id="wpu-u-team">${wpuTeamOptions(user ? user.teamId : "")}</select></div>
        <div class="wpu-field"><label for="wpu-u-role">WordPress role</label>
          <select id="wpu-u-role">${wpuRoleOptions(user ? user.defaultWpRole : "", { includeInherit: true, inheritLabel: `Use ${teamName}’s default` })}</select></div>
      </div>
      <div class="wpu-field">
        <label for="wpu-u-status">Status</label>
        <select id="wpu-u-status">
          <option value="active"${!user || user.status === "active" ? " selected" : ""}>Active</option>
          <option value="disabled"${user && user.status === "disabled" ? " selected" : ""}>Disabled</option>
        </select>
        <div class="hint">Disabled keeps the person on the roster but excludes them from website assignments.</div>
      </div>
      <div id="wpu-u-override" style="display:none">
        <div class="wpu-warnbox">
          <strong>Outside the agency domain.</strong> Accounts are normally limited to
          <code>@digitalelementsgroup.com</code>. Confirm to add this address anyway — the
          exception is recorded in the activity log.
        </div>
        <label class="wpu-check"><input type="checkbox" id="wpu-u-override-chk" />
          <span>I confirm this external address should have accounts on client websites.</span></label>
      </div>`,
    actions: `<button class="btn-ghost" onclick="wpuCloseModal()">Cancel</button>
              <button class="btn-primary" onclick="wpuSaveUser(${user ? `'${escJs(user.id)}'` : "null"})">${user ? "Save changes" : "Add person"}</button>`,
  });
}

async function wpuSaveUser(id) {
  const overrideBox = document.getElementById("wpu-u-override-chk");
  const body = {
    email: document.getElementById("wpu-u-email").value,
    firstName: document.getElementById("wpu-u-first").value,
    lastName: document.getElementById("wpu-u-last").value,
    teamId: document.getElementById("wpu-u-team").value || null,
    defaultWpRole: document.getElementById("wpu-u-role").value || null,
    status: document.getElementById("wpu-u-status").value,
    overrideDomain: !!(overrideBox && overrideBox.checked),
  };
  try {
    await wpuApi(id ? `/users/${id}` : "/users", { method: id ? "PUT" : "POST", body });
    wpuCloseModal();
    await wpuRefresh({ teams: true, users: true });
  } catch (err) {
    // The server refuses non-agency addresses until the override is confirmed;
    // reveal the confirmation rather than just repeating the refusal.
    if (err.code === "domain_restricted") {
      document.getElementById("wpu-u-override").style.display = "block";
      wpuModalError(err.message);
      return;
    }
    wpuModalError(err.message);
  }
}

function wpuDeleteUser(id) {
  const user = WPU.users.find((u) => u.id === id);
  if (!user) return;
  wpuOpenModal({
    eyebrow: "Staff",
    title: `Take ${user.label} off the roster?`,
    body: `
      <div class="wpu-danger">
        <strong>This removes them from the roster only.</strong> Any WordPress account
        they already have on a client website is left exactly as it is. Deleting those
        accounts is a separate action, with its own content-ownership checks.
      </div>
      <div class="wpu-field">
        <label for="wpu-u-confirm">Type <strong>DELETE</strong> to confirm</label>
        <input id="wpu-u-confirm" type="text" autocomplete="off" placeholder="DELETE" />
      </div>`,
    actions: `<button class="btn-ghost" onclick="wpuCloseModal()">Cancel</button>
              <button class="btn-primary" style="background:var(--fail)" onclick="wpuConfirmDeleteUser('${escJs(id)}')">Take off roster</button>`,
  });
}

async function wpuConfirmDeleteUser(id) {
  if (document.getElementById("wpu-u-confirm").value.trim().toUpperCase() !== "DELETE") {
    return wpuModalError("Type DELETE to confirm.");
  }
  try {
    await wpuApi(`/users/${id}`, { method: "DELETE" });
    wpuCloseModal();
    await wpuRefresh({ teams: true, users: true });
  } catch (err) { wpuModalError(err.message); }
}

/* ----------------------------------------------------------------- websites */

/**
 * Which connected sites can be used for user management, and what to do about
 * the ones that can't.
 *
 * Every site is probed before it can be selected anywhere, so "needs a plugin
 * update" or "isn't connected" is visible here rather than appearing as a
 * failure halfway through a bulk operation.
 */
async function wpuRenderWebsites(force) {
  const panel = document.getElementById("wpuPanel");
  panel.innerHTML = `<div class="wpu-card"><div class="wpu-empty">${force ? "Re-checking every site…" : "Checking sites…"}</div></div>`;

  let data;
  try {
    data = await wpuApi("/websites" + (force ? "?refresh=1" : ""));
  } catch (err) {
    panel.innerHTML = `<div class="wpu-card"><div class="wpu-empty"><h4>Couldn’t check the websites</h4><div class="wpu-note">${esc(err.message)}</div></div></div>`;
    return;
  }

  if (!data.configured) {
    panel.innerHTML = `<div class="wpu-card"><div class="wpu-empty">
      <h4>User management isn’t configured on this server</h4>
      <div class="wpu-note">Set <code>USER_MGMT_ENC_KEY</code> in the environment and restart.
      Teams and staff work without it; connecting websites doesn’t.
      See <code>docs/user-management.md</code>.</div></div></div>`;
    return;
  }

  WPU.websites = data.websites;
  const counts = data.websites.reduce((acc, w) => { acc[w.readiness] = (acc[w.readiness] || 0) + 1; return acc; }, {});

  const rows = data.websites.map((w) => {
    const state = WPU_READINESS[w.readiness] || WPU_READINESS.unknown;
    return `
    <tr>
      <td data-label="Website"><span class="wpu-name">${esc(w.name)}</span><span class="wpu-sub">${esc(w.url)}</span></td>
      <td data-label="Status">
        <span class="wpu-chip ${esc(state.cls)}" title="${esc(w.message || "")}">${esc(state.label)}</span>
        ${w.multisite ? ' <span class="wpu-chip ext" title="Multisite isn’t supported yet">Multisite</span>' : ""}
        ${w.licenseMismatch ? ` <span class="wpu-chip bad" title="This site uses ${esc(w.licenseSite)}'s license key">Wrong license</span>` : ""}
      </td>
      <td data-label="Plugin">${w.pluginVersion ? `<span class="wpu-chip role">${esc(w.pluginVersion)}</span>` : '<span class="wpu-chip none">—</span>'}</td>
      <td data-label="Site allows">${w.enrolled && w.scopes.length
        ? w.scopes.map((sc) => `<span class="wpu-chip role">${esc(sc)}</span>`).join(" ")
        : '<span class="wpu-chip none">—</span>'}</td>
      <td data-label="We allow">${w.enrolled
        ? `<label class="wpu-check" style="gap:6px">
             <input type="checkbox" ${(w.hubScopes || []).includes("plugin:assign") ? "checked" : ""}
                    onchange="wpuSetPluginAssign('${escJs(w.websiteId)}', this.checked)" />
             <span>Plugin can add staff</span>
           </label>`
        : '<span class="wpu-chip none">—</span>'}</td>
      <td data-label="Checked" class="wpu-audit-when">${esc(w.checkedAt ? wpuWhen(w.checkedAt) : "—")}</td>
      <td class="wpu-actions">
        ${w.enrolled
          ? `<button class="wpu-linkbtn" onclick="wpuRotateCredential('${escJs(w.websiteId)}')">Rotate</button>
             <button class="wpu-linkbtn danger" onclick="wpuRevokeCredential('${escJs(w.websiteId)}')">Disconnect</button>`
          : `<button class="wpu-linkbtn" onclick="wpuIssueCode('${escJs(w.websiteId)}')">Connect…</button>`}
      </td>
    </tr>`;
  }).join("");

  panel.innerHTML = `
    <div class="wpu-bar">
      <div class="grow wpu-note">
        A website has to be connected before anyone can be added to it. Connecting takes one
        code, pasted into that site’s <strong>DE Monitoring</strong> panel by someone with
        access to its admin — user management can’t be switched on remotely.
      </div>
      <button class="btn" onclick="wpuRenderWebsites(true)">Re-check all</button>
    </div>
    ${Object.keys(counts).length ? `<div class="wpu-bar">${Object.entries(counts).map(([k, n]) => {
      const st = WPU_READINESS[k] || WPU_READINESS.unknown;
      return `<span class="wpu-chip ${esc(st.cls)}">${n} ${esc(st.label.toLowerCase())}</span>`;
    }).join("")}</div>` : ""}
    <div class="wpu-card">
      ${data.websites.length ? `<table class="wpu-table">
        <thead><tr><th>Website</th><th>Status</th><th>Plugin</th><th>Site allows</th><th>We allow</th><th>Checked</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table>`
      : '<div class="wpu-empty"><h4>No websites yet</h4><div class="wpu-note">Add websites from the Websites section first.</div></div>'}
    </div>
    <div class="wpu-note" style="margin-top:12px">
      <strong>Site allows</strong> is what each website’s own administrator has permitted —
      deleting users and granting Administrator stay off unless they turn them on, and this
      dashboard can’t flip that switch.
      <strong>We allow</strong> is ours: whether staff working in that site’s WP Admin can add
      colleagues to it from the plugin. Turning it off here stays off.
    </div>`;
}

/**
 * Connect, with the commonest failure caught first.
 *
 * A plugin carrying another website's license key is the single most frequent
 * reason a code is refused — usually because the install was cloned from a
 * staging copy — and the refusal the dashboard can safely return says nothing
 * about why. The site reports which website its key belongs to, so this is
 * knowable BEFORE a code is issued and someone walks to the other site to paste
 * it in.
 */
async function wpuIssueCode(websiteId, options) {
  const rotate = !!(options && options.rotate);
  const site = (WPU.websites || []).find((w) => w.websiteId === websiteId);

  if (!rotate && site && site.licenseMismatch && !(options && options.ignoreMismatch)) {
    return wpuOpenModal({
      eyebrow: "Websites",
      title: `${site.name} looks linked to another website`,
      body: `
        <div class="wpu-warnbox">
          <strong>This site's plugin is linked to “${esc(site.licenseSite)}”, not “${esc(site.name)}”.</strong>
          A code issued for ${esc(site.name)} will be refused, because the site will
          present ${esc(site.licenseSite)}'s license key when it tries to redeem it.
        </div>
        <div class="wpu-note">
          Usually this means the install was cloned from another site and kept its
          license key. Fix it in that site's WP Admin → DE Monitoring by pasting
          ${esc(site.name)}'s own key, then come back and press Re-check all.
        </div>`,
      actions: `<button class="btn-ghost" onclick="wpuCloseModal()">Cancel</button>
                <button class="btn" onclick="wpuIssueCode('${escJs(websiteId)}', { ignoreMismatch: true })">Generate a code anyway</button>`,
    });
  }
  try {
    const res = await wpuApi(`/websites/${websiteId}/${rotate ? "rotate-credential" : "enrollment-code"}`, { method: "POST" });
    wpuShowCode(res, rotate);
  } catch (err) {
    wpuOpenModal({
      eyebrow: "Websites",
      title: site ? `Connect ${site.name}` : "Connect website",
      body: `<div class="wpu-danger">${esc(err.message)}</div>`,
      actions: '<button class="btn-ghost" onclick="wpuCloseModal()">Close</button>',
    });
  }
}

function wpuShowCode(res, rotated) {
  const mins = Math.round((res.expiresInSeconds || 900) / 60);
  wpuOpenModal({
    eyebrow: "Websites",
    title: `${rotated ? "New code for" : "Connect"} ${res.site.name}`,
    body: `
      ${rotated ? `<div class="wpu-warnbox">
        <strong>The old credential is now revoked.</strong> User management won’t work on this
        site until someone re-connects it with the code below.
      </div>` : ""}
      <div class="wpu-codebox">
        <span class="wpu-code">${esc(res.code)}</span>
        <button class="wpu-linkbtn" onclick="wpuCopyCode('${escJs(res.code)}', this)">Copy</button>
      </div>
      <div class="wpu-note" style="margin-bottom:16px">
        Valid for ${mins} minutes, and works once. It is shown only now — generate a new one
        if it gets lost.
      </div>
      <div class="wpu-field">
        <label>What to do with it</label>
        <div class="wpu-note">
          1. Open <strong>${esc(res.site.url)}</strong> → WP Admin → <strong>DE Monitoring</strong>.<br />
          2. Under <strong>User management</strong>, paste the code and press Connect.<br />
          3. Come back here and press <strong>Re-check all</strong>.
        </div>
      </div>
      <div class="wpu-note">
        The code alone grants nothing — the site also has to present its own monitoring
        license key to redeem it.
      </div>`,
    actions: '<button class="btn-primary" onclick="wpuCloseModal(); wpuRenderWebsites(true)">Done</button>',
  });
}

/**
 * Turns plugin-initiated assignment on or off for one website.
 *
 * This is the dashboard's own grant, not the site's. A site's plugin can never
 * change it, and no capability probe can put it back once it is off — which is
 * the whole reason the two kinds of permission are stored separately.
 */
async function wpuSetPluginAssign(websiteId, enabled) {
  try {
    await wpuApi(`/websites/${websiteId}/hub-scopes`, {
      method: "PUT", body: { pluginAssign: !!enabled },
    });
    wpuRenderWebsites(false);
  } catch (err) {
    wpuOpenModal({
      eyebrow: "Websites",
      title: "Couldn't change that permission",
      body: `<div class="wpu-danger">${esc(err.message)}</div>`,
      actions: '<button class="btn-primary" onclick="wpuCloseModal(); wpuRenderWebsites(false)">Close</button>',
    });
  }
}

function wpuCopyCode(code, btn) {
  const done = (text) => { btn.textContent = text; setTimeout(() => { btn.textContent = "Copy"; }, 1500); };
  if (!navigator.clipboard) return done("Press Ctrl+C");
  navigator.clipboard.writeText(code).then(() => done("Copied"), () => done("Press Ctrl+C"));
}

function wpuRotateCredential(websiteId) {
  const site = (WPU.websites || []).find((w) => w.websiteId === websiteId);
  wpuOpenModal({
    eyebrow: "Websites",
    title: `Rotate the credential for ${site ? site.name : "this website"}?`,
    body: `
      <div class="wpu-warnbox">
        <strong>This immediately revokes the current credential.</strong> User management stops
        working for this site until someone pastes the new code into its DE Monitoring panel.
        Monitoring and the license key are unaffected, and no WordPress account is changed.
      </div>
      <div class="wpu-note">Rotate if the credential may have been exposed, or as routine hygiene.</div>`,
    actions: `<button class="btn-ghost" onclick="wpuCloseModal()">Cancel</button>
              <button class="btn-primary" onclick="wpuCloseModal(); wpuIssueCode('${escJs(websiteId)}', { rotate: true })">Rotate and show new code</button>`,
  });
}

function wpuRevokeCredential(websiteId) {
  const site = (WPU.websites || []).find((w) => w.websiteId === websiteId);
  wpuOpenModal({
    eyebrow: "Websites",
    title: `Disconnect ${site ? site.name : "this website"}?`,
    body: `
      <div class="wpu-danger">
        <strong>User management will stop working for this site.</strong> Monitoring, the
        license key, and every WordPress account on the site are left exactly as they are.
        You can reconnect at any time with a new code.
      </div>
      <div class="wpu-field">
        <label for="wpu-w-confirm">Type <strong>DISCONNECT</strong> to confirm</label>
        <input id="wpu-w-confirm" type="text" autocomplete="off" placeholder="DISCONNECT" />
      </div>`,
    actions: `<button class="btn-ghost" onclick="wpuCloseModal()">Cancel</button>
              <button class="btn-primary" style="background:var(--fail)" onclick="wpuConfirmRevoke('${escJs(websiteId)}')">Disconnect</button>`,
  });
}

async function wpuConfirmRevoke(websiteId) {
  if (document.getElementById("wpu-w-confirm").value.trim().toUpperCase() !== "DISCONNECT") {
    return wpuModalError("Type DISCONNECT to confirm.");
  }
  try {
    await wpuApi(`/websites/${websiteId}/revoke-credential`, { method: "POST" });
    wpuCloseModal();
    wpuRenderWebsites(true);
  } catch (err) { wpuModalError(err.message); }
}

/* ------------------------------------------------------- assign & review -- */

/**
 * Choosing websites, then reviewing exactly what would happen.
 *
 * Nothing in this flow writes anything. It ends at a review table and a button
 * that is deliberately inert — applying the plan is a separate, explicit action
 * that arrives with the write phase. The point of the flow is that every
 * problem an administrator could hit is visible BEFORE they commit: a site on
 * an old plugin, a role that site doesn't have, and above all an account that
 * already belongs to the client and must not be silently adopted.
 */
const WPU_ASSIGN = {
  staffIds: [],
  teamId: null,
  teamName: null,
  sites: [],            // readiness, from /websites
  selected: new Set(),
  search: "",
  roleOverrides: {},    // websiteId -> role slug
  siteRoles: {},        // websiteId -> { roles, defaultRole, stale, error }
  preflight: null,
};

function wpuStartAssign({ staffIds = [], teamId = null, teamName = null } = {}) {
  WPU_ASSIGN.staffIds = staffIds;
  WPU_ASSIGN.teamId = teamId;
  WPU_ASSIGN.teamName = teamName;
  WPU_ASSIGN.selected = new Set();
  WPU_ASSIGN.search = "";
  WPU_ASSIGN.roleOverrides = {};
  WPU_ASSIGN.siteRoles = {};
  WPU_ASSIGN.preflight = null;
  wpuOpenSitePicker();
}

function wpuAssignSubject() {
  if (WPU_ASSIGN.teamId) return `the ${WPU_ASSIGN.teamName} team`;
  const n = WPU_ASSIGN.staffIds.length;
  if (n === 1) {
    const u = WPU.users.find((x) => x.id === WPU_ASSIGN.staffIds[0]);
    return u ? u.label : "1 person";
  }
  return `${n} people`;
}

/* ------------------------------------------------------- website picker --- */

async function wpuOpenSitePicker() {
  wpuOpenModal({
    eyebrow: "Website assignment",
    title: `Add ${wpuAssignSubject()} to websites`,
    body: '<div class="wpu-empty">Checking websites…</div>',
    actions: '<button class="btn-ghost" onclick="wpuCloseModal()">Cancel</button>',
  });

  try {
    const data = await wpuApi("/websites");
    if (!data.configured) {
      return wpuRenderPickerError("User management isn’t configured on this server yet. Set USER_MGMT_ENC_KEY and restart.");
    }
    WPU_ASSIGN.sites = data.websites;
    wpuRenderSitePicker();
  } catch (err) {
    wpuRenderPickerError(err.message);
  }
}

function wpuRenderPickerError(message) {
  const panel = document.querySelector("#wpuModal .modal-form");
  if (panel) panel.innerHTML = `<div class="wpu-danger">${esc(message)}</div>`;
}

function wpuVisibleSites() {
  const q = WPU_ASSIGN.search.trim().toLowerCase();
  if (!q) return WPU_ASSIGN.sites;
  return WPU_ASSIGN.sites.filter(
    (s) => s.name.toLowerCase().includes(q) || s.url.toLowerCase().includes(q)
  );
}

// Eligible means the site can actually take an assignment right now. Anything
// else is shown — never hidden — with the reason, because "where did that site
// go?" is a worse experience than "that site needs a plugin update".
const wpuEligible = (s) => s.readiness === "ready";

function wpuRenderSitePicker() {
  const panel = document.querySelector("#wpuModal .modal-form");
  const actions = document.querySelector("#wpuModal .modal-actions");
  if (!panel) return;

  const visible = wpuVisibleSites();
  const eligible = visible.filter(wpuEligible);
  const chosen = WPU_ASSIGN.selected.size;

  const rows = visible.map((s) => {
    const ok = wpuEligible(s);
    const state = WPU_READINESS[s.readiness] || WPU_READINESS.unknown;
    const needs = s.requiredApiVersion;
    const reason = s.readiness === "plugin_update_required"
      ? `Plugin update required (has ${s.pluginVersion || "an older version"}, needs contract v${needs})`
      : s.message;

    return `
      <label class="wpu-site ${ok ? "" : "off"}" title="${esc(ok ? s.url : reason)}">
        <input type="checkbox" ${ok ? "" : "disabled"} ${WPU_ASSIGN.selected.has(s.websiteId) ? "checked" : ""}
               onchange="wpuToggleSite('${escJs(s.websiteId)}', this.checked)" />
        <span class="wpu-site-main">
          <span class="wpu-site-name">${esc(s.name)}</span>
          <span class="wpu-sub">${esc(s.url)}</span>
          ${ok ? "" : `<span class="wpu-site-reason">${esc(reason)}</span>`}
        </span>
        <span class="wpu-chip ${esc(state.cls)}">${esc(state.label)}</span>
      </label>`;
  }).join("");

  panel.innerHTML = `
    <div class="wpu-note" style="margin-bottom:12px">
      Adding <strong>${esc(wpuAssignSubject())}</strong>. Websites that can’t take an
      assignment yet are shown with the reason rather than hidden.
    </div>
    <div class="wpu-bar">
      <input class="grow" type="search" id="wpu-site-q" placeholder="Search websites…"
             value="${esc(WPU_ASSIGN.search)}" oninput="wpuSiteSearch(this.value)" autocomplete="off" />
      <button class="btn" onclick="wpuSelectAllEligible()">Select all eligible (${eligible.length})</button>
      <button class="btn" onclick="wpuClearSites()">Clear</button>
    </div>
    <div class="wpu-sitelist">
      ${visible.length ? rows : '<div class="wpu-empty"><h4>No websites match that search</h4></div>'}
    </div>`;

  if (actions) {
    actions.innerHTML = `
      <span class="wpu-msg" id="wpuModalMsg" style="margin-right:auto">${chosen} selected</span>
      <button class="btn-ghost" onclick="wpuCloseModal()">Cancel</button>
      <button class="btn-primary" ${chosen ? "" : "disabled"} onclick="wpuReview()">Review ${chosen ? chosen + " website" + (chosen === 1 ? "" : "s") : ""}</button>`;
  }

  const q = document.getElementById("wpu-site-q");
  if (q && WPU_ASSIGN.search) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
}

function wpuSiteSearch(v) { WPU_ASSIGN.search = v; wpuRenderSitePicker(); }
function wpuToggleSite(id, on) {
  if (on) WPU_ASSIGN.selected.add(id); else WPU_ASSIGN.selected.delete(id);
  wpuRenderSitePicker();
}
function wpuSelectAllEligible() {
  wpuVisibleSites().filter(wpuEligible).forEach((s) => WPU_ASSIGN.selected.add(s.websiteId));
  wpuRenderSitePicker();
}
function wpuClearSites() { WPU_ASSIGN.selected.clear(); wpuRenderSitePicker(); }

/* --------------------------------------------------------- review screen -- */

async function wpuReview() {
  const ids = [...WPU_ASSIGN.selected];
  if (!ids.length) return;

  wpuOpenModal({
    eyebrow: "Website assignment",
    title: "Review",
    body: '<div class="wpu-empty">Checking each website — reading its roles and looking for existing accounts…</div>',
    actions: '<button class="btn-ghost" onclick="wpuOpenSitePicker()">Back</button>',
  });

  try {
    // Each site's real roles, so the per-site override picker offers what that
    // site actually has rather than a guess.
    await Promise.all(ids.map(async (id) => {
      try { WPU_ASSIGN.siteRoles[id] = await wpuApi(`/websites/${id}/roles`); }
      catch (err) { WPU_ASSIGN.siteRoles[id] = { roles: [], stale: true, error: err.message }; }
    }));

    WPU_ASSIGN.preflight = await wpuApi("/preflight", {
      method: "POST",
      body: {
        staffUserIds: WPU_ASSIGN.teamId ? [] : WPU_ASSIGN.staffIds,
        teamId: WPU_ASSIGN.teamId,
        websiteIds: ids,
        roleOverrides: WPU_ASSIGN.roleOverrides,
      },
    });
    wpuRenderReview();
  } catch (err) {
    const panel = document.querySelector("#wpuModal .modal-form");
    if (panel) panel.innerHTML = `<div class="wpu-danger">${esc(err.message)}</div>`;
  }
}

const WPU_ACTION = {
  create:        { label: "Will create",            cls: "ok" },
  update:        { label: "Will update role",       cls: "ok" },
  link_required: { label: "Already exists — link?", cls: "warn" },
  skip:          { label: "Nothing to do",          cls: "none" },
  blocked:       { label: "Blocked",                cls: "bad" },
};

function wpuRenderReview() {
  const panel = document.querySelector("#wpuModal .modal-form");
  const actions = document.querySelector("#wpuModal .modal-actions");
  const pf = WPU_ASSIGN.preflight;
  if (!panel || !pf) return;

  const s = pf.summary;
  const chips = [
    s.create ? `<span class="wpu-chip ok">${s.create} to create</span>` : "",
    s.update ? `<span class="wpu-chip ok">${s.update} role change${s.update === 1 ? "" : "s"}</span>` : "",
    s.link_required ? `<span class="wpu-chip warn">${s.link_required} needing a link</span>` : "",
    s.skip ? `<span class="wpu-chip none">${s.skip} already correct</span>` : "",
    s.blocked ? `<span class="wpu-chip bad">${s.blocked} blocked</span>` : "",
  ].filter(Boolean).join("");

  // One override picker per site, not per row: the same site uses one role for
  // everyone in this batch, which is what "a different role per website" means.
  const siteIds = pf.sites.map((x) => x.id);
  const rolePickers = siteIds.map((id) => {
    const site = pf.sites.find((x) => x.id === id);
    const info = WPU_ASSIGN.siteRoles[id] || { roles: [] };
    const current = WPU_ASSIGN.roleOverrides[id] || "";
    const missing = pf.rows.some((r) => r.websiteId === id && r.blockers.some((b) => b.code === "role_not_available"));
    const unknown = pf.rows.some((r) => r.websiteId === id && r.blockers.some((b) => b.code === "roles_unknown"));

    if (!info.roles.length) {
      return `<div class="wpu-roleset">
        <div class="wpu-roleset-site">${esc(site ? site.name : id)}</div>
        <div class="wpu-note">${esc(unknown ? "Couldn’t read this site’s roles." : info.error || "No roles known for this site yet.")}</div>
      </div>`;
    }

    const opts = info.roles.map((r) =>
      `<option value="${esc(r.slug)}"${r.slug === current ? " selected" : ""}>${esc(r.name)}${r.siteAdmin ? " — administers the site" : ""}</option>`
    ).join("");

    return `<div class="wpu-roleset${missing ? " bad" : ""}">
      <div class="wpu-roleset-site">${esc(site ? site.name : id)}</div>
      <select onchange="wpuSetRoleOverride('${escJs(id)}', this.value)">
        <option value=""${current ? "" : " selected"}>Use each person’s own role</option>
        ${opts}
      </select>
      ${missing ? '<div class="wpu-roleset-warn">The requested role doesn’t exist here — pick one of this site’s roles.</div>' : ""}
      ${info.stale ? '<div class="wpu-note">Showing the last roles we read from this site.</div>' : ""}
    </div>`;
  }).join("");

  const rows = pf.rows.map((r) => {
    const a = WPU_ACTION[r.action] || WPU_ACTION.blocked;
    const blockers = r.blockers.map((b) => `<div class="wpu-blocker">${esc(b.message)}</div>`).join("");
    return `
      <tr class="${r.action === "blocked" ? "wpu-row-blocked" : ""}">
        <td data-label="Person"><span class="wpu-name">${esc(r.staffLabel)}</span><span class="wpu-sub">${esc(r.staffEmail)}</span></td>
        <td data-label="Website">${esc(r.websiteName)}</td>
        <td data-label="Role">
          <span class="wpu-chip role${r.needsAdminConfirmation ? " admin-like" : ""}">${esc(r.requestedRole)}</span>
          ${r.roleSource === "override" ? '<span class="wpu-chip none">per-site</span>' : ""}
        </td>
        <td data-label="Currently">${r.exists
          ? `<span class="wpu-chip ${r.managed ? "" : "warn"}">${esc((r.currentRoles || []).join(", ") || "no role")}</span>${r.managed ? "" : ' <span class="wpu-chip warn">not ours</span>'}`
          : '<span class="wpu-chip none">no account</span>'}</td>
        <td data-label="Outcome">
          <span class="wpu-chip ${esc(a.cls)}">${esc(a.label)}</span>
          ${r.note && r.action !== "blocked" ? `<div class="wpu-note">${esc(r.note)}</div>` : ""}
          ${blockers}
        </td>
      </tr>`;
  }).join("");

  panel.innerHTML = `
    <div class="wpu-bar">${chips}</div>

    ${s.link_required ? `<div class="wpu-warnbox">
      <strong>${s.link_required} account${s.link_required === 1 ? "" : "s"} already exist and aren’t managed by us.</strong>
      Those belong to the client until someone deliberately links them. Nothing is
      changed on them, and they’re never adopted automatically.
    </div>` : ""}

    ${s.adminSiteCount ? `<div class="wpu-danger">
      <strong>This grants Administrator on ${s.adminSiteCount} website${s.adminSiteCount === 1 ? "" : "s"}.</strong>
      You’ll confirm that once, before anything is applied.
    </div>` : ""}

    ${s.adminBlockedSiteCount ? `<div class="wpu-warnbox">
      <strong>${s.adminBlockedSiteCount} website${s.adminBlockedSiteCount === 1 ? "" : "s"} haven’t allowed Administrator to be granted from here.</strong>
      That switch lives in each site’s own DE Monitoring panel — this dashboard can’t turn it on.
    </div>` : ""}

    ${s.contentRisk ? `<div class="wpu-note" style="margin-bottom:14px">
      ${s.contentRisk} assignment${s.contentRisk === 1 ? "" : "s"} use a role that can post unfiltered HTML
      (WordPress gives Editor this by default). Worth knowing, not a blocker.
    </div>` : ""}

    <div class="wpu-roles-head">Role per website</div>
    <div class="wpu-rolesets">${rolePickers}</div>

    <div class="wpu-card" style="margin-top:6px">
      <table class="wpu-table">
        <thead><tr><th>Person</th><th>Website</th><th>Role</th><th>Currently</th><th>Outcome</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    <div class="wpu-note" style="margin-top:12px">
      Checked ${s.people} ${s.people === 1 ? "person" : "people"} across ${s.sites}
      website${s.sites === 1 ? "" : "s"}. Nothing has been changed yet — you’ll confirm first.
    </div>`;

  if (actions) {
    actions.innerHTML = `
      <span class="wpu-msg" id="wpuModalMsg" style="margin-right:auto"></span>
      <button class="btn-ghost" onclick="wpuOpenSitePicker()">Back</button>
      <button class="btn-primary" ${s.actionable ? "" : "disabled"} onclick="wpuConfirmApply()">
        Apply ${s.actionable} change${s.actionable === 1 ? "" : "s"}
      </button>`;
  }
}

// Changing a per-site role re-runs the preflight, because the prediction for
// every row on that site depends on it.
function wpuSetRoleOverride(websiteId, role) {
  if (role) WPU_ASSIGN.roleOverrides[websiteId] = role;
  else delete WPU_ASSIGN.roleOverrides[websiteId];
  wpuReview();
}

/* ------------------------------------------------------ confirm & apply -- */

/**
 * The confirmation step between the review table and actually changing client
 * sites.
 *
 * Each checkbox is a separate, explicit acknowledgement — no single "I agree"
 * covering several unrelated risks — and none of them is pre-ticked. The server
 * and the plugin enforce the same rules independently; these exist so an
 * administrator sees what they are agreeing to, not as the mechanism.
 */
function wpuConfirmApply() {
  const pf = WPU_ASSIGN.preflight;
  if (!pf) return;
  const s = pf.summary;

  // ONE confirmation for the whole job, not one per person. The thing worth
  // weighing is "which websites does this hand over", so the sites are named
  // once and the assignment count is a footnote.
  const needsAdmin = s.adminSiteCount > 0;
  const adminRows = pf.rows.filter((r) => r.needsAdminConfirmation && r.action !== "blocked");
  const adminSiteNames = [...new Set(adminRows.map((r) => r.websiteName))];
  const demotions = pf.rows.filter(
    (r) => r.action === "update" && (r.currentRoles || []).includes("administrator")
  );
  const external = pf.rows.filter((r) => !r.staffEmail.endsWith("@digitalelementsgroup.com"));
  const externalPeople = [...new Set(external.map((r) => r.staffEmail))];
  const siteCount = s.sites;

  wpuOpenModal({
    eyebrow: "Website assignment",
    title: `Apply ${s.actionable} change${s.actionable === 1 ? "" : "s"}?`,
    body: `
      <div class="wpu-note" style="margin-bottom:16px">
        This will create or update accounts on <strong>${siteCount}</strong>
        website${siteCount === 1 ? "" : "s"}. ${s.blocked ? `${s.blocked} blocked
        row${s.blocked === 1 ? "" : "s"} and ` : ""}${s.link_required} account${s.link_required === 1 ? "" : "s"}
        needing a link will be left alone.
      </div>

      ${needsAdmin ? `
        <div class="wpu-danger">
          <strong>This grants Administrator on ${s.adminSiteCount} website${s.adminSiteCount === 1 ? "" : "s"}.</strong>
          <div style="margin-top:7px">${adminSiteNames.slice(0, 8).map(esc).join("<br />")}
            ${adminSiteNames.length > 8 ? `<br />…and ${adminSiteNames.length - 8} more` : ""}</div>
          <div style="margin-top:7px">${adminRows.length} assignment${adminRows.length === 1 ? "" : "s"} in total.</div>
        </div>
        <label class="wpu-check" style="margin-bottom:14px">
          <input type="checkbox" id="wpu-c-admin" />
          <span>I confirm these people should be able to administer those websites.</span>
        </label>` : ""}

      ${s.adminBlockedSiteCount ? `<div class="wpu-warnbox">
        <strong>${s.adminBlockedSiteCount} website${s.adminBlockedSiteCount === 1 ? " hasn’t" : "s haven’t"} allowed Administrator to be granted from here.</strong>
        Those assignments are blocked and will be skipped. Someone with access to each
        site’s WP Admin can enable it under DE Monitoring → User management.
      </div>` : ""}

      ${demotions.length ? `
        <div class="wpu-warnbox">
          <strong>${demotions.length} existing administrator${demotions.length === 1 ? "" : "s"} would have their role changed.</strong>
          A website's last administrator is never changed — those are refused by the
          website itself.
        </div>
        <label class="wpu-check" style="margin-bottom:14px">
          <input type="checkbox" id="wpu-c-demote" />
          <span>I confirm these administrators should have their role changed.</span>
        </label>` : ""}

      ${externalPeople.length ? `
        <div class="wpu-warnbox">
          <strong>${externalPeople.length} address${externalPeople.length === 1 ? " is" : "es are"} outside @digitalelementsgroup.com.</strong>
          <div style="margin-top:7px">${externalPeople.slice(0, 5).map(esc).join("<br />")}</div>
        </div>
        <label class="wpu-check" style="margin-bottom:14px">
          <input type="checkbox" id="wpu-c-domain" />
          <span>I confirm these external addresses should have accounts on client websites. This is recorded in the activity log.</span>
        </label>` : ""}

      <div class="wpu-note">
        Passwords are never shown or sent by us — each new account gets WordPress’s
        own set-password email. Nothing is deleted by this action.
      </div>`,
    actions: `<button class="btn-ghost" onclick="wpuRenderReviewModal()">Back</button>
              <button class="btn-primary" onclick="wpuApply()">Apply changes</button>`,
  });
}

// Re-opens the review without re-running the preflight, for the Back button.
function wpuRenderReviewModal() {
  wpuOpenModal({
    eyebrow: "Website assignment",
    title: "Review",
    body: '<div class="wpu-empty">…</div>',
    actions: "",
  });
  wpuRenderReview();
}

async function wpuApply() {
  const need = (id) => {
    const el = document.getElementById(id);
    return el ? el.checked : true;
  };
  if (!need("wpu-c-admin") || !need("wpu-c-demote") || !need("wpu-c-domain")) {
    return wpuModalError("Tick every confirmation to continue.");
  }

  const domainEl = document.getElementById("wpu-c-domain");
  const adminEl = document.getElementById("wpu-c-admin");

  try {
    const job = await wpuApi("/assign", {
      method: "POST",
      body: {
        staffUserIds: WPU_ASSIGN.teamId ? [] : WPU_ASSIGN.staffIds,
        teamId: WPU_ASSIGN.teamId,
        websiteIds: [...WPU_ASSIGN.selected],
        roleOverrides: WPU_ASSIGN.roleOverrides,
        confirmAdmin: !!(adminEl && adminEl.checked),
        overrideDomain: !!(domainEl && domainEl.checked),
      },
    });
    wpuWatchJob(job.jobId);
  } catch (err) {
    wpuModalError(err.message);
  }
}

/* -------------------------------------------------------------- progress -- */

const WPU_JOB = { id: null, timer: null, data: null };

const WPU_OP_STATE = {
  pending:     { label: "Pending",    cls: "none" },
  processing:  { label: "Working…",   cls: "warn" },
  synced:      { label: "Created",    cls: "ok" },
  linked:      { label: "Linked",     cls: "ok" },
  updated:     { label: "Updated",    cls: "ok" },
  skipped:     { label: "No change",  cls: "none" },
  removed:     { label: "No longer managed", cls: "ok" },
  failed:      { label: "Failed",     cls: "bad" },
  interrupted: { label: "Interrupted", cls: "warn" },
};

/**
 * Polls a running job.
 *
 * 1.5 seconds is fast enough to feel live and slow enough that a job across a
 * dozen sites doesn't generate more requests than the work itself. Polling
 * stops the moment the job reports done — the server decides that, not a
 * client-side guess about how long it should take.
 */
function wpuWatchJob(jobId) {
  WPU_JOB.id = jobId;
  if (WPU_JOB.timer) clearInterval(WPU_JOB.timer);

  const tick = async () => {
    try {
      const res = await wpuApi(`/jobs/${jobId}`);
      WPU_JOB.data = res.job;
      wpuRenderProgress();
      if (res.job.done && WPU_JOB.timer) {
        clearInterval(WPU_JOB.timer);
        WPU_JOB.timer = null;
      }
    } catch (err) {
      if (WPU_JOB.timer) { clearInterval(WPU_JOB.timer); WPU_JOB.timer = null; }
      const panel = document.querySelector("#wpuModal .modal-form");
      if (panel) panel.innerHTML = `<div class="wpu-danger">${esc(err.message)}</div>`;
    }
  };

  wpuOpenModal({
    eyebrow: "Website assignment",
    title: "Applying changes",
    body: '<div class="wpu-empty">Starting…</div>',
    actions: '<button class="btn-ghost" onclick="wpuCloseJob()">Close</button>',
  });
  tick();
  WPU_JOB.timer = setInterval(tick, 1500);
}

function wpuCloseJob() {
  if (WPU_JOB.timer) { clearInterval(WPU_JOB.timer); WPU_JOB.timer = null; }
  wpuCloseModal();
  if (WPU.tab === "websites") wpuRenderWebsites(true);
}

function wpuRenderProgress() {
  const panel = document.querySelector("#wpuModal .modal-form");
  const actionsEl = document.querySelector("#wpuModal .modal-actions");
  const job = WPU_JOB.data;
  if (!panel || !job) return;

  const ops = job.operations;
  const done = ops.filter((o) => !["pending", "processing"].includes(o.status)).length;
  const pct = ops.length ? Math.round((done / ops.length) * 100) : 0;
  const failed = ops.filter((o) => ["failed", "interrupted"].includes(o.status));
  const warned = ops.filter((o) => (o.warnings || []).length);

  const counts = Object.entries(job.counts).map(([k, n]) => {
    const st = WPU_OP_STATE[k] || WPU_OP_STATE.pending;
    return `<span class="wpu-chip ${esc(st.cls)}">${n} ${esc(st.label.toLowerCase().replace("…", ""))}</span>`;
  }).join("");

  const rows = ops.map((o) => {
    const st = WPU_OP_STATE[o.status] || WPU_OP_STATE.pending;
    return `
      <tr>
        <td data-label="Person"><span class="wpu-name">${esc(o.staffLabel || o.staffEmail || "—")}</span></td>
        <td data-label="Website">${esc(o.websiteName || "—")}</td>
        <td data-label="Role"><span class="wpu-chip role">${esc(o.requestedRole || "—")}</span></td>
        <td data-label="Status">
          <span class="wpu-chip ${esc(st.cls)}">${esc(st.label)}</span>
          ${o.replayed ? ' <span class="wpu-chip none" title="This had already been applied; the website replayed its earlier result">already applied</span>' : ""}
          ${o.attempt > 1 ? ` <span class="wpu-chip none">attempt ${o.attempt}</span>` : ""}
          ${o.error ? `<div class="wpu-blocker">${esc(o.error)}</div>` : ""}
          ${(o.warnings || []).map((w) => `<div class="wpu-warn-line">${esc(w.message)}</div>`).join("")}
        </td>
      </tr>`;
  }).join("");

  panel.innerHTML = `
    <div class="wpu-progress"><div class="wpu-progress-bar" style="width:${pct}%"></div></div>
    <div class="wpu-bar" style="margin-top:12px">
      <span class="wpu-chip">${done} of ${ops.length} done</span>
      ${counts}
    </div>

    ${warned.length ? `<div class="wpu-warnbox">
      <strong>${warned.length} account${warned.length === 1 ? "" : "s"} created, but the website couldn’t send the set-password email.</strong>
      Those people can use the Lost Password link instead. We never send or display passwords.
    </div>` : ""}

    <div class="wpu-card">
      <table class="wpu-table">
        <thead><tr><th>Person</th><th>Website</th><th>Role</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    ${job.done ? `<div class="wpu-note" style="margin-top:12px">
      Finished — ${esc(job.status)}. Each website was handled independently, so a failure
      on one didn’t affect the others.
    </div>` : ""}`;

  if (actionsEl) {
    actionsEl.innerHTML = `
      <span class="wpu-msg" id="wpuModalMsg" style="margin-right:auto"></span>
      ${failed.length && job.done
        ? `<button class="btn" onclick="wpuRetryJob()">Retry failed (${failed.length})</button>`
        : ""}
      <button class="btn-primary" onclick="wpuCloseJob()">${job.done ? "Done" : "Run in background"}</button>`;
  }
}

/**
 * Retries only the failed operations.
 *
 * Safe to press repeatedly: each retry reuses its operation's original
 * idempotency key, so anything that actually did apply before the failure is
 * replayed by the website rather than applied a second time.
 */
async function wpuRetryJob() {
  try {
    await wpuApi(`/jobs/${WPU_JOB.id}/retry`, { method: "POST" });
    wpuWatchJob(WPU_JOB.id);
  } catch (err) {
    wpuModalError(err.message);
  }
}

/* ------------------------------------------------ delete from a website -- */

/**
 * Removing someone's WordPress account from one or more websites.
 *
 * Called "Delete from this website" and not "Remove", because on single-site
 * WordPress there is no such thing as removing a user from a site — the only
 * operation is deleting the account. Calling it anything softer would be
 * describing a different, gentler action than the one about to happen.
 *
 * The flow refuses to shorten:
 *
 *   ownership breakdown → pick a recipient → reassign → the app RE-CHECKS and
 *   shows 0 remaining as proof → only then does the delete button unlock →
 *   typed confirmation
 *
 * The app's zero is evidence for the administrator, not the safety mechanism.
 * The website re-counts ownership inside the delete request itself and refuses
 * if anything appeared in the meantime, so a stale screen can never orphan
 * content.
 */
const WPU_DEL = {
  staffId: null,
  staffLabel: "",
  plan: null,
  reassignTargets: {},   // websiteId -> chosen recipient id
  busy: false,
};

async function wpuStartDelete(staffId) {
  const user = WPU.users.find((u) => u.id === staffId);
  WPU_DEL.staffId = staffId;
  WPU_DEL.staffLabel = user ? user.label : "this person";
  WPU_DEL.reassignTargets = {};
  WPU_DEL.plan = null;

  wpuOpenModal({
    eyebrow: "Delete from websites",
    title: `Delete ${WPU_DEL.staffLabel} from websites`,
    body: '<div class="wpu-empty">Checking websites…</div>',
    actions: '<button class="btn-ghost" onclick="wpuCloseModal()">Cancel</button>',
  });

  try {
    const sites = await wpuApi("/websites");
    const candidates = (sites.websites || []).filter((w) => w.enrolled);
    if (!candidates.length) {
      return wpuDelError("No connected websites to delete from.");
    }
    WPU_DEL.plan = await wpuApi("/deletion-plan", {
      method: "POST",
      body: { staffUserId: staffId, websiteIds: candidates.map((w) => w.websiteId) },
    });
    // Only websites where they actually have an account are worth showing.
    WPU_DEL.plan.rows = WPU_DEL.plan.rows.filter((r) => r.hasAccount || r.error);
    wpuRenderDelete();
  } catch (err) {
    wpuDelError(err.message);
  }
}

function wpuDelError(message) {
  const panel = document.querySelector("#wpuModal .modal-form");
  if (panel) panel.innerHTML = `<div class="wpu-danger">${esc(message)}</div>`;
}

function wpuRenderDelete() {
  const panel = document.querySelector("#wpuModal .modal-form");
  const actions = document.querySelector("#wpuModal .modal-actions");
  const plan = WPU_DEL.plan;
  if (!panel || !plan) return;

  const rows = plan.rows;
  const ready = rows.filter((r) => r.canDelete);
  const blocked = rows.filter((r) => !r.canDelete);

  if (!rows.length) {
    panel.innerHTML = `<div class="wpu-note">${esc(WPU_DEL.staffLabel)} has no WordPress account on any connected website.</div>`;
    if (actions) actions.innerHTML = '<button class="btn-primary" onclick="wpuCloseModal()">Close</button>';
    return;
  }

  const cards = rows.map((r) => {
    if (r.error) {
      return `<div class="wpu-delsite bad">
        <div class="wpu-delsite-head"><strong>${esc(r.websiteName)}</strong>
          <span class="wpu-chip bad">Couldn’t check</span></div>
        <div class="wpu-blocker">${esc(r.error)}</div>
      </div>`;
    }

    if (r.canDelete) {
      return `<div class="wpu-delsite ok">
        <div class="wpu-delsite-head"><strong>${esc(r.websiteName)}</strong>
          <span class="wpu-chip ok">Nothing owned — safe to delete</span></div>
        <div class="wpu-note">Verified just now: this account owns no content on this website.</div>
      </div>`;
    }

    // Owns content: the breakdown, then a recipient, then reassign.
    const chosen = WPU_DEL.reassignTargets[r.websiteId] || "";
    const options = (r.targets || []).map((t) =>
      `<option value="${esc(t.id)}"${String(t.id) === String(chosen) ? " selected" : ""}>${esc(t.display_name || t.login)} (${esc(t.email)})</option>`
    ).join("");

    return `<div class="wpu-delsite warn">
      <div class="wpu-delsite-head"><strong>${esc(r.websiteName)}</strong>
        <span class="wpu-chip warn">Owns content</span></div>
      <div class="wpu-owned">${esc(r.summary)}</div>
      ${r.isAdminEmail ? '<div class="wpu-blocker">This account is also this website’s admin email address.</div>' : ""}
      ${options ? `
        <div class="wpu-delsite-row">
          <select onchange="wpuPickHeir('${escJs(r.websiteId)}', this.value)">
            <option value="">Choose who receives this content…</option>
            ${options}
          </select>
          <button class="btn" ${chosen ? "" : "disabled"} onclick="wpuReassign('${escJs(r.websiteId)}')">Reassign…</button>
        </div>`
      : '<div class="wpu-blocker">No one on this website can receive the content. Add an author or editor first.</div>'}
    </div>`;
  }).join("");

  panel.innerHTML = `
    <div class="wpu-danger">
      <strong>This deletes ${esc(WPU_DEL.staffLabel)}’s WordPress account.</strong>
      On a normal WordPress site there is no way to remove someone from the site
      without deleting their account, so that is what this does. Content they own
      has to be reassigned first — it is never deleted with them.
    </div>

    <div class="wpu-bar">
      ${ready.length ? `<span class="wpu-chip ok">${ready.length} ready</span>` : ""}
      ${blocked.length ? `<span class="wpu-chip warn">${blocked.length} need attention</span>` : ""}
    </div>

    <div class="wpu-delsites">${cards}</div>

    ${ready.length ? `
      ${ready.length > 1 ? `
        <label class="wpu-check" style="margin:16px 0 12px">
          <input type="checkbox" id="wpu-del-multi" />
          <span>I confirm this deletes accounts on <strong>${ready.length} separate websites</strong>.</span>
        </label>` : ""}
      <div class="wpu-field" style="margin-top:14px">
        <label for="wpu-del-confirm">Type <strong>DELETE</strong> to confirm</label>
        <input id="wpu-del-confirm" type="text" autocomplete="off" placeholder="DELETE" />
      </div>` : `
      <div class="wpu-note" style="margin-top:14px">
        Nothing can be deleted yet — reassign the content above first.
      </div>`}`;

  if (actions) {
    actions.innerHTML = `
      <span class="wpu-msg err" id="wpuModalMsg" style="margin-right:auto"></span>
      <button class="btn-ghost" onclick="wpuCloseModal()">Cancel</button>
      <button class="btn-primary" style="background:var(--fail)" ${ready.length ? "" : "disabled"}
              onclick="wpuConfirmDelete()">Delete from ${ready.length} website${ready.length === 1 ? "" : "s"}</button>`;
  }
}

function wpuPickHeir(websiteId, targetId) {
  if (targetId) WPU_DEL.reassignTargets[websiteId] = targetId;
  else delete WPU_DEL.reassignTargets[websiteId];
  wpuRenderDelete();
}

/**
 * Reassigns one website's content, with its own typed confirmation.
 *
 * Reassignment is not destructive, but it changes the authorship of everything
 * the person ever published — which is visible on the site and tedious to undo
 * — so it is confirmed like a destructive action rather than slipped in behind
 * a dropdown.
 */
function wpuReassign(websiteId) {
  const row = WPU_DEL.plan.rows.find((r) => r.websiteId === websiteId);
  const targetId = WPU_DEL.reassignTargets[websiteId];
  const target = (row.targets || []).find((t) => String(t.id) === String(targetId));
  if (!row || !target) return;

  wpuOpenModal({
    eyebrow: "Reassign content",
    title: `Reassign on ${row.websiteName}?`,
    body: `
      <div class="wpu-warnbox">
        <strong>${esc(row.summary)}</strong> will become
        <strong>${esc(target.display_name || target.login)}</strong>’s.
        Nothing is deleted, but authorship changes everywhere it appears on the
        website, and undoing it means reassigning back by hand.
      </div>
      <div class="wpu-field">
        <label for="wpu-re-confirm">Type <strong>REASSIGN</strong> to confirm</label>
        <input id="wpu-re-confirm" type="text" autocomplete="off" placeholder="REASSIGN" />
      </div>`,
    actions: `<button class="btn-ghost" onclick="wpuRenderDeleteModal()">Back</button>
              <button class="btn-primary" onclick="wpuDoReassign('${escJs(websiteId)}')">Reassign content</button>`,
  });
}

function wpuRenderDeleteModal() {
  wpuOpenModal({
    eyebrow: "Delete from websites",
    title: `Delete ${WPU_DEL.staffLabel} from websites`,
    body: '<div class="wpu-empty">…</div>',
    actions: "",
  });
  wpuRenderDelete();
}

async function wpuDoReassign(websiteId) {
  const field = document.getElementById("wpu-re-confirm");
  if (!field || field.value.trim().toUpperCase() !== "REASSIGN") {
    return wpuModalError("Type REASSIGN to confirm.");
  }
  const targetId = WPU_DEL.reassignTargets[websiteId];

  try {
    const res = await wpuApi(`/content/${WPU_DEL.staffId}/${websiteId}/reassign`, {
      method: "POST", body: { targetId },
    });
    // Re-check from the website rather than assuming the move emptied it. The
    // zero shown next is the site's own count, taken after the move.
    WPU_DEL.plan = await wpuApi("/deletion-plan", {
      method: "POST",
      body: { staffUserId: WPU_DEL.staffId, websiteIds: WPU_DEL.plan.rows.map((r) => r.websiteId) },
    });
    WPU_DEL.plan.rows = WPU_DEL.plan.rows.filter((r) => r.hasAccount || r.error);
    wpuRenderDeleteModal();

    const row = WPU_DEL.plan.rows.find((r) => r.websiteId === websiteId);
    const msg = document.getElementById("wpuModalMsg");
    if (msg) {
      const clean = row && !row.ownsContent;
      msg.className = clean ? "wpu-msg ok" : "wpu-msg err";
      msg.textContent = clean
        ? `Reassigned. Re-checked: 0 items remaining.`
        : `Reassigned, but ${row ? row.summary : "content"} still remains.`;
    }
  } catch (err) {
    wpuModalError(err.message);
  }
}

function wpuConfirmDelete() {
  const typed = document.getElementById("wpu-del-confirm");
  if (!typed || typed.value.trim().toUpperCase() !== "DELETE") {
    return wpuModalError("Type DELETE to confirm.");
  }
  const multi = document.getElementById("wpu-del-multi");
  if (multi && !multi.checked) {
    return wpuModalError("Confirm that this affects several websites.");
  }
  wpuDoDelete(multi ? multi.checked : false);
}

async function wpuDoDelete(confirmMultipleSites) {
  const ready = WPU_DEL.plan.rows.filter((r) => r.canDelete);
  try {
    const job = await wpuApi("/delete-accounts", {
      method: "POST",
      body: {
        staffUserIds: [WPU_DEL.staffId],
        websiteIds: ready.map((r) => r.websiteId),
        reassignTargets: WPU_DEL.reassignTargets,
        confirm: "DELETE",
        confirmMultipleSites,
      },
    });
    wpuWatchJob(job.jobId);
  } catch (err) {
    wpuModalError(err.message);
  }
}


/* --------------------------------------------------------- sync status --- */

/**
 * Where every connected website stands, in one place.
 *
 * Exists because the questions an administrator actually asks during a rollout
 * — which sites still need the plugin update, which were never connected, which
 * can't be reached, and did anything get stranded by a restart — are otherwise
 * answered by opening each site's row one at a time.
 */
async function wpuRenderSync(force) {
  const panel = document.getElementById("wpuPanel");
  panel.innerHTML = `<div class="wpu-card"><div class="wpu-empty">${force ? "Re-checking every website…" : "Loading…"}</div></div>`;

  let data;
  try {
    data = await wpuApi("/sync-status" + (force ? "?refresh=1" : ""));
  } catch (err) {
    panel.innerHTML = `<div class="wpu-card"><div class="wpu-empty"><h4>Couldn’t load sync status</h4><div class="wpu-note">${esc(err.message)}</div></div></div>`;
    return;
  }

  if (!data.configured) {
    panel.innerHTML = `<div class="wpu-card"><div class="wpu-empty">
      <h4>User management isn’t configured on this server</h4>
      <div class="wpu-note">Set <code>USER_MGMT_ENC_KEY</code> and restart. See <code>docs/user-management.md</code>.</div>
    </div></div>`;
    return;
  }

  const s = data.summary;
  const needUpdate = data.sites.filter((x) => x.needsPluginUpdate);
  const needEnroll = data.sites.filter((x) => x.needsEnrollment);
  const unreachable = data.sites.filter((x) => x.readiness === "unreachable");

  const siteRows = data.sites.map((x) => {
    const state = WPU_READINESS[x.readiness] || WPU_READINESS.unknown;
    const counts = Object.entries(x.assignments || {})
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `<span class="wpu-chip ${k === "failed" ? "bad" : k === "synced" || k === "updated" ? "ok" : "none"}">${n} ${esc(k)}</span>`)
      .join(" ");

    return `
      <tr>
        <td data-label="Website"><span class="wpu-name">${esc(x.name)}</span><span class="wpu-sub">${esc(x.url)}</span></td>
        <td data-label="Status"><span class="wpu-chip ${esc(state.cls)}" title="${esc(x.message || "")}">${esc(state.label)}</span></td>
        <td data-label="Plugin">${x.pluginVersion
          ? `<span class="wpu-chip role${x.needsPluginUpdate ? " admin-like" : ""}">${esc(x.pluginVersion)}</span>`
          : '<span class="wpu-chip none">unknown</span>'}
          ${x.needsPluginUpdate ? `<div class="wpu-note">needs contract v${x.requiredApiVersion}</div>` : ""}
          ${x.licenseMismatch ? `<div class="wpu-blocker">Licensed to “${esc(x.licenseSite)}”</div>` : ""}</td>
        <td data-label="Can do">${(x.capabilities || []).length
          ? x.capabilities.map((c) => `<span class="wpu-chip role">${esc(c)}</span>`).join(" ")
          : '<span class="wpu-chip none">—</span>'}</td>
        <td data-label="Site allows">${(x.scopes || []).length
          ? x.scopes.map((c) => `<span class="wpu-chip role">${esc(c)}</span>`).join(" ")
          : '<span class="wpu-chip none">—</span>'}</td>
        <td data-label="Accounts">${counts || '<span class="wpu-chip none">none</span>'}</td>
        <td data-label="Checked" class="wpu-audit-when">${esc(x.checkedAt ? wpuWhen(x.checkedAt) : "—")}</td>
      </tr>`;
  }).join("");

  const jobRows = data.jobs.map((j) => {
    const cls = j.status === "done" ? "ok" : j.status === "partial" || j.status === "interrupted" ? "warn" : j.status === "failed" ? "bad" : "none";
    const totals = j.totals ? Object.entries(j.totals).map(([k, n]) => `${n} ${k}`).join(", ") : "";
    return `
      <tr>
        <td data-label="When" class="wpu-audit-when">${esc(wpuWhen(j.createdAt))}</td>
        <td data-label="What"><span class="wpu-audit-act">${esc(j.kind)}</span></td>
        <td data-label="Who">${esc(j.initiatedEmail || "—")}</td>
        <td data-label="Result"><span class="wpu-chip ${cls}">${esc(j.status)}</span> ${esc(totals)}</td>
        <td class="wpu-actions"><button class="wpu-linkbtn" onclick="wpuWatchJob('${escJs(j.id)}')">View</button></td>
      </tr>`;
  }).join("");

  panel.innerHTML = `
    <div class="wpu-bar">
      <div class="grow">
        <span class="wpu-chip ok">${s.ready} ready</span>
        ${s.needsUpdate ? `<span class="wpu-chip warn">${s.needsUpdate} need the plugin update</span>` : ""}
        ${s.needsEnrollment ? `<span class="wpu-chip warn">${s.needsEnrollment} not connected</span>` : ""}
        ${s.unreachable ? `<span class="wpu-chip bad">${s.unreachable} unreachable</span>` : ""}
      </div>
      <button class="btn" onclick="wpuRenderSync(true)">Re-check all</button>
    </div>

    ${(data.enrollmentFailures || []).length ? `<div class="wpu-warnbox">
      <strong>${data.enrollmentFailures.length} enrollment attempt${data.enrollmentFailures.length === 1 ? " was" : "s were"} refused in the last 7 days.</strong>
      <div style="margin-top:8px">
        ${data.enrollmentFailures.slice(0, 6).map((f) => `
          <div style="margin-bottom:6px">
            <span class="wpu-audit-when">${esc(wpuWhen(f.at))}</span> —
            <strong>${esc(f.site || f.reportedSiteUrl || "unknown website")}</strong>:
            ${esc(f.explanation || f.reason)}
          </div>`).join("")}
        ${data.enrollmentFailures.length > 6 ? `<div class="wpu-note">…and ${data.enrollmentFailures.length - 6} more in the activity log.</div>` : ""}
      </div>
    </div>` : ""}

    ${data.interrupted ? `<div class="wpu-warnbox">
      <strong>${data.interrupted} operation${data.interrupted === 1 ? "" : "s"} were interrupted by a server restart.</strong>
      They are safe to retry — each one replays rather than repeating, so nothing is applied twice.
      Open the job below and press Retry failed.
    </div>` : ""}

    ${needUpdate.length ? `<div class="wpu-warnbox">
      <strong>${needUpdate.length} website${needUpdate.length === 1 ? "" : "s"} still need the helper plugin update.</strong>
      <div style="margin-top:6px">${needUpdate.map((x) => `${esc(x.name)} (has ${esc(x.pluginVersion || "an older version")})`).join("<br />")}</div>
      <div style="margin-top:8px">Sites with automatic updates on will pick it up within a few hours.
      The rest need someone to press Update on that site’s Plugins screen. Nothing else can be done from here.</div>
    </div>` : ""}

    ${needEnroll.length ? `<div class="wpu-note" style="margin-bottom:14px">
      ${needEnroll.length} website${needEnroll.length === 1 ? " has" : "s have"} the right plugin but aren’t connected yet —
      generate a code on the Websites tab. Connecting always takes someone with access to that site’s admin;
      it can’t be switched on from here.
    </div>` : ""}

    ${unreachable.length ? `<div class="wpu-note" style="margin-bottom:14px">
      ${unreachable.length} website${unreachable.length === 1 ? "" : "s"} couldn’t be reached just now. That’s different from
      being out of date — it may simply be down or blocking us.
    </div>` : ""}

    <div class="wpu-roles-head">Websites</div>
    <div class="wpu-card" style="margin-bottom:22px">
      <table class="wpu-table">
        <thead><tr><th>Website</th><th>Status</th><th>Plugin</th><th>Can do</th><th>Site allows</th><th>Accounts</th><th>Checked</th></tr></thead>
        <tbody>${siteRows || '<tr><td colspan="7"><div class="wpu-empty"><h4>No websites yet</h4></div></td></tr>'}</tbody>
      </table>
    </div>

    <div class="wpu-roles-head">Recent runs</div>
    <div class="wpu-card">
      ${data.jobs.length ? `<table class="wpu-table">
        <thead><tr><th>When</th><th>What</th><th>Who</th><th>Result</th><th></th></tr></thead>
        <tbody>${jobRows}</tbody></table>`
      : '<div class="wpu-empty"><h4>Nothing has run yet</h4><div class="wpu-note">Assignments and deletions appear here.</div></div>'}
    </div>

    <div class="wpu-note" style="margin-top:12px">
      “Can do” is what that website’s plugin supports. “Site allows” is what its own administrator
      has permitted — deleting users and granting Administrator stay off unless they turn them on,
      and this dashboard can’t change that.
    </div>`;
}

/* -------------------------------------------------------- activity log --- */

const WPU_AUDIT = { filters: { entityType: "", website: "", actor: "", action: "" }, facets: null, entries: [], expanded: new Set() };

/**
 * Every administrative change, filterable.
 *
 * before/after are rendered from the redacted copies the server sends. They are
 * redacted on write as well, so this is the second pass — an entry written by
 * an earlier version, or by a future caller that forgets, still cannot render a
 * secret, a signature or an idempotency key in a browser.
 */
async function wpuRenderAudit() {
  const panel = document.getElementById("wpuPanel");
  panel.innerHTML = '<div class="wpu-card"><div class="wpu-empty">Loading…</div></div>';

  const f = WPU_AUDIT.filters;
  const params = new URLSearchParams();
  if (f.entityType) params.set("entityType", f.entityType);
  if (f.website) params.set("website", f.website);
  if (f.actor) params.set("actor", f.actor);
  if (f.action) params.set("action", f.action);
  params.set("limit", "200");

  let data;
  try {
    data = await wpuApi("/audit?" + params.toString());
  } catch (err) {
    panel.innerHTML = `<div class="wpu-card"><div class="wpu-empty"><h4>Couldn’t load the activity log</h4><div class="wpu-note">${esc(err.message)}</div></div></div>`;
    return;
  }

  WPU_AUDIT.entries = data.entries;
  WPU_AUDIT.facets = data.facets || { actions: [], actors: [], entityTypes: [] };
  wpuDrawAudit();
}

function wpuDrawAudit() {
  const panel = document.getElementById("wpuPanel");
  const f = WPU_AUDIT.filters;
  const facets = WPU_AUDIT.facets;
  const entries = WPU_AUDIT.entries;

  const siteName = (id) => {
    const w = (WPU.websites || []).find((x) => x.websiteId === id);
    return w ? w.name : id ? id.slice(0, 8) : null;
  };

  const rows = entries.map((e) => {
    const open = WPU_AUDIT.expanded.has(e.id);
    const changed = e.before || e.after;
    const resultCls = e.result === "ok" ? "ok" : e.result === "failed" ? "bad" : e.result === "refused" ? "warn" : "none";
    return `
      <tr class="${changed ? "wpu-audit-row" : ""}" ${changed ? `onclick="wpuToggleAudit('${escJs(e.id)}')"` : ""}>
        <td data-label="When" class="wpu-audit-when">${esc(wpuWhen(e.at))}</td>
        <td data-label="Action"><span class="wpu-audit-act">${esc(e.action)}</span>
          ${changed ? `<span class="wpu-chip none">${open ? "hide" : "details"}</span>` : ""}</td>
        <td data-label="Who">${esc(e.actorEmail || "—")}</td>
        <td data-label="Target">${esc(e.targetEmail || e.entityId || "—")}</td>
        <td data-label="Website">${e.websiteId ? esc(siteName(e.websiteId)) : '<span class="wpu-chip none">—</span>'}</td>
        <td data-label="Result"><span class="wpu-chip ${resultCls}">${esc(e.result || "ok")}</span></td>
      </tr>
      ${open ? `<tr class="wpu-audit-detail"><td colspan="6">
        <div class="wpu-diff">
          <div><div class="wpu-diff-head">Before</div><pre>${esc(wpuJson(e.before))}</pre></div>
          <div><div class="wpu-diff-head">After</div><pre>${esc(wpuJson(e.after))}</pre></div>
        </div>
      </td></tr>` : ""}`;
  }).join("");

  panel.innerHTML = `
    <div class="wpu-bar">
      <select onchange="wpuAuditFilter('action', this.value)">
        <option value=""${!f.action ? " selected" : ""}>All actions</option>
        ${(facets.actions || []).map((a) => `<option value="${esc(a)}"${f.action === a ? " selected" : ""}>${esc(a)}</option>`).join("")}
      </select>
      <select onchange="wpuAuditFilter('entityType', this.value)">
        <option value=""${!f.entityType ? " selected" : ""}>Anything</option>
        ${(facets.entityTypes || []).map((t) => `<option value="${esc(t)}"${f.entityType === t ? " selected" : ""}>${esc(t)}</option>`).join("")}
      </select>
      <select onchange="wpuAuditFilter('actor', this.value)">
        <option value=""${!f.actor ? " selected" : ""}>Anyone</option>
        ${(facets.actors || []).map((a) => `<option value="${esc(a)}"${f.actor === a ? " selected" : ""}>${esc(a)}</option>`).join("")}
      </select>
      <select onchange="wpuAuditFilter('website', this.value)">
        <option value=""${!f.website ? " selected" : ""}>All websites</option>
        ${(WPU.websites || []).map((w) => `<option value="${esc(w.websiteId)}"${f.website === w.websiteId ? " selected" : ""}>${esc(w.name)}</option>`).join("")}
      </select>
      ${Object.values(f).some(Boolean) ? '<button class="wpu-linkbtn" onclick="wpuAuditClear()">Clear filters</button>' : ""}
    </div>

    <div class="wpu-card">
      ${entries.length ? `<table class="wpu-table">
        <thead><tr><th>When</th><th>Action</th><th>Who</th><th>Target</th><th>Website</th><th>Result</th></tr></thead>
        <tbody>${rows}</tbody></table>`
      : `<div class="wpu-empty"><h4>${Object.values(f).some(Boolean) ? "Nothing matches those filters" : "Nothing recorded yet"}</h4>
         <div class="wpu-note">${Object.values(f).some(Boolean) ? "Try clearing them." : "Actions appear here as soon as you make them."}</div></div>`}
    </div>

    <div class="wpu-note" style="margin-top:12px">
      Showing ${entries.length} entr${entries.length === 1 ? "y" : "ies"}, newest first.
      Secrets, signatures and idempotency keys are never stored here or shown — the log records
      what changed and who changed it, not how the request was authenticated.
    </div>`;
}

function wpuJson(value) {
  if (value == null) return "—";
  try { return JSON.stringify(value, null, 2); } catch (e) { return String(value); }
}
function wpuToggleAudit(id) {
  if (WPU_AUDIT.expanded.has(id)) WPU_AUDIT.expanded.delete(id);
  else WPU_AUDIT.expanded.add(id);
  wpuDrawAudit();
}
function wpuAuditFilter(key, value) {
  WPU_AUDIT.filters[key] = value;
  WPU_AUDIT.expanded.clear();
  wpuRenderAudit();
}
function wpuAuditClear() {
  WPU_AUDIT.filters = { entityType: "", website: "", actor: "", action: "" };
  wpuRenderAudit();
}
