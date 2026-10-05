# Authentication now; shared operational data next

Current: Google → Supabase Auth → verified identity → preauthorized club_members
row → application. The database supplies the role. Membership management and its
immutable app-facing audit history are shared production database data. The UI
uses the membership UUID as the operational actor; fixture identities remain in
historical prototype records, without any impersonation switcher or browser tool.
Destination choices use the authenticated ACTIVE roster. The transition validator
accepts UUID member identifiers as well as its existing test fixtures; it does not
provide server authorization for browser-local data.

Rooms, sessions, evidence, custody events, flags and operational corrections still
use the existing browser-local prototype and business rules. No operational table
or bucket was added, and authenticated users do not share room data across devices.
The Admin role gates operational UI and handlers, but localStorage cannot provide
confidentiality or prevent tampering by the browser owner. This is an explicit
milestone boundary, not a claim of production operational data security.

The next milestone will migrate operational state to Supabase Postgres:

| Table | Purpose |
| --- | --- |
| club_members | Permanent membership/roles (implemented now) |
| rooms | Permanent room catalog |
| room_key_state | Permanent current custody state |
| sessions | Room session lifecycle |
| session_photos | Private evidence metadata |
| key_custody_events | Recorded transfers/recovery |
| flags | Review issues |
| audit_events | Operational administrative history |

Operational mutations must become database transactions with live ACTIVE
membership checks, MEMBER ownership rules, ADMIN correction checks, concurrency
and idempotency rules. Every table requires RLS; UI checks remain supplemental.
Keep membership_audit separate from the operational retention lifecycle.

Session photos will initially use a **private Supabase Storage bucket**, compressed
before upload to approximately 250–350 KB each. Target retention is approximately
30 days: ~15 sessions/day × 4 photos = ~60 photos/day, ~1,800 photos in the rolling
30-day set (~450–630 MB before overhead). Access must be authenticated and limited
to the applicable member/admin permissions, with short-lived signed URLs or
authorized downloads. Photos must never use public permanent URLs.

A later scheduled cleanup job will delete operational history/photos older than
the retention window, coordinating database metadata and Storage objects. It must
never delete permanent membership, rooms, current key state, or membership audits.
Active/incomplete records needed to resolve current custody must be handled before
cleanup; retention details and evidence access policies need to be implemented
and tested in that milestone. No cleanup job or photo migration is implemented now.
