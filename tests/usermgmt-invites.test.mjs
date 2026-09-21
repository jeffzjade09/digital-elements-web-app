// Whether the person we invited ever actually got in.
//
// Creating an account sends WordPress's set-password email and then tells you
// nothing. The failure this prevents is quiet: a colleague waits for a message
// that was never delivered, and nobody finds out until they say so.
//
// What is asserted here is mostly restraint. We may record what we did and what
// we observed; we may not invent an "activated" we cannot see, we may not hold
// a password or a reset key, and we may not mail somebody repeatedly because a
// button is easy to press.

import crypto from "node:crypto";

import {
  deriveInviteState, resendAllowed, inviteLabel, noResendReason,
  INVITE, SIGNAL, RESEND_MAX, RESEND_ACTION,
} from "../src/usermgmt/invites.js";

let fail = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${!cond && extra ? "  (" + extra + ")" : ""}`);
  if (!cond) fail++;
};
const eq = (label, a, b) => ok(label, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const row = (over = {}) => ({ id: "a1", invite_state: INVITE.INVITED, activation_signal: null, ...over });
const seen = (over = {}) => ({
  created_by_us: true, password_set_at: null, activation_pending: true, present: true, ...over,
});

/* ------------------------------------------------------------ the states */

console.log("--- invited, and the link is still outstanding ---");
const waiting = deriveInviteState(row(), seen());
eq("waiting for them", waiting.state, INVITE.PENDING_SETUP);
eq("no activation signal yet", waiting.signal, null);

console.log("\n--- they set a password: observed ---");
const observed = deriveInviteState(row({ invite_state: INVITE.PENDING_SETUP }),
                                   seen({ password_set_at: 1790000000, activation_pending: false }));
eq("active", observed.state, INVITE.ACTIVATED);
eq("...observed by our own hook", observed.signal, SIGNAL.META);
ok("...with when it happened", observed.passwordSetAt.startsWith("2026-"), observed.passwordSetAt);

console.log("\n--- they set a password: inferred ---");
// For accounts invited before the hook existed. WordPress clears the activation
// key when a reset completes — weaker evidence than the above, which is exactly
// why the signal travels with the answer instead of being flattened away.
const inferred = deriveInviteState(row({ invite_state: INVITE.PENDING_SETUP }),
                                   seen({ activation_pending: false }));
eq("active", inferred.state, INVITE.ACTIVATED);
eq("...inferred from the cleared key", inferred.signal, SIGNAL.KEY_CLEARED);
eq("...with no timestamp we can honestly give", inferred.passwordSetAt, null);
ok("the two signals are distinguishable", observed.signal !== inferred.signal);

console.log("\n--- delivery failed ---");
const undelivered = deriveInviteState(row({ invite_state: INVITE.DELIVERY_FAILED }), seen());
// "Waiting for them" would be a lie about a message that was never sent, and
// it is the exact sentence that hides this failure.
eq("it stays delivery_failed, not 'waiting'", undelivered.state, INVITE.DELIVERY_FAILED);

console.log("\n--- an account we merely linked ---");
const linked = deriveInviteState(row({ invite_state: null }), seen({ created_by_us: false }));
eq("unknown", linked.state, INVITE.UNKNOWN);
// Even if it looks unset up. The account is the website's own; we never invited
// them, and the reset route refuses it for the same reason.
eq("even with a key outstanding",
   deriveInviteState(row({ invite_state: null }), seen({ created_by_us: false, activation_pending: true })).state,
   INVITE.UNKNOWN);
eq("even with a password_set_at we happened to stamp",
   deriveInviteState(row(), seen({ created_by_us: false, password_set_at: 1790000000 })).state,
   INVITE.UNKNOWN);

console.log("\n--- a cleared key on an account we never invited proves nothing ---");
// Without a prior invitation there is nothing for a cleared key to be evidence
// OF, so it must not read as "activated".
eq("no invitation, no activation",
   deriveInviteState(row({ invite_state: null }), seen({ activation_pending: false })),
   null);

console.log("\n--- we could not ask ---");
eq("a failed lookup changes nothing", deriveInviteState(row(), null), null);

console.log("\n--- an older plugin that reports neither field ---");
// Leaving the state alone is the honest answer: we did not learn anything.
eq("nothing is inferred from silence",
   deriveInviteState(row(), { present: true, created_by_us: undefined, activation_pending: undefined }),
   null);

/* ------------------------------------------------------------ the wording */

console.log("\n--- plain words, shared by both screens ---");
eq("invited", inviteLabel(INVITE.INVITED), "Invitation sent");
eq("pending", inviteLabel(INVITE.PENDING_SETUP), "Waiting for them to set a password");
eq("failed", inviteLabel(INVITE.DELIVERY_FAILED), "Email couldn't be delivered — resend");
eq("activated", inviteLabel(INVITE.ACTIVATED), "Active");
const labels = Object.values(INVITE).map(inviteLabel);
eq("one sentence per state", new Set(labels).size, labels.length);
ok("none of them is jargon", !labels.some((l) => /_|null|undefined/.test(l)), labels.join(" | "));

console.log("\n--- an absent Resend button explains itself ---");
const why = noResendReason(INVITE.UNKNOWN);
ok("unknown says why there is no button", typeof why === "string" && why.length > 0);
ok("...and names what they can do instead", why.includes("Lost your password?"), why);
for (const state of [INVITE.INVITED, INVITE.PENDING_SETUP, INVITE.DELIVERY_FAILED, INVITE.ACTIVATED]) {
  eq(`${state} needs no explanation`, noResendReason(state), null);
}

/* ------------------------------------------------------- database-backed */

if (!process.env.DATABASE_URL) {
  console.log("\nSKIP  the rate limit, resend audit rows and reconciliation carrying the fields (no DATABASE_URL)");
  console.log(fail ? `${fail} assertion(s) failed` : "All assertions passed");
  process.exit(fail ? 1 : 0);
}

const db = await import("../src/db.js");
const { recordInvite, applyInviteState, inviteSummary } = await import("../src/usermgmt/invites.js");

const tag = crypto.randomBytes(3).toString("hex");
const made = { staff: [], websites: [] };

try {
  const site = await db.query(
    "insert into websites (name, url, helper_enabled, license_key) values ($1,$2,true,$3) returning id, name",
    [`Invite ${tag}`, `https://invite-${tag}.test`, `DEG-INVIT-${tag.toUpperCase()}-AAAA-BBBB`]
  );
  made.websites.push(site.rows[0].id);
  const websiteId = site.rows[0].id;

  const staff = await db.query(
    "insert into staff_users (email) values ($1) returning id", [`invitee-${tag}@digitalelementsgroup.com`]);
  made.staff.push(staff.rows[0].id);
  const staffUserId = staff.rows[0].id;

  await db.query(
    `insert into website_user_assignments (staff_user_id, website_id, wp_role, wp_user_id, state, managed)
     values ($1,$2,'editor',77,'synced',true)`,
    [staffUserId, websiteId]
  );

  const read = async () => {
    const { rows } = await db.query(
      "select * from website_user_assignments where staff_user_id=$1 and website_id=$2",
      [staffUserId, websiteId]);
    return rows[0];
  };

  console.log("\n--- what a create records ---");
  await recordInvite({ staffUserId, websiteId, delivered: true });
  let a = await read();
  eq("invited", a.invite_state, INVITE.INVITED);
  ok("...with when", a.invited_at !== null);
  eq("...counted once", a.invite_count, 1);
  ok("...and nothing about a password", a.password_set_at === null);

  console.log("\n--- a create whose email could not be confirmed ---");
  await recordInvite({ staffUserId, websiteId, delivered: false, error: "mail_failed" });
  a = await read();
  eq("delivery_failed", a.invite_state, INVITE.DELIVERY_FAILED);
  eq("...with the reason", a.invite_error, "mail_failed");
  eq("...counted again", a.invite_count, 2);

  console.log("\n--- then they set a password ---");
  await applyInviteState(a.id, deriveInviteState(a, seen({ password_set_at: 1790000000, activation_pending: false })));
  a = await read();
  eq("activated", a.invite_state, INVITE.ACTIVATED);
  eq("...by the observed signal", a.activation_signal, SIGNAL.META);
  ok("...with the time recorded", a.password_set_at !== null);

  console.log("\n--- a resend clears it again ---");
  // A fresh link means they have not used THIS one, whatever they did with the
  // last — so a stale "active" must not survive it.
  await recordInvite({ staffUserId, websiteId, delivered: true, resend: true });
  a = await read();
  eq("back to invited", a.invite_state, INVITE.INVITED);
  eq("...with the old activation forgotten", a.password_set_at, null);
  eq("...and the signal cleared", a.activation_signal, null);
  eq("...counted", a.invite_count, 3);

  console.log("\n--- the rate limit ---");
  const clean = await resendAllowed(staffUserId, websiteId);
  ok("nothing sent recently, so it is allowed", clean.allowed);
  eq("...with the full allowance", clean.remaining, RESEND_MAX);

  const auditResend = (result = "ok") => db.query(
    `insert into audit_log (action, entity_type, entity_id, website_id, result)
     values ($1,'staff_user',$2,$3,$4)`,
    [RESEND_ACTION, staffUserId, websiteId, result]
  );

  for (let i = 1; i <= RESEND_MAX; i++) {
    await auditResend();
    const gate = await resendAllowed(staffUserId, websiteId);
    if (i < RESEND_MAX) ok(`${i} sent, still allowed`, gate.allowed, JSON.stringify(gate));
    else {
      ok(`${RESEND_MAX} sent, now refused`, gate.allowed === false, JSON.stringify(gate));
      ok("...and says how long to wait", gate.retryAfterMs > 0);
    }
  }

  // Failures must not count: refusing to resend because earlier attempts failed
  // would lock someone out of the fix for the problem they are fixing.
  await db.query("delete from audit_log where action = $1 and entity_id = $2", [RESEND_ACTION, staffUserId]);
  for (let i = 0; i < RESEND_MAX + 2; i++) await auditResend("failed");
  const afterFailures = await resendAllowed(staffUserId, websiteId);
  ok("failed sends do not consume the allowance", afterFailures.allowed);
  eq("...none of them", afterFailures.remaining, RESEND_MAX);

  // And it is per person per site, not global.
  const other = await db.query(
    "insert into staff_users (email) values ($1) returning id", [`invitee2-${tag}@digitalelementsgroup.com`]);
  made.staff.push(other.rows[0].id);
  await db.query("delete from audit_log where action = $1 and entity_id = $2", [RESEND_ACTION, staffUserId]);
  for (let i = 0; i < RESEND_MAX; i++) await auditResend();
  ok("one person being capped does not cap another",
     (await resendAllowed(other.rows[0].id, websiteId)).allowed);

  console.log("\n--- what Sync status is told ---");
  const summary = (await inviteSummary()).get(websiteId);
  ok("counts for this site exist", !!summary, JSON.stringify(summary));
  eq("the invitation we last recorded is counted", summary.invited, 1);

  console.log("\n--- nothing about a password or a key is ever stored ---");
  // The whole database, not just the columns this feature added: if a reset key
  // or a password reached a column anywhere, this is where it would show.
  const { rows: cols } = await db.query(
    `select table_name, column_name from information_schema.columns
      where table_schema = 'public'
        and (column_name ~* 'pass|pwd|secret|activation|reset')`
  );
  const unexpected = cols.filter((c) =>
    // The site credential is encrypted at rest and predates this; the two
    // invitation columns are a timestamp and a state name.
    !(c.table_name === "websites" && c.column_name === "um_secret_enc")
    && !(c.column_name === "password_set_at")
    && !(c.column_name === "activation_signal")
  );
  eq("no column holds a password, a hash or a reset key", unexpected.length, 0,
     unexpected.map((c) => `${c.table_name}.${c.column_name}`).join(", "));
} finally {
  for (const id of made.staff) {
    await db.query("delete from audit_log where entity_id = $1", [id]);
    await db.query("delete from staff_users where id = $1", [id]);
  }
  for (const id of made.websites) {
    await db.query("delete from audit_log where website_id = $1", [id]);
    await db.query("delete from websites where id = $1", [id]);
  }
}

console.log(fail ? `\n${fail} assertion(s) failed` : "\nAll assertions passed");
process.exit(fail ? 1 : 0);
