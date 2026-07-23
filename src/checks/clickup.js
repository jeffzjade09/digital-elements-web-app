// Pulls task counts for a site's ClickUp work and buckets them by status, with a
// per-list breakdown. Target the precise web-dev work by listIds or folderId
// (falls back to spaceId). Uses a ClickUp personal token (CLICKUP_API_TOKEN);
// the workspace id auto-detects (or set CLICKUP_TEAM_ID).
//
//   "clickup": { "enabled": true, "listIds": ["901..","901.."] }   // preferred
//   "clickup": { "enabled": true, "folderId": "901.." }            // whole folder
//   "clickup": { "enabled": true, "spaceId": "901.." }             // whole space

const API = "https://api.clickup.com/api/v2";
const TIMEOUT_MS = 20000;

let cachedTeamId = null;

async function clickupGet(path, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(API + path, {
      signal: controller.signal,
      headers: { Authorization: token, "Content-Type": "application/json" },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function resolveTeamId(token, override) {
  if (override) return override;
  if (cachedTeamId) return cachedTeamId;
  const res = await clickupGet("/team", token);
  if (!res.ok) throw new Error(`team lookup HTTP ${res.status}`);
  const data = await res.json();
  const teams = data.teams || [];
  if (!teams.length) throw new Error("no workspaces on this token");
  cachedTeamId = teams[0].id;
  return cachedTeamId;
}

// Builds the scope filter: list_ids[] (preferred), project_ids[] (folder), or space_ids[].
function scopeParams(clickup, qs) {
  if (Array.isArray(clickup.listIds) && clickup.listIds.length) {
    clickup.listIds.forEach((id) => qs.append("list_ids[]", String(id)));
    return "lists";
  }
  if (clickup.folderId) { qs.append("project_ids[]", String(clickup.folderId)); return "folder"; }
  if (clickup.spaceId)  { qs.append("space_ids[]", String(clickup.spaceId));   return "space"; }
  return null;
}

async function fetchTasks(teamId, clickup, token) {
  const tasks = [];
  for (let page = 0; page < 15; page++) {
    const qs = new URLSearchParams({ include_closed: "true", subtasks: "false", page: String(page) });
    if (!scopeParams(clickup, qs)) throw new Error("SCOPE");
    const res = await clickupGet(`/team/${teamId}/task?${qs}`, token);
    if (res.status === 401) throw new Error("AUTH");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const batch = data.tasks || [];
    tasks.push(...batch);
    if (batch.length < 100) break;
  }
  return tasks;
}

export async function checkClickUp(clickup, settings) {
  if (!settings || !settings.token) {
    return { status: "skip", label: "No token", detail: "ClickUp API token not set" };
  }
  if (!clickup || clickup.enabled === false || (!clickup.listIds && !clickup.folderId && !clickup.spaceId)) {
    return { status: "skip", label: "Not linked", detail: "No ClickUp list/folder set for this site" };
  }

  try {
    const teamId = await resolveTeamId(settings.token, settings.teamId);
    const tasks = await fetchTasks(teamId, clickup, settings.token);

    const now = Date.now();
    let todo = 0, inProgress = 0, done = 0, overdue = 0;
    const lists = new Map(); // listId -> { name, active, done }
    const detailed = [];

    for (const t of tasks) {
      const type = t.status?.type || "open";
      const isDone = type === "done" || type === "closed";
      if (isDone) done++;
      else if (type === "open") todo++;
      else inProgress++;
      const isOverdue = !isDone && t.due_date && Number(t.due_date) < now;
      if (isOverdue) overdue++;

      const lid = t.list?.id || "?";
      const lentry = lists.get(lid) || { name: t.list?.name || "List", active: 0, done: 0 };
      if (isDone) lentry.done++; else lentry.active++;
      lists.set(lid, lentry);

      detailed.push({
        name: t.name || "(untitled)",
        url: t.url || null,
        list: t.list?.name || "",
        status: t.status?.status || "",
        statusType: type,
        statusColor: t.status?.color || null,
        done: isDone,
        overdue: !!isOverdue,
        due: t.due_date ? Number(t.due_date) : null,
        priority: t.priority?.priority || null,
        priorityColor: t.priority?.color || null,
        assignees: (t.assignees || []).map((a) => a.username || a.email).filter(Boolean),
      });
    }

    const active = todo + inProgress;
    const byList = [...lists.values()].sort((a, b) => b.active - a.active);
    // Open tasks first, then by due date.
    detailed.sort((a, b) => (a.done - b.done) || ((a.due || Infinity) - (b.due || Infinity)));

    const label = active > 0 ? `${active} open` : (done > 0 ? "All clear" : "No tasks");
    const parts = [];
    if (todo) parts.push(`${todo} to-do`);
    if (inProgress) parts.push(`${inProgress} in progress`);
    if (done) parts.push(`${done} done`);
    if (overdue) parts.push(`\u26a0 ${overdue} overdue`);

    // Link to the first list when targeting lists; else to the space/folder.
    let url = `https://app.clickup.com/${teamId}/home`;
    if (Array.isArray(clickup.listIds) && clickup.listIds.length) url = `https://app.clickup.com/${teamId}/v/li/${clickup.listIds[0]}`;
    else if (clickup.spaceId) url = `https://app.clickup.com/${teamId}/v/s/${clickup.spaceId}`;

    return {
      status: "info",
      label,
      detail: parts.join(" \u00b7 ") || "No tasks in scope",
      meta: { active, todo, inProgress, done, overdue, total: tasks.length, byList, spaceUrl: url, tasks: detailed },
    };
  } catch (err) {
    if (err.message === "AUTH") return { status: "fail", label: "Auth failed", detail: "ClickUp token rejected" };
    if (err.message === "SCOPE") return { status: "skip", label: "Not linked", detail: "Set listIds, folderId, or spaceId" };
    return { status: "warn", label: "No data", detail: err.name === "AbortError" ? "ClickUp timed out" : err.message };
  }
}

/* ---- Full task detail (for the "View tasks" modal, fetched on demand) ---- */

function mapTask(t, now) {
  const type = t.status?.type || "open";
  const isDone = type === "done" || type === "closed";
  const dueMs = t.due_date ? Number(t.due_date) : null;
  return {
    id: t.id,
    listId: t.list?.id || null,
    name: t.name || "(untitled)",
    list: t.list?.name || "",
    status: t.status?.status || "",
    statusType: type,
    statusColor: t.status?.color || "#8a96ad",
    done: isDone,
    assignees: (t.assignees || []).map((a) => a.username || a.email || "").filter(Boolean),
    assigneeEmails: (t.assignees || []).map((a) => (a.email || "").toLowerCase()).filter(Boolean),
    priority: t.priority?.priority || null,
    priorityColor: t.priority?.color || null,
    dueMs,
    overdue: !isDone && dueMs && dueMs < now,
    updatedMs: t.date_updated ? Number(t.date_updated) : null,
    url: t.url || `https://app.clickup.com/t/${t.id}`,
  };
}

/* ---- Write actions: status changes + comments ---- */

async function clickupSend(path, token, method, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(API + path, {
      method,
      signal: controller.signal,
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } finally {
    clearTimeout(timer);
  }
}

// Valid statuses come from the task's list (each ClickUp list defines its own set).
export async function getClickUpStatuses(settings, listId) {
  if (!settings || !settings.token) return { ok: false, error: "ClickUp API token not set" };
  try {
    const res = await clickupGet(`/list/${encodeURIComponent(listId)}`, settings.token);
    if (res.status === 401) return { ok: false, error: "ClickUp token rejected" };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    const statuses = (data.statuses || []).map((s) => ({ id: s.status, name: s.status, color: s.color || null, type: s.type || "open" }));
    if (!statuses.length) return { ok: false, error: "No statuses found for this ClickUp list" };
    return { ok: true, statuses };
  } catch (err) { return { ok: false, error: err.message }; }
}

export async function setClickUpTaskStatus(settings, taskId, statusName) {
  if (!settings || !settings.token) return { ok: false, error: "ClickUp API token not set" };
  try {
    const res = await clickupSend(`/task/${encodeURIComponent(taskId)}`, settings.token, "PUT", { status: statusName });
    if (res.status === 401) return { ok: false, error: "ClickUp token rejected" };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
}

export async function addClickUpComment(settings, taskId, text) {
  if (!settings || !settings.token) return { ok: false, error: "ClickUp API token not set" };
  try {
    const res = await clickupSend(`/task/${encodeURIComponent(taskId)}/comment`, settings.token, "POST", { comment_text: text });
    if (res.status === 401) return { ok: false, error: "ClickUp token rejected" };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
}

export async function getClickUpTasks(clickup, settings) {
  if (!settings || !settings.token) return { ok: false, error: "ClickUp API token not set" };
  if (!clickup || clickup.enabled === false || (!clickup.listIds && !clickup.folderId && !clickup.spaceId)) {
    return { ok: false, error: "No ClickUp list/folder set for this site" };
  }
  try {
    const teamId = await resolveTeamId(settings.token, settings.teamId);
    const raw = await fetchTasks(teamId, clickup, settings.token);
    const now = Date.now();
    const tasks = raw.map((t) => mapTask(t, now));
    // Active first, then earliest due; done tasks last.
    tasks.sort((a, b) => (a.done - b.done) || ((a.dueMs || Infinity) - (b.dueMs || Infinity)));
    return { ok: true, tasks };
  } catch (err) {
    return { ok: false, error: err.message === "AUTH" ? "ClickUp token rejected" : err.message };
  }
}
