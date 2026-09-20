-- ===========================================================================
-- Policy change: Administrator becomes the default role for the agency's teams.
--
-- Approved explicitly, and worth recording why it is safe rather than just that
-- it was asked for. This agency administers the websites it builds;
-- Administrator is the ordinary working role for its staff, not an exception.
-- Treating it as one produced a confirmation that fired on almost every
-- assignment, and a confirmation that fires on the common case is one people
-- learn to click through — which is worse than not having it.
--
-- What protects a client did NOT change:
--
--   * a website only accepts an administering role if its own administrator
--     granted the users:admin scope, and the dashboard cannot grant that;
--   * assigning one still needs an explicit confirmation before a job runs;
--   * every grant is still written to the audit log.
--
-- Only the five seeded teams are touched. A team created since is left alone —
-- whoever made it chose its default, and this migration has no business
-- overriding that. Per-user overrides are likewise untouched: someone who set
-- an individual to Editor meant it.
-- ===========================================================================

update teams
   set default_wp_role = 'administrator',
       updated_at = now()
 where slug in ('seo', 'content', 'ppc', 'web-development', 'admin')
   and default_wp_role <> 'administrator';
