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
  loaded: false,
  websites: [],
  filters: { q: "", team: "", role: "", status: "" },
  selected: new Set(),
};

const WPU_TABS = [
  { id: "teams", label: "Teams" },
  { id: "users", label: "Users" },
  { id: "websites", label: "Websites" },
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

// Administrator is never offered as a default — it is granted per website with
// an explicit confirmation, which is what the server enforces too.
function wpuRoleOptions(selected, { includeInherit = false, inheritLabel = "" } = {}) {
  const opts = WPU.roles.filter((r) => !r.adminLike).map((r) =>
    `<option value="${esc(r.slug)}"${r.slug === selected ? " selected" : ""}>${esc(r.name)}</option>`
  );
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
      WPU.loaded = true;
    } catch (err) {
      root.innerHTML = `<div class="wpu-empty"><h4>Couldn’t load user management</h4><div class="wpu-note">${esc(err.message)}</div></div>`;
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
        <div class="hint">Applied to this team’s members on a website unless a per-person or per-website override says otherwise. Administrator is granted per website, with confirmation — never as a default.</div>
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
        <strong>This can’t be undone.</strong> No WordPress account on any website is
        changed or removed by deleting a team — only the grouping in this app.
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
  const body = {};
  if (dispEl) {
    body.onUsers = dispEl.value;
    if (dispEl.value === "move") body.moveToTeamId = document.getElementById("wpu-t-moveto").value;
  }
  try {
    await wpuApi(`/teams/${id}`, { method: "DELETE", body });
    wpuCloseModal();
    await wpuRefresh({ teams: true, users: true });
  } catch (err) { wpuModalError(err.message); }
}

/* -------------------------------------------------------------------- users */

function wpuFilteredUsers() {
  const f = WPU.filters;
  const q = f.q.trim().toLowerCase();
  return WPU.users.filter((u) => {
    if (f.team === "none" ? u.teamId : f.team && u.teamId !== f.team) return false;
    if (f.role && u.effectiveWpRole !== f.role) return false;
    if (f.status && u.status !== f.status) return false;
    if (q && !(u.email.toLowerCase().includes(q) || u.label.toLowerCase().includes(q))) return false;
    return true;
  });
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
      <td data-label="Status">
        ${u.status === "disabled" ? '<span class="wpu-chip disabled">Disabled</span>' : '<span class="wpu-chip">Active</span>'}
        ${u.domainOverride ? ' <span class="wpu-chip ext" title="Outside the agency domain">External</span>' : ""}
      </td>
      <td class="wpu-actions">
        <button class="wpu-linkbtn" onclick="wpuEditUser('${escJs(u.id)}')">Edit</button>
        <button class="wpu-linkbtn danger" onclick="wpuDeleteUser('${escJs(u.id)}')">Remove</button>
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
      <button class="btn primary" onclick="wpuEditUser()">${ICON.plus} Add person</button>
    </div>

    <div class="wpu-selbar${WPU.selected.size ? " show" : ""}">
      <span class="count">${WPU.selected.size} selected</span>
      <select id="wpu-bulk-team">${wpuTeamOptions("", { noneLabel: "No team" })}</select>
      <button class="btn" onclick="wpuBulkMove()">Move to team</button>
      <button class="wpu-linkbtn" onclick="wpuClearSelection()">Clear</button>
      <span class="wpu-msg" id="wpuBulkMsg"></span>
    </div>

    <div class="wpu-card">
      ${list.length ? `<table class="wpu-table">
        <thead><tr>
          <th style="width:34px"><input type="checkbox" onchange="wpuToggleSelectAll(this.checked)" aria-label="Select all" /></th>
          <th>Person</th><th>Team</th><th>Role</th><th>Status</th><th></th>
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
    title: `Remove ${user.label}?`,
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
              <button class="btn-primary" style="background:var(--fail)" onclick="wpuConfirmDeleteUser('${escJs(id)}')">Remove from roster</button>`,
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
      </td>
      <td data-label="Plugin">${w.pluginVersion ? `<span class="wpu-chip role">${esc(w.pluginVersion)}</span>` : '<span class="wpu-chip none">—</span>'}</td>
      <td data-label="Permissions">${w.enrolled && w.scopes.length
        ? w.scopes.map((sc) => `<span class="wpu-chip role">${esc(sc)}</span>`).join(" ")
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
        <thead><tr><th>Website</th><th>Status</th><th>Plugin</th><th>Permissions</th><th>Checked</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table>`
      : '<div class="wpu-empty"><h4>No websites yet</h4><div class="wpu-note">Add websites from the Websites section first.</div></div>'}
    </div>
    <div class="wpu-note" style="margin-top:12px">
      Deleting users and granting Administrator stay off unless each site’s own administrator
      turns them on in its DE Monitoring panel — a local switch this dashboard can’t flip.
    </div>`;
}

async function wpuIssueCode(websiteId, options) {
  const rotate = !!(options && options.rotate);
  const site = (WPU.websites || []).find((w) => w.websiteId === websiteId);
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

/* -------------------------------------------------------------------- audit */

async function wpuRenderAudit() {
  const panel = document.getElementById("wpuPanel");
  panel.innerHTML = '<div class="wpu-card"><div class="wpu-empty">Loading…</div></div>';
  let entries;
  try {
    entries = (await wpuApi("/audit?limit=200")).entries;
  } catch (err) {
    panel.innerHTML = `<div class="wpu-card"><div class="wpu-empty"><h4>Couldn’t load the activity log</h4><div class="wpu-note">${esc(err.message)}</div></div></div>`;
    return;
  }

  const rows = entries.map((e) => `
    <tr>
      <td data-label="When" class="wpu-audit-when">${esc(wpuWhen(e.at))}</td>
      <td data-label="Action"><span class="wpu-audit-act">${esc(e.action)}</span></td>
      <td data-label="Who">${esc(e.actorEmail || "—")}</td>
      <td data-label="Target">${esc(e.targetEmail || (e.after && e.after.name) || e.entityId || "—")}</td>
      <td data-label="Result">${esc(e.result || "ok")}</td>
    </tr>`).join("");

  panel.innerHTML = `
    <div class="wpu-bar"><div class="grow wpu-note">Every change made here is recorded: who did it, what changed, and when. Secrets and passwords are never stored in this log.</div></div>
    <div class="wpu-card">
      ${entries.length ? `<table class="wpu-table">
        <thead><tr><th>When</th><th>Action</th><th>Who</th><th>Target</th><th>Result</th></tr></thead>
        <tbody>${rows}</tbody></table>`
      : '<div class="wpu-empty"><h4>Nothing recorded yet</h4><div class="wpu-note">Actions appear here as soon as you make them.</div></div>'}
    </div>`;
}
