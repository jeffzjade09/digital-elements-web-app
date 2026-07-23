// Pulls task counts for a site's Zoho Projects work, mirroring checks/clickup.js.
// Scope a site's work with one or more Zoho project IDs:
//
//   "zoho": { "enabled": true, "projectIds": ["1704…", "1705…"] }
//
// Auth is OAuth2 with a Self Client refresh token (no per-user login):
//   ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN
//   ZOHO_PORTAL_ID (optional — auto-detects the first portal)
//   ZOHO_DC (data center TLD, default "com"; eu/in/com.au/jp also valid)

const TIMEOUT_MS = 20000;

const accountsBase = (dc) => `https://accounts.zoho.${dc || "com"}`;
const apiBase = (dc) => `https://projectsapi.zoho.${dc || "com"}`;
const webBase = (dc) => `https://projects.zoho.${dc || "com"}`;

async function zfetch(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---- OAuth: exchange the long-lived refresh token for a 1h access token ----
let tokenCache = { token: null, expires: 0 };

async function getAccessToken(z) {
  if (tokenCache.token && Date.now() < tokenCache.expires) return tokenCache.token;
  const qs = new URLSearchParams({
    refresh_token: z.refreshToken,
    client_id: z.clientId,
    client_secret: z.clientSecret,
    grant_type: "refresh_token",
  });
  const res = await zfetch(`${accountsBase(z.dc)}/oauth/v2/token?${qs}`, { method: "POST" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error("AUTH");
  tokenCache = { token: data.access_token, expires: Date.now() + ((Number(data.expires_in) || 3600) - 120) * 1000 };
  return tokenCache.token;
}

async function zohoGet(z, path) {
  const token = await getAccessToken(z);
  const res = await zfetch(`${apiBase(z.dc)}${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  if (res.status === 401) { tokenCache = { token: null, expires: 0 }; throw new Error("AUTH"); }
  if (res.status === 204) return null; // Zoho answers 204 No Content for empty sets
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---- Portal (workspace) auto-detection ----
let portalCache = null; // { id, name }

async function resolvePortal(z) {
  if (z.portalId) return portalCache && portalCache.id === String(z.portalId) ? portalCache : { id: String(z.portalId), name: String(z.portalId) };
  if (portalCache) return portalCache;
  const data = await zohoGet(z, "/restapi/portals/");
  const p = data && Array.isArray(data.portals) && data.portals[0];
  if (!p) throw new Error("no Zoho Projects portal on this token");
  portalCache = { id: String(p.id_string || p.id), name: String(p.name || p.id_string || p.id) };
  return portalCache;
}

// ---- Portal users: id -> email map (assignee matching for "My tasks") ----
// Task owner objects don't reliably carry emails, so we look them up once and
// cache for 10 minutes.
let userCache = { map: null, ts: 0 };

async function getUserEmailMap(z, portalId) {
  if (userCache.map && Date.now() - userCache.ts < 600000) return userCache.map;
  try {
    const data = await zohoGet(z, `/restapi/portal/${portalId}/users/`);
    const map = new Map();
    for (const u of (data && data.users) || []) {
      if (u && u.id != null && u.email) map.set(String(u.id), String(u.email).toLowerCase());
    }
    userCache = { map, ts: Date.now() };
    return map;
  } catch {
    return userCache.map || new Map();
  }
}

// ---- Task fetch (paginated; index is 1-based, range max 100) ----
async function fetchProjectTasks(z, portalId, projectId) {
  const tasks = [];
  const range = 100;
  for (let index = 1; index <= 1401; index += range) {
    const data = await zohoGet(z, `/restapi/portal/${portalId}/projects/${encodeURIComponent(projectId)}/tasks/?index=${index}&range=${range}&status=all`);
    const batch = (data && data.tasks) || [];
    tasks.push(...batch);
    if (batch.length < range) break;
  }
  return tasks;
}

async function fetchAllTasks(z, portalId, projectIds) {
  const perProject = await Promise.all(projectIds.map(async (id) => {
    const tasks = await fetchProjectTasks(z, portalId, id);
    tasks.forEach((t) => { t.__projectId = String(id); }); // needed for write actions
    return tasks;
  }));
  return perProject.flat();
}

// ---- Mapping to the shared task shape (same fields the ClickUp check emits) ----
const PRIORITY_COLORS = { highest: "#e24b4a", high: "#e24b4a", medium: "#ef9f27", low: "#378add" };

function mapTask(t, now, emailMap) {
  const type = (t.status && t.status.type) || "open"; // "open" | "closed"
  const isDone = type === "closed" || t.completed === true;
  const dueMs = t.end_date_long ? Number(t.end_date_long) : null;
  const owners = ((t.details && t.details.owners) || []).filter((o) => o && o.name && String(o.id) !== "-1");
  const pri = t.priority && t.priority !== "None" ? t.priority : null;
  return {
    id: String(t.id_string || t.id),
    projectId: String(t.__projectId || ""),
    name: t.name || "(untitled)",
    list: (t.tasklist && t.tasklist.name) || "Tasks",
    status: (t.status && t.status.name) || "",
    statusType: type,
    statusColor: (t.status && t.status.color_code) || "#8a96ad",
    done: isDone,
    assignees: owners.map((o) => o.name),
    assigneeEmails: owners
      .map((o) => String(o.email || (emailMap && emailMap.get(String(o.id))) || "").toLowerCase())
      .filter(Boolean),
    priority: pri,
    priorityColor: pri ? PRIORITY_COLORS[String(pri).toLowerCase()] || null : null,
    dueMs,
    overdue: !isDone && !!dueMs && dueMs < now,
    updatedMs: t.last_updated_time_long ? Number(t.last_updated_time_long) : null,
    url: (t.link && t.link.web && t.link.web.url) || null,
  };
}

function configured(settings) {
  return settings && settings.clientId && settings.clientSecret && settings.refreshToken;
}

// ---- Dashboard check (Tasks column) ----
export async function checkZoho(zoho, settings) {
  if (!configured(settings)) {
    return { status: "skip", label: "No token", detail: "Zoho API credentials not set" };
  }
  if (!zoho || zoho.enabled === false || !Array.isArray(zoho.projectIds) || !zoho.projectIds.length) {
    return { status: "skip", label: "Not linked", detail: "No Zoho project set for this site" };
  }

  try {
    const portal = await resolvePortal(settings);
    const emailMap = await getUserEmailMap(settings, portal.id);
    const raw = await fetchAllTasks(settings, portal.id, zoho.projectIds);

    const now = Date.now();
    let todo = 0, inProgress = 0, done = 0, overdue = 0;
    const lists = new Map(); // tasklist name -> { name, active, done }
    const detailed = [];

    for (const t of raw) {
      const m = mapTask(t, now, emailMap);
      if (m.done) done++;
      else if (m.statusType === "open" && !(t.percent_complete && Number(t.percent_complete) > 0)) todo++;
      else inProgress++;
      if (m.overdue) overdue++;

      const lentry = lists.get(m.list) || { name: m.list, active: 0, done: 0 };
      if (m.done) lentry.done++; else lentry.active++;
      lists.set(m.list, lentry);
      detailed.push(m);
    }

    const active = todo + inProgress;
    const byList = [...lists.values()].sort((a, b) => b.active - a.active);
    detailed.sort((a, b) => (a.done - b.done) || ((a.dueMs || Infinity) - (b.dueMs || Infinity)));

    const label = active > 0 ? `${active} open` : (done > 0 ? "All clear" : "No tasks");
    const parts = [];
    if (todo) parts.push(`${todo} to-do`);
    if (inProgress) parts.push(`${inProgress} in progress`);
    if (done) parts.push(`${done} done`);
    if (overdue) parts.push(`⚠ ${overdue} overdue`);

    const url = `${webBase(settings.dc)}/portal/${encodeURIComponent(portal.name)}`;

    return {
      status: "info",
      label,
      detail: parts.join(" · ") || "No tasks in scope",
      meta: { active, todo, inProgress, done, overdue, total: raw.length, byList, spaceUrl: url, tasks: detailed },
    };
  } catch (err) {
    if (err.message === "AUTH") return { status: "fail", label: "Auth failed", detail: "Zoho token rejected — check client ID/secret/refresh token" };
    return { status: "warn", label: "No data", detail: err.name === "AbortError" ? "Zoho timed out" : err.message };
  }
}

// ---- Write actions: status changes + comments ------------------------------
// Requires a refresh token with ZohoProjects.tasks.ALL (covers UPDATE + CREATE).
async function zohoPost(z, path, params) {
  const token = await getAccessToken(z);
  const res = await zfetch(`${apiBase(z.dc)}${path}`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  if (res.status === 401) { tokenCache = { token: null, expires: 0 }; throw new Error("AUTH"); }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const b = await res.json(); if (b && b.error && b.error.message) msg = b.error.message; } catch {}
    if (res.status === 403) msg += " — the Zoho token may lack write scope (regenerate with ZohoProjects.tasks.ALL)";
    throw new Error(msg);
  }
  return res.json().catch(() => ({}));
}

// Valid statuses for a project (from its task layout), cached 10 minutes.
const statusCache = new Map(); // projectId -> { list, ts }

export async function getZohoStatuses(settings, projectId) {
  if (!configured(settings)) return { ok: false, error: "Zoho API credentials not set" };
  const hit = statusCache.get(String(projectId));
  if (hit && Date.now() - hit.ts < 600000) return { ok: true, statuses: hit.list };
  try {
    const portal = await resolvePortal(settings);
    const data = await zohoGet(settings, `/restapi/portal/${portal.id}/projects/${encodeURIComponent(projectId)}/tasklayouts`);
    const list = ((data && data.status_details) || []).map((s) => ({ id: String(s.id), name: s.name, color: s.color || null, type: s.type || "open" }));
    if (!list.length) return { ok: false, error: "No statuses found for this Zoho project" };
    statusCache.set(String(projectId), { list, ts: Date.now() });
    return { ok: true, statuses: list };
  } catch (err) {
    return { ok: false, error: err.message === "AUTH" ? "Zoho token rejected" : err.message };
  }
}

export async function setZohoTaskStatus(settings, projectId, taskId, statusId) {
  if (!configured(settings)) return { ok: false, error: "Zoho API credentials not set" };
  try {
    const portal = await resolvePortal(settings);
    await zohoPost(settings, `/restapi/portal/${portal.id}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/`, { custom_status: String(statusId) });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message === "AUTH" ? "Zoho token rejected" : err.message };
  }
}

export async function addZohoComment(settings, projectId, taskId, content) {
  if (!configured(settings)) return { ok: false, error: "Zoho API credentials not set" };
  try {
    const portal = await resolvePortal(settings);
    await zohoPost(settings, `/restapi/portal/${portal.id}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/comments/`, { content });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message === "AUTH" ? "Zoho token rejected" : err.message };
  }
}

// ---- Full task detail (task modal + "My tasks" aggregation) ----
export async function getZohoTasks(zoho, settings) {
  if (!configured(settings)) return { ok: false, error: "Zoho API credentials not set" };
  if (!zoho || zoho.enabled === false || !Array.isArray(zoho.projectIds) || !zoho.projectIds.length) {
    return { ok: false, error: "No Zoho project set for this site" };
  }
  try {
    const portal = await resolvePortal(settings);
    const emailMap = await getUserEmailMap(settings, portal.id);
    const raw = await fetchAllTasks(settings, portal.id, zoho.projectIds);
    const now = Date.now();
    const tasks = raw.map((t) => mapTask(t, now, emailMap));
    tasks.sort((a, b) => (a.done - b.done) || ((a.dueMs || Infinity) - (b.dueMs || Infinity)));
    return { ok: true, tasks };
  } catch (err) {
    return { ok: false, error: err.message === "AUTH" ? "Zoho token rejected" : err.message };
  }
}
