# Shared Music Room Tracker architecture

Google OAuth → Supabase Auth → verified VIT Google identity → preauthorized ACTIVE
club_members row. Existing membership RLS, roles, secure linking and membership
audit remain intact. All operational state now lives in Supabase; the production
frontend ignores the old local prototype key and never imports its fixtures.

| Table | Role |
| --- | --- |
| club_members / membership_audit | Permanent roster, identity links, roles and administrative history |
| rooms | Permanent five-room catalog and synchronization version |
| room_key_state | Permanent current custody, absent until physically initialized |
| sessions | ACTIVE/COMPLETE/INCOMPLETE lifecycle; one ACTIVE per room, multiple rooms per member |
| photo_uploads | Owned expiring upload intents and cleanup tombstones |
| session_photos | Current accepted START/END ROOM/CABLES evidence metadata |
| key_custody_events | Immutable website custody, reported physical source and resulting holder |
| flags | Missing checkout or custody mismatch review |
| operational_audit | Append-only administrative and transition facts |
| processed_operations | Server-derived actor, request fingerprint and idempotent result |
| photo_cleanup_queue | Privileged race-safe Storage deletion claims |

Core browser writes are revoked. operational_command validates the live identity,
locks membership/room/current custody/session, rejects stale versions, executes
approved transitions atomically and records idempotency. Membership disable uses
the same lock and refuses holders or ACTIVE session owners. Terminal sessions and
evidence are frozen. Admin corrections append history, while flag resolution
never repairs incomplete sessions. Server timestamps determine order/history.

A security-invoker snapshot reads one MVCC snapshot through RLS. Members see room
summaries and their own/participant history; admins see all retained operations.
Names needed for current/historical display come from a minimal ID/name directory;
transfer choices remain limited to ACTIVE members. No role comes from editable
metadata. Realtime publishes rooms only; clients refetch an authorized snapshot,
also on focus/foreground/success, with a modest disconnected-client fallback.

Photos compress client-side to JPEG with <=1600px long edge, <=350 KB target and
512,000-byte hard cap. Only compressed bytes enter private session-photos Storage.
Registered paths encode authenticated ownership/session/stage/category and UUID
object identity. START uploads exist before an atomic start commit. END acceptance
attaches immediately, allowing replacements while ACTIVE and preserving partial
evidence on recovery. Admin/owner viewers use authenticated downloads and ephemeral
object URLs. There are no public permanent URLs or browser deletion permissions.

Expected load: ~200 members, five rooms, ~15 sessions/day × four photos = ~60/day.
A rolling 30-day set is ~1,800 photos, typically 450–630 MB; a 512,000-byte hard cap
bounds this estimate at ~921.6 MB (about 879 MiB), before drafts and overdue ACTIVE
sessions. Draft/orphan cleanup after 24 hours and nightly retention keep ordinary
usage bounded, but accepted ACTIVE evidence is retained regardless of age.

Terminal sessions expire 30 days after closure. Related photos/history/flags/audit
are removed coherently; facts linked to retained ACTIVE/recent sessions stay with
their context. Permanent members, membership audit, rooms and current key state
are never removed. Server-only retention-cleanup runs daily at 18:35 UTC / 00:05
Asia/Kolkata via Cron/Vault. It claims objects transactionally, removes bytes with
Storage API, acknowledges successes, then deletes expired database records.
Failures keep records and claims for idempotent retry. Dry run is non-destructive.

No offline synchronization, booking, notifications, location enforcement or image
analysis is added. Tests retain the original prototype state machine as an explicit
fixture/reference; production components use only shared services.

See [operational setup](SUPABASE_OPERATIONAL_SETUP.md) for deployment, scheduling,
manual live acceptance checks, policy verification and backup/recovery limits.
