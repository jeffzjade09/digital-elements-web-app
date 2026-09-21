-- 009: whether the person we invited ever actually got in.
--
-- Creating an account sends WordPress's own set-password email and then tells
-- you nothing more. Whether it was delivered, whether anyone acted on it, and
-- whether the account is still sitting there unusable were all invisible — the
-- way you found out was a colleague saying they never received anything.
--
-- Per ASSIGNMENT, not per person: an invitation is to one website. The same
-- colleague can be active on one site and still waiting on another, and a
-- single flag on staff_users could not say that.
--
-- WHAT IS NOT HERE, deliberately: no password, no hash, no reset key, no reset
-- link, no expiry of our own. WordPress owns all of that. These columns record
-- only what we did and what we could observe afterwards.

alter table website_user_assignments
  add column if not exists invite_state    text,
  add column if not exists invited_at      timestamptz,
  add column if not exists password_set_at timestamptz,
  add column if not exists invite_error    text,
  add column if not exists invite_count    integer not null default 0,
  -- Which mechanism answered "they're active": the meta our own hook stamps
  -- when a reset completes, or — for accounts invited before that hook existed
  -- — a cleared activation key. Recorded so an inferred answer can be told
  -- apart from an observed one by whoever is debugging a specific account.
  add column if not exists activation_signal text;

alter table website_user_assignments
  drop constraint if exists website_user_assignments_invite_state_check;
alter table website_user_assignments
  add constraint website_user_assignments_invite_state_check
  check (invite_state is null or invite_state in (
    'invited',          -- created, and the site verified the email went out
    'delivery_failed',  -- created, but the site could not confirm delivery
    'pending_setup',    -- invited, and the activation key is still unused
    'activated',        -- they set their own password
    'unknown'           -- linked or pre-existing: we never invited them
  ));

alter table website_user_assignments
  drop constraint if exists website_user_assignments_activation_signal_check;
alter table website_user_assignments
  add constraint website_user_assignments_activation_signal_check
  check (activation_signal is null or activation_signal in ('meta', 'key_cleared'));

-- Sync status counts sites with undelivered invitations, so mail that is broken
-- on one site is visible rather than discovered by the person who never got an
-- email.
create index if not exists wua_invite_state_idx
  on website_user_assignments (website_id, invite_state)
  where invite_state is not null;

-- Everything already on a site before this ran was either created before we
-- recorded any of it, or linked. Either way we cannot say we invited them, and
-- guessing would put "waiting for them to set a password" next to colleagues
-- who have been working on the site for a year.
update website_user_assignments
   set invite_state = 'unknown'
 where invite_state is null;
