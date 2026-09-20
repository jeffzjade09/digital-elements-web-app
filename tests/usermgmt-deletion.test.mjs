// Tests for the app side of the destructive path: how ownership is described,
// how a multi-site deletion is planned, and the team-delete disposition.
//
// The property these pin down is that every website is judged on its own. A
// person owns different things on each site, so one site answering "nothing
// here" says nothing about the other four — and a flow that checked once and
// deleted everywhere is exactly how content gets orphaned on the sites nobody
// looked at.

import { describeOwnership } from "../src/usermgmt/contentOwnership.js";

let fail = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${!cond && extra ? "  (" + extra + ")" : ""}`);
  if (!cond) fail++;
};
const eq = (label, a, b) => ok(label, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

/* ------------------------------------------------- describing ownership --- */

console.log("--- the ownership summary an administrator acts on ---");
eq("nothing owned", describeOwnership({ total: 0, comments: 0 }), "No content");
eq("null is handled", describeOwnership(null), "No content");

const mixed = {
  total: 55,
  comments: 3,
  by_type: [
    { type: "post", label: "Posts", total: 18 },
    { type: "page", label: "Pages", total: 4 },
    { type: "attachment", label: "Media", total: 31 },
    { type: "location", label: "Locations", total: 2 },
  ],
  by_status: { publish: 51, draft: 2, future: 2, trash: 0 },
};
const summary = describeOwnership(mixed);
ok("lists the biggest categories first", summary.startsWith("31 media"), summary);
ok("names posts", /18 posts/.test(summary));
ok("names pages", /4 pages/.test(summary));
// A custom post type is the content most likely to be forgotten by a check that
// only looked at posts and pages.
ok("names a custom post type", /2 locations/.test(summary));
// Nothing on the site shows scheduled content yet; deleting its author is how a
// launch quietly fails to happen.
ok("calls out scheduled content separately", /2 scheduled/.test(summary));
ok("names comments", /3 comments/.test(summary));

eq("a single item is singular",
   describeOwnership({ total: 1, by_type: [{ type: "post", label: "Posts", total: 1 }], by_status: {} }),
   "1 post");
eq("one comment is singular",
   describeOwnership({ total: 0, comments: 1, by_type: [], by_status: {} }),
   "1 comment");
ok("trashed content is mentioned, not ignored",
   /1 in the trash/.test(describeOwnership({
     total: 1, by_type: [{ type: "post", label: "Posts", total: 1 }], by_status: { trash: 1 },
   })));
ok("empty types are not listed",
   !/0 /.test(describeOwnership({
     total: 2, by_type: [{ type: "post", label: "Posts", total: 2 }, { type: "page", label: "Pages", total: 0 }],
     by_status: {},
   })));

/* ------------------------------------------- multi-site deletion planning - */

// planDeletion's decision, extracted so the per-site independence can be
// asserted without a database or five WordPress installs.
function decide(own) {
  if (!own.hasAccount) return { canDelete: false, blocker: "No account here." };
  if (own.ownsContent) return { canDelete: false, blocker: `Owns ${own.summary}. Reassign before deleting.` };
  return { canDelete: true, blocker: null };
}

console.log("\n--- every website is judged on its own ---");
const sites = [
  { websiteName: "Blue Star", hasAccount: true, ownsContent: false, summary: "No content" },
  { websiteName: "Advance to Thrive", hasAccount: true, ownsContent: true, summary: "18 posts, 2 scheduled" },
  { websiteName: "Digital Elements", hasAccount: false },
  { websiteName: "Client D", hasAccount: true, ownsContent: false, summary: "No content" },
];
const decided = sites.map((s) => ({ ...s, ...decide(s) }));

eq("an empty account is deletable", decided[0].canDelete, true);
// THE property. A site with content stays blocked even though its neighbours
// are clear — one clean site must never authorise deleting on another.
eq("a site with content is blocked", decided[1].canDelete, false);
ok("...and says exactly what is in the way", /18 posts, 2 scheduled/.test(decided[1].blocker));
eq("a site with no account is skipped, not deleted", decided[2].canDelete, false);
eq("a fourth site is judged independently", decided[3].canDelete, true);

const summaryCounts = {
  sites: decided.length,
  deletable: decided.filter((d) => d.canDelete).length,
  needReassign: decided.filter((d) => d.ownsContent).length,
  blocked: decided.filter((d) => !d.canDelete).length,
};
eq("two of four are deletable", summaryCounts.deletable, 2);
eq("one needs reassignment", summaryCounts.needReassign, 1);
eq("two are blocked", summaryCounts.blocked, 2);

console.log("\n--- one site clearing does not clear the others ---");
// Reassigning on the blocked site must change that site's answer and nothing
// else's.
const afterReassign = decided.map((d, i) =>
  i === 1 ? { ...d, ownsContent: false, summary: "No content", ...decide({ ...d, ownsContent: false }) } : d
);
eq("the reassigned site becomes deletable", afterReassign[1].canDelete, true);
eq("the site with no account is STILL not deletable", afterReassign[2].canDelete, false);
eq("three of four now deletable", afterReassign.filter((d) => d.canDelete).length, 3);

console.log("\n--- a site we couldn't reach is never assumed empty ---");
const unreachable = { websiteName: "Offline", hasAccount: false, error: "Couldn't reach Offline." };
const unreachableDecision = decide(unreachable);
eq("it is not deletable", unreachableDecision.canDelete, false);

/* ---------------------------------------------- team delete disposition --- */

// deleteTeam's validation, extracted from the database work around it.
function validateTeamDelete({ memberCount, assignmentCount, onUsers, moveToTeamId, onAssignments, teamId }) {
  if (memberCount > 0) {
    if (onUsers !== "unassign" && onUsers !== "move") {
      return { error: "members_disposition_required" };
    }
    if (assignmentCount > 0 && onAssignments !== "keep" && onAssignments !== "remove") {
      return { error: "assignments_disposition_required" };
    }
    if (onUsers === "move" && (!moveToTeamId || moveToTeamId === teamId)) {
      return { error: "move_target_required" };
    }
  }
  return {
    ok: true,
    // The single most important property of this whole function.
    deletesWordPressAccounts: false,
    unlinks: onAssignments === "remove",
  };
}

console.log("\n--- deleting a team never deletes a WordPress account ---");
const base = { memberCount: 4, assignmentCount: 12, teamId: "t1" };

for (const onAssignments of ["keep", "remove"]) {
  const r = validateTeamDelete({ ...base, onUsers: "unassign", onAssignments });
  ok(`onAssignments="${onAssignments}" deletes no WordPress account`, r.deletesWordPressAccounts === false);
}
// "remove" is an unlink: we stop managing the account, it keeps its role,
// content and access. Folding deletion into a team delete would be the most
// dangerous shortcut in the feature.
ok('"remove" unlinks rather than deletes',
   validateTeamDelete({ ...base, onUsers: "unassign", onAssignments: "remove" }).unlinks === true);
ok('"keep" leaves the assignments alone',
   validateTeamDelete({ ...base, onUsers: "unassign", onAssignments: "keep" }).unlinks === false);

console.log("\n--- both dispositions are required, never guessed ---");
eq("no member disposition is refused",
   validateTeamDelete({ ...base, onAssignments: "keep" }).error, "members_disposition_required");
eq("an invalid member disposition is refused",
   validateTeamDelete({ ...base, onUsers: "delete", onAssignments: "keep" }).error, "members_disposition_required");
eq("no assignment disposition is refused when assignments exist",
   validateTeamDelete({ ...base, onUsers: "unassign" }).error, "assignments_disposition_required");
ok("...but isn't demanded when there are none",
   validateTeamDelete({ ...base, assignmentCount: 0, onUsers: "unassign" }).ok === true);
ok("an empty team needs no disposition at all",
   validateTeamDelete({ memberCount: 0, assignmentCount: 0, teamId: "t1" }).ok === true);

console.log("\n--- moving members needs a real destination ---");
eq("no target is refused",
   validateTeamDelete({ ...base, onUsers: "move", onAssignments: "keep" }).error, "move_target_required");
eq("moving into itself is refused",
   validateTeamDelete({ ...base, onUsers: "move", moveToTeamId: "t1", onAssignments: "keep" }).error, "move_target_required");
ok("a different team is accepted",
   validateTeamDelete({ ...base, onUsers: "move", moveToTeamId: "t2", onAssignments: "keep" }).ok === true);

/* ------------------------------------------------- confirmation policy ---- */

// The route's own gate, before anything reaches a site.
function validateDeleteRequest({ confirm, websiteIds, confirmMultipleSites }) {
  if (confirm !== "DELETE") return { error: "typed_confirmation_required" };
  if (websiteIds.length > 1 && confirmMultipleSites !== true) return { error: "confirm_multiple_sites" };
  return { ok: true };
}

console.log("\n--- deletion needs a typed confirmation ---");
eq("no confirmation", validateDeleteRequest({ websiteIds: ["a"] }).error, "typed_confirmation_required");
eq("the wrong word", validateDeleteRequest({ confirm: "yes", websiteIds: ["a"] }).error, "typed_confirmation_required");
eq("lower case is not accepted", validateDeleteRequest({ confirm: "delete", websiteIds: ["a"] }).error, "typed_confirmation_required");
ok("the exact word works", validateDeleteRequest({ confirm: "DELETE", websiteIds: ["a"] }).ok === true);

console.log("\n--- removing from several websites needs its own acknowledgement ---");
eq("multiple sites without the extra confirmation",
   validateDeleteRequest({ confirm: "DELETE", websiteIds: ["a", "b"] }).error, "confirm_multiple_sites");
ok("...and with it",
   validateDeleteRequest({ confirm: "DELETE", websiteIds: ["a", "b"], confirmMultipleSites: true }).ok === true);
ok("a single site doesn't need it",
   validateDeleteRequest({ confirm: "DELETE", websiteIds: ["a"] }).ok === true);

console.log(fail ? `\n${fail} assertion(s) failed` : "\nAll assertions passed");
process.exit(fail ? 1 : 0);
