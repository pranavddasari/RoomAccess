# Supabase authentication and club membership setup

Authentication and membership are configured by this guide. The subsequent shared
operational milestone is implemented: follow [SUPABASE_OPERATIONAL_SETUP.md](SUPABASE_OPERATIONAL_SETUP.md)
for its forward-only migrations, private photos and retention deployment. Preserve
all existing Auth users, membership records and identity links. No credentials are
included in this repository.

## 1. Create and migrate

1. Create a Supabase project and save its database password privately.
2. Run `supabase/migrations/202610050001_membership.sql` in the project's SQL
   Editor as the project owner, or apply it using your Supabase CLI migration
   workflow. Run once on a fresh project. It is transactional; no operational
   tables or storage buckets are created.
3. In Authentication → Providers enable Google. Disable Email (password/OTP),
   phone, anonymous sign-in and every other provider. Leave manual identity
   linking disabled. OAuth users may be created so preauthorized members can
   sign in for the first time. There is no club self-registration endpoint.

## 2. Google Cloud and Supabase provider

1. Create/select a Google Cloud project. Under Google Auth Platform configure
   Branding, Audience and Data Access (email, profile, openid). Choose an audience
   supported by your institution/project; configure test users if in testing mode,
   and complete consent/publishing requirements before the full club uses it.
2. Create a Web application OAuth client.
3. Add authorized JavaScript origins: `http://localhost:5173` and later
   `https://YOUR_PRODUCTION_HOST`. Origins have no path.
4. Add the exact authorized redirect URI shown by Supabase's Google provider:
   `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`.
   This Google callback is different from the app's redirect URL.
5. Put the Google client ID and client secret in Supabase's Google provider
   configuration. The secret never goes in Vite, Git or the frontend.
6. In Supabase Authentication → URL Configuration set Site URL to
   `http://localhost:5173` while developing. Allow redirect
   `http://localhost:5173/`. On production set Site URL to
   `https://YOUR_PRODUCTION_HOST` and allow `https://YOUR_PRODUCTION_HOST/`.
   Use explicit trusted URLs, not broad production wildcards.

Official references: [Google OAuth setup](https://supabase.com/docs/guides/auth/social-login/auth-google)
and [redirect URL configuration](https://supabase.com/docs/guides/auth/redirect-urls).

## 3. Enable the mandatory domain hook

In Authentication → Hooks add a **Before User Created** Postgres hook and select
`public.before_user_created`. Enable/save it. The migration grants execution only
to `supabase_auth_admin` and revokes browser access. Do not skip this dashboard step:
creating the function does not automatically activate the hook.

The hook rejects non-Google providers and any email outside the exact
`@vitstudent.ac.in` domain. An unknown valid VIT student can authenticate, but
cannot enter the app without an ACTIVE membership. No request, notification or
pending list is created.

Every membership RPC and RLS read also validates Auth-owned `auth.users` and
`auth.identities`: confirmed email, verified Google identity with matching email,
exact domain, and Google's provider in server-signed app metadata. It never trusts
editable user metadata or a role stored in the browser. Existing invalid users
remain unusable even if they were created before the hook was enabled. Google
OAuth's `hd` parameter is only a chooser hint, not domain enforcement.

[Before User Created hook documentation](https://supabase.com/docs/guides/auth/auth-hooks/before-user-created-hook).

## 4. Frontend environment

1. Find the Project URL in the project's Connect/API settings.
2. Find the **publishable key** (`sb_publishable_…`) in API Keys.
3. Copy `.env.example` to `.env.local` and set:

   ```dotenv
   VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
   VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_YOUR_PUBLIC_KEY
   ```

4. Run `npm install` then `npm run dev`. Restart Vite after environment changes.
   `.env.local` is ignored by the existing `*.local` Git rule. Publishable keys
   are intended for browsers; secret/service_role keys must never be used here.
   Missing/invalid configuration produces a setup error instead of loading rooms.

## 5. Bootstrap the first administrator

Use the trusted SQL Editor, replacing these placeholders with your actual verified
VIT student Google email and name:

```sql
insert into public.club_members (name, email, role, status)
values ('YOUR NAME', 'your.email@vitstudent.ac.in', 'ADMIN', 'ACTIVE');
```

No public first-admin endpoint exists. Bootstrap is audited as MEMBER_ADDED with
NULL actor (trusted SQL, no authenticated app user). Sign in through Continue with
Google with that exact email. The protected RPC links `auth.uid()` to the existing
row. It does not create a membership or accept an email/user ID from the browser.
An existing link to another Auth ID produces a safe conflict denial. Disabled rows
are not linked. Email uniqueness and Auth ID uniqueness are enforced.

From now on manage the roster through Admin → Members:

- Add Person → name, VIT email, Member → Add. This inserts an ACTIVE membership
  without creating an Auth user. Duplicate emails and invalid domains are rejected.
- Add Person → name, VIT email, Admin → Add to preauthorize another administrator.
- Make Admin / Make Member → review confirmation → Confirm.
- Disable / Re-enable → review confirmation → Confirm. Membership and history persist.

Members offers search and All/Members/Admins/Disabled filters for the full roster.
Role and status changes refresh your own authorization immediately. Other open
clients refresh on focus, auth changes and every minute; database permissions use
live membership on every request, independent of JWT role caching. Sign Out clears
the local Supabase session and does not delete shared operational records.

## 6. Security and database verification

`club_members` has UUID id, unique normalized email, name, unique nullable
`auth_user_id`, MEMBER/ADMIN role, ACTIVE/DISABLED status, created/updated timestamps
and creator/updater Auth IDs. Browser writes are revoked completely. The only
write RPCs are `add_club_member` and `change_club_member`; they require a live ACTIVE
ADMIN identity, including for self-changes. RPC arguments cannot override actor,
identity link, creation timestamps or audit facts.

RLS permits ACTIVE members to read their own row, and ACTIVE admins to read the
roster and membership audit. Unknown/disabled users get no rows. An active member
can use `member_directory` to read only ACTIVE IDs/names for key transfers.
Roles/emails are not exposed by that directory. `authorize_membership` returns
only the caller's verified matching membership. All definer functions use empty
search paths and fully qualified tables. Internal write functions are not callable
by browsers. Audit rows are append-only to browser roles, including admins.

MEMBER_ADDED, ROLE_CHANGED, MEMBER_DISABLED and MEMBER_ENABLED store target,
actor, time and before/after snapshots. Linking only updates identity metadata;
it never silently changes a role. No hard deletion is available. Database owners
can alter policies as with any database; keep project owner/service credentials
private.

A singleton row update serializes all membership writes **before** reading live
admin authority. A trigger rejects the final ACTIVE admin's demotion/disable and
all membership deletion, including trusted SQL updates. At higher isolation,
conflicting writes abort with serialization failure. Never retry a failed change
without rechecking live authorization. The singleton serializes first-login
linking too; this is acceptable for a club of ~200 people.

Tests run the actual migration with PostgreSQL via PGlite, using a minimal Auth
schema fixture. `npm test` covers grants/RLS, linking, hooks, roles, last-admin
checks, audit immutability and existing room transitions. Browser tests use an
isolated fake Supabase API to exercise UI only; real Google OAuth must still be
verified against your configured project.

## 7. Manual acceptance checks with actual Google accounts

1. First admin: login, account display, Admin navigation and Members roster.
2. Add one Member and one Admin before either has ever signed in.
3. Member: login, receive a key and use room flows; no Admin navigation. A direct
   database role update or admin RPC must fail. Refresh/reopen keeps their identity.
4. Admin: existing Overview/Flags/History/corrections plus Members available.
5. Unknown VIT account: board-contact message and Sign Out only; no membership added.
6. Non-VIT account: domain denial. For an existing invalid account the database
   identity check must deny authorization even though the creation hook does not rerun.
7. Disabled account: board-contact disabled message; no directory or roster access.
8. Promote/demote, disable/re-enable; verify snapshots in membership_audit and
   authorization changes on focus/within one minute. Test last-admin failure.
9. Sign Out: login returns; shared operational records remain. Use a 390px viewport
   and confirm there is no protected Admin flash or browser console error.

## 8. Later Vercel deployment

Add both `VITE_SUPABASE_*` environment variables in Vercel for the intended
environment and rebuild/redeploy. Vite embeds these at build time. Update Supabase
Site URL and allowed app redirects; add the production origin to the Google client.
The Google redirect remains the Supabase callback. Configure preview redirects
only for trusted previews that you intend to allow. This milestone does not deploy
or push anything.

Shared operational database/photo setup: see [operational guide](SUPABASE_OPERATIONAL_SETUP.md) and [architecture](ARCHITECTURE.md).

## Reproduce local checks

```sh
npm test
npm run build
npm run test:browser
PG_BIN=/path/to/postgresql/bin node tests/membership-concurrency.mjs
```

Browser tests default to installed Google Chrome on macOS. For other systems set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to a Chromium/Chrome executable. Their fake
API and sample credentials exist only in the Playwright configuration; normal
runtime has no demo-auth bypass. The optional concurrency test requires installed
PostgreSQL binaries and runs two connections against a disposable temporary
cluster, then stops and removes it. It must never be pointed at your real project.
