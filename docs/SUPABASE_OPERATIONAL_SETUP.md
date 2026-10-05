# Shared operational data setup

This is a forward-only update to the existing Supabase project. Preserve Auth,
club_members, membership_audit, their policies and identity links. No demo history
is imported. The implementation is local until you apply migrations and deploy
the cleanup function. No new browser secret is required.

## 1. Back up and migrate

1. Save a database backup before production schema changes. Record the current
   deployed frontend commit and your applied migration history.
2. Apply `supabase/migrations/202610060001_operations.sql`, then
   `supabase/migrations/202610060002_retention.sql`, using the trusted SQL Editor
   or your normal Supabase CLI migration workflow. Do not rerun the membership
   migration or rebuild the project. Each migration is transactional; run each once.
3. Confirm `select display_name from public.rooms order by display_name` returns
   exactly MR-1 through MR-5. These are placeholder labels, not real room numbers.
4. Confirm `room_key_state` has no seeded rows. Its absence means uninitialized.
   Sign in with the existing real Admin account → Admin → Overview → Correct
   Custody on each room. Physically verify the holder first, choose Member/SW/MHO,
   enter a reason, and confirm. Never assume that a key is at SW.
5. A member cannot start or claim an uninitialized key. The interface displays
   "Key status not initialized" until an administrator records physical custody.

## 2. Bucket and Storage policies

The operational migration creates/configures one bucket `session-photos`:

- private, never public;
- JPEG only;
- hard object limit 512,000 bytes (approximately 500 KB);
- unique paths `AUTH_UUID/SESSION_UUID/START_OR_END/CATEGORY-PHOTO_UUID.jpg`;
- INSERT only for a live ACTIVE member's registered, unexpired own upload intent;
- SELECT only for accepted evidence belonging to the caller's session or a live
  ACTIVE ADMIN; no bucket-wide member reads or unattached-draft reads;
- no browser UPDATE/DELETE policy, no overwriting evidence.

Review Storage → session-photos and Storage policies after migration. Restrictive
guards additionally protect this bucket against unrelated broad permissive policies
(which combine with OR). Anonymous access and browser historical overwrite/deletion
remain denied even with a broad policy on another application. Other buckets keep
their own policies. Avoid generic unrestricted policies and verify the deployed rules.

Photo acceptance compresses the original in memory using canvas JPEG encoding,
constraining the long edge to 1600 px, targeting <=350,000 bytes, and enforcing
512,000 bytes. High-entropy images reduce quality/dimensions further if necessary.
Smaller images are kept smaller. Original files are never uploaded. Decode or
compression failures keep the requirement incomplete. Use Photo displays a saving
state; upload failures preserve the candidate for retry. Retakes use new paths.

START images upload before session creation; the START transaction validates both
owned Storage objects against the intended session/stage/category. Abandoned
images become orphans. END images attach immediately to an ACTIVE session; partial
accepted evidence survives refresh and recovery. Terminal evidence cannot be
replaced. The database checks object ownership, MIME metadata and byte size against
Storage; client-reported dimensions are bounded metadata, not an image decoder on
the server. No AI or image-content analysis is performed.

Admin View Details → View Photo downloads through authenticated Storage RLS into
an ephemeral object URL; no public or permanent signed URL is generated. Sign-out
unmounts the viewer and revokes its object URL. Member session evidence has the
same ownership restriction at Storage, regardless of UI buttons.

## 3. Shared reads, identity and transactional commands

Every critical command uses `operational_command`. The actor is derived from
Auth → verified Google identity → ACTIVE club membership, never from browser
actor fields. Names/roles are not taken from editable metadata.

Membership and operational commands serialize on the existing small-club
membership lock, then lock/revalidate the room/current custody/session. Unique
partial indexing enforces one ACTIVE session per room; multiple rooms per member
are allowed. Room versions detect old modals and competing claims. UUID operation
IDs record request/result; an identical retry returns the original result. A reused
ID with different actor/payload is rejected. All timestamps come from PostgreSQL.

Normal reads use RLS and a single MVCC snapshot RPC. Rooms/current keys/ACTIVE
session summaries are visible to ACTIVE members. Terminal sessions/photos are
owner/admin only; custody history is limited to participants/admins. Flags and
audit reads are deliberately scoped. Unknown/disabled/invalid/anonymous accounts
have no operational access. Core browser writes are revoked; mutations use RPCs.

Admin correction appends facts rather than rewriting history. Receipt recovery
preserves both website custody and reported source, closes only the affected room
INCOMPLETE, records the receiver's reason/remarks and freezes partial evidence.
Flag resolution never changes the session outcome. Keeping a key on checkout
creates no self-transfer event. Membership disable now fails while that member
holds a key or owns an ACTIVE session; resolve custody/session first. The existing
last-admin guard remains in effect.

The only Realtime publication addition is rooms. Room version/timestamp changes
prompt an authorized snapshot refetch. Configure/verify rooms in the
supabase_realtime publication (the migration adds it if that publication exists).
Refetch also occurs after success, on focus and when the app foregrounds. A visible
client uses a 30-second fallback only while Realtime is not subscribed. The
database, not the broadcast, resolves concurrency. Network errors never produce
optimistic operational success; ambiguous failures refetch and keep drafts where
possible. Stale submissions require reviewing the latest state.

## 4. Retention Edge Function

Retention is rolling **30 × 24 hours**, based on terminal `closed_at`, not calendar
midnight. ACTIVE sessions are never removed merely due to age. Membership,
membership_audit, rooms and current custody persist indefinitely. Old records
linked to retained sessions remain until that session expires, preventing broken
context for ACTIVE or recently closed sessions. There is no archive beyond this
window.

1. Install/use Supabase CLI, authenticate and link the existing project if needed.
2. Generate a strong random server-only secret locally; save it in your password
   manager. Configure it as `RETENTION_CRON_SECRET` using Dashboard → Edge Function
   Secrets or `supabase secrets set --env-file /path/to/private/server.env` where
   that file contains only `RETENTION_CRON_SECRET=YOUR_RANDOM_VALUE`. Keep the file
   outside Git. Never use VITE_ for this secret.
3. Deploy with `supabase functions deploy retention-cleanup --project-ref YOUR_REF`.
   `supabase/config.toml` disables gateway JWT verification for this function, since
   Cron uses the explicit secret header. The handler itself rejects missing/wrong
   `x-retention-secret`. A member token or publishable key cannot invoke cleanup.
4. Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to the Edge
   runtime. They are used only there, never in Vite. Verify these are available in
   your runtime; do not copy the service role into the frontend.
5. Test a non-destructive dry run from a trusted terminal:

   ```sh
   curl --fail-with-body -X POST \
     "https://YOUR_REF.supabase.co/functions/v1/retention-cleanup" \
     -H "Content-Type: application/json" \
     -H "x-retention-secret: $RETENTION_CRON_SECRET" \
     --data '{"dryRun":true}'
   ```

6. Inspect the returned plan and Edge logs. Wrong/missing secret must return 401.
   Dry run must not claim/delete any object or record. Destructive fixture tests
   run locally; do not create artificial expired fixtures in the real project.
7. When satisfied, manually invoke `{"dryRun":false}` using the same authenticated
   request. Inspect the summary and verify that current keys/members/ACTIVE
   sessions remain intact. Storage failures return 503; claims remain retryable.

The service-only retention RPCs plan paths, claim them, acknowledge successful API
removal, then finalize database deletion. A claim marks upload intents deleting,
so late attachment cannot race orphan cleanup. The Edge Function removes objects
with Storage API, never SQL DELETE on storage.objects. Only acknowledged paths
permit evidence/session deletion. Missing already-deleted objects are acceptable
Storage API retries. Batches are bounded to 200 paths, up to 12 batches/run; a
large backlog safely continues on the next run. Both live and dry runs log summaries.

Unreferenced/replaced images older than 24 hours are collected, including expired
intents where no object was ultimately uploaded. Accepted ACTIVE evidence is never
an orphan, even when old. Tombstones prevent reattachment; they are pruned after
30 days once reference cleanup is complete. Expired terminal sessions cascade
photo metadata/related events/flags/audit/idempotency records only after successful
object removal. Old standalone operational records are deleted independently.

Official references: [Edge runtime secrets](https://supabase.com/docs/guides/functions/secrets),
[Storage schema and deletion](https://supabase.com/docs/guides/storage/schema/design).

## 5. Daily Cron at 00:05 India time

Supabase's documented Cron examples use GMT. **18:35 UTC = 00:05 Asia/Kolkata on
the next local calendar day**. The source-controlled schedule uses `35 18 * * *`.
It verifies `cron.timezone` is UTC/GMT before scheduling rather than assuming the
SQL session timezone controls Cron.

1. Enable pg_cron and pg_net in Supabase if needed. Enable Vault if your project
   does not already provide it.
2. In trusted Vault administration create:
   - `music_retention_url`: `https://YOUR_REF.supabase.co/functions/v1/retention-cleanup`
   - `music_retention_secret`: the exact same value as RETENTION_CRON_SECRET.
3. Run `supabase/retention-cron.sql`. No secret values are written into that file
   or the cron command; it reads them from Vault at execution. Reusing the job
   name updates the schedule rather than creating a duplicate.
4. Check `select jobid, jobname, schedule, active from cron.job` and
   `select current_setting('cron.timezone', true)`. On non-UTC configurations stop
   and convert/verify the expression before scheduling.
5. Inspect `cron.job_run_details`, `net._http_response` and Edge Function logs.
   A successful Cron SQL invocation alone does not prove the HTTP cleanup worked;
   verify HTTP status and the summary. Retry failed/backlogged cleanup next day.

[Supabase Cron timezone examples](https://supabase.com/docs/guides/cron/quickstart)
and [scheduled Edge Functions with Vault/pg_net](https://supabase.com/docs/guides/functions/schedule-functions).

## 6. Acceptance checks on the configured project

Use the existing Admin account after applying migrations:

1. Initialize all five keys after physical verification.
2. A holds MR-1: accept both start photos → ACTIVE; accept both end photos → Keep
   Key → COMPLETE. Confirm no A→A event exists.
3. Idle transfer A→B and SW/MHO returns. Disabled/nonexistent recipients must fail.
4. A ACTIVE, partial END Room accepted: B receives key → reason/remarks → confirm.
   Confirm A becomes INCOMPLETE, B owns key, missing cables remain missing and B
   must start a separate session with their own photos.
5. Admin opens the flag/evidence/context and resolves it. Outcome stays INCOMPLETE.
6. A starts MR-1 + MR-2. Recover MR-1; MR-2 stays ACTIVE.
7. Refresh/reopen both clients and confirm shared state survives. Open two phones
   or independent authenticated clients; verify cross-client updates and stale
   modal rejection. Local automated two-browser-context tests do not prove live
   device/mobile-network behavior against your deployed Supabase project.
8. Test Admin private photo viewing, member foreign-photo denial, unknown/disabled
   account restrictions and membership disable while holding a key/session.
9. Verify the browser console is clean and mobile photo capture works on actual
   Safari/Chrome cameras. HEIC/camera formats must decode in the browser before
   compression; unsupported input produces a retryable error, never an original upload.
10. Verify Realtime/focus refresh, network/upload retry, retention dry run and Cron.

Existing Vercel variables remain VITE_SUPABASE_URL and
VITE_SUPABASE_PUBLISHABLE_KEY; rebuild after frontend updates. No new browser secret.
Normal runtime ignores the old `music-club-rooms-demo-v2` key without clearing Auth
or other localStorage. Tests retain the original transition fixtures; old local
prototype sessions are never blended into or uploaded to shared history.

## 7. Verification and recovery

```sh
npm test
npm run build
npm run test:browser
node tests/membership-concurrency.mjs
```

Database tests use disposable PGlite; full concurrency tests create/remove a local
PostgreSQL cluster. Browser workflow tests use the actual migrations in PGlite,
mocking the Supabase HTTP/Storage transport, not destructive live cloud fixtures.
Use PostgreSQL binaries via PG_BIN and Chrome via
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH when their default macOS paths differ.

If a migration fails, its transaction rolls back. Do not drop existing membership
or Auth tables. After a successful migration prefer a corrective forward migration.
Pause Cron with `select cron.unschedule('music-room-retention')` if cleanup needs
investigation, and keep claims for safe retry. Disabling cleanup does not undo
already-deleted Storage bytes. Restore database **and Storage objects** from backups
if recovery is required; a database backup alone cannot recreate images. Do not
roll the frontend back to the local prototype as a production data workaround.
Keep the site in maintenance mode until schema/frontend versions are compatible.
