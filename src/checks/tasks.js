// Combines per-tool task checks (ClickUp, Zoho) into the single "Tasks"
// column shown on the dashboard. Each site can enable either tool or both.

const SOURCE_LABELS = { clickup: "ClickUp", zoho: "Zoho" };
const RANK = { skip: -1, ok: 0, info: 0, warn: 1, fail: 2 };

export function combineTaskChecks(parts) {
  const given = (parts || []).filter((p) => p && p.check);
  const real = given.filter((p) => p.check.status !== "skip");

  // Nothing linked: surface the friendliest skip we have.
  if (!real.length) {
    const c = given[0] ? given[0].check : null;
    return c ? { ...c } : { status: "skip", label: "Not linked", detail: "No task tool linked to this site" };
  }

  // Single active source: pass it through, tagged.
  if (real.length === 1) {
    const { source, check } = real[0];
    const meta = check.meta
      ? { ...check.meta, sources: [source], tasks: (check.meta.tasks || []).map((t) => ({ ...t, source })),
          links: check.meta.spaceUrl ? [{ label: SOURCE_LABELS[source] || source, url: check.meta.spaceUrl }] : [] }
      : undefined;
    return { ...check, meta };
  }

  // Merge two (or more) sources.
  let status = "info";
  const m = { active: 0, todo: 0, inProgress: 0, done: 0, overdue: 0, total: 0, byList: [], tasks: [], links: [], sources: [] };
  const details = [];

  for (const { source, check } of real) {
    if (RANK[check.status] > RANK[status]) status = check.status;
    const name = SOURCE_LABELS[source] || source;
    m.sources.push(source);
    const cm = check.meta || {};
    for (const k of ["active", "todo", "inProgress", "done", "overdue", "total"]) m[k] += Number(cm[k]) || 0;
    m.byList.push(...(cm.byList || []).map((l) => ({ ...l, source })));
    m.tasks.push(...(cm.tasks || []).map((t) => ({ ...t, source })));
    if (cm.spaceUrl) m.links.push({ label: name, url: cm.spaceUrl });
    details.push(`${name}: ${check.meta ? `${cm.active || 0} open` : check.label}`);
  }

  m.byList.sort((a, b) => b.active - a.active);
  m.tasks.sort((a, b) => (a.done - b.done) || ((a.dueMs || Infinity) - (b.dueMs || Infinity)));
  m.spaceUrl = m.links.length ? m.links[0].url : undefined; // backward compat

  const label = m.active > 0 ? `${m.active} open` : (m.done > 0 ? "All clear" : "No tasks");
  if (m.overdue) details.push(`⚠ ${m.overdue} overdue`);

  return { status, label, detail: details.join(" · "), meta: m };
}
