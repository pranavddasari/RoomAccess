import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, KeyRound, ShieldCheck, X } from "lucide-react";
import { FLAG_TYPE, SESSION_STATUS } from "./transitions.js";
import { MEMBERS, evidenceSlots, friendlyTime, holderName, matchesRecord, memberName, newestFirst, overview, reasonLabel } from "./admin-model.js";

const roomName = (data, id) => data.rooms.find((room) => room.id === id)?.name ?? id;
const flagLabel = (flag) => flag.type === FLAG_TYPE.MISSING_END_CHECKOUT ? "Missing end checkout" : "Key custody mismatch";
const modeLabel = (mode) => ({ INCOMING: "Incoming receipt", OUTGOING: "Outgoing transfer", ADMIN_CORRECTION: "Admin correction" }[mode] ?? mode);

function Segments({ label, value, onChange, options }) {
  return <nav className="admin-segments" aria-label={label}>{options.map(([id, title]) => <button key={id} aria-pressed={value === id} onClick={() => onChange(id)}>{title}</button>)}</nav>;
}
function Empty({ children }) { return <p className="empty-state"><ShieldCheck size={20} />{children}</p>; }
function Status({ status }) { return <span className={`status status--${status.toLowerCase()}`}>{status}</span>; }
function Fact({ label, children }) { return <div><dt>{label}</dt><dd>{children ?? "Not recorded"}</dd></div>; }
function Filters({ data, value, onChange, statuses = [] }) {
  const field = (key, label, options, allLabel = `All ${label.toLowerCase()}s`) => <label><span>{label}</span><select value={value[key] ?? ""} onChange={(event) => onChange({ ...value, [key]: event.target.value })}><option value="">{allLabel}</option>{options.map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label>;
  return <div className="admin-filters">{field("room", "Room", data.rooms.map((room) => [room.id, room.name]))}{field("member", "Member", MEMBERS.map((member) => [member.id, member.name]))}{statuses.length > 0 && field("status", "Status", statuses.map((status) => [status, status]), "All statuses")}<button className="text-action" onClick={() => onChange({ room: "", member: "", status: "" })}>Clear filters</button></div>;
}

function Evidence({ session, inspect = false }) {
  return <div className={inspect ? "admin-evidence inspection" : "admin-evidence"}>{evidenceSlots(session).map((slot) => <div key={slot.label}>
    <span className={slot.captured ? "evidence-captured" : "evidence-missing"}>{slot.captured ? <Check size={16} /> : <X size={16} />}{slot.label}</span>
    <small>{slot.captured ? "Captured" : session.status === SESSION_STATUS.ACTIVE && slot.stage === "end" ? "Not yet captured" : "Missing"}</small>
    {inspect && slot.captured && (slot.available ? <details className="photo-inspection"><summary>View Photo · {slot.label}</summary><img src={slot.item.previewUrl} alt={`${slot.label} evidence by ${memberName(session.memberId)}`} /><small>Captured {friendlyTime(slot.item.acceptedAt)}</small></details> : <p className="preview-unavailable">Photo evidence was captured but the temporary prototype preview is no longer available after reload.</p>)}
  </div>)}</div>;
}
function Closure({ session }) {
  const closure = session.closure;
  if (!closure) return null;
  const disposition = closure.keyDisposition;
  return <dl className="admin-facts">
    <Fact label="Closure reason">{reasonLabel(closure.reason)}</Fact>
    <Fact label="Closed by">{memberName(closure.closedBy ?? closure.actorId)}</Fact>
    {closure.recoveryReason && <Fact label="Recovery reason">{reasonLabel(closure.recoveryReason)}</Fact>}
    {session.status === SESSION_STATUS.INCOMPLETE && <Fact label={`Remarks reported by ${memberName(closure.closedBy ?? closure.actorId)}`}>{closure.recoveryRemarks || "None recorded"}</Fact>}
    {disposition && <Fact label="Key disposition">{disposition.type === "retain" ? `Retained by ${memberName(disposition.id ?? session.memberId)}` : `Transferred to ${holderName(disposition)}`}</Fact>}
  </dl>;
}
export function AdminSessionCard({ session, data }) {
  return <article className="admin-card"><div className="admin-card-heading"><h4>{roomName(data, session.roomId)} · {memberName(session.memberId)}</h4><Status status={session.status} /></div>
    <dl className="admin-facts"><Fact label="Started">{friendlyTime(session.startedAt)}</Fact><Fact label="Closed">{session.closedAt ? friendlyTime(session.closedAt) : "Still active"}</Fact></dl>
    <Evidence session={session} />
    <Closure session={session} />
    <details className="admin-details"><summary>View Details</summary><p className="helper">Evidence belongs to {memberName(session.memberId)}.{session.status === SESSION_STATUS.INCOMPLETE && " Missing checkout photos cannot be added later."}</p><Evidence session={session} inspect /></details>
  </article>;
}
function CustodyCard({ event, data }) {
  return <article className="admin-card"><div className="admin-card-heading"><h4>{roomName(data, event.roomId)}</h4><span className="admin-time">{friendlyTime(event.timestamp)}</span></div>
    <p>{event.mode === "INCOMING" && "Reported: "}{holderName(event.mode === "INCOMING" ? event.reportedSource : event.previousRecordedHolder)} → {holderName(event.newHolder)}</p>
    {event.mode === "INCOMING" && <p className="helper">Previous website record: {holderName(event.previousRecordedHolder)}</p>}
    {event.mismatch && <p className="mismatch-label">⚠ Custody mismatch</p>}
    <dl className="admin-facts"><Fact label="Recorded as">{modeLabel(event.mode)}</Fact><Fact label="Recorded by">{memberName(event.actorId)}</Fact>{event.reason && <Fact label="Reason">{event.reason}</Fact>}</dl>
  </article>;
}
function FlagCard({ flag, data, resolve }) {
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState(false);
  const session = data.sessions.find((item) => item.id === flag.sessionId);
  return <article className={`admin-card admin-flag ${flag.status === "OPEN" ? "open" : "resolved"}`}>
    <div className="admin-card-heading"><h4>{flagLabel(flag)}</h4><Status status={flag.status} /></div>
    <p>{roomName(data, flag.roomId)} · {memberName(flag.subjectMemberId ?? flag.receiverId)}</p><p className="admin-time">Created {friendlyTime(flag.createdAt)}</p>
    <p className="helper">{flag.type === FLAG_TYPE.MISSING_END_CHECKOUT ? "Session closed without a completed checkout. Review the captured and missing evidence." : "The reported source differs from the previous website record. Review both records."}</p>
    <details className="admin-details"><summary>Review Flag</summary>
      {flag.type === FLAG_TYPE.MISSING_END_CHECKOUT ? <>
        <dl className="admin-facts"><Fact label="Member">{memberName(flag.subjectMemberId)}</Fact><Fact label="Room">{roomName(data, flag.roomId)}</Fact><Fact label="Session start">{friendlyTime(session?.startedAt)}</Fact><Fact label="Session closure">{friendlyTime(session?.closedAt ?? flag.createdAt)}</Fact></dl>
        <Evidence session={{ status: SESSION_STATUS.INCOMPLETE, memberId: flag.subjectMemberId, startEvidence: flag.evidenceSnapshot?.start ?? session?.startEvidence, endEvidence: flag.evidenceSnapshot?.end ?? session?.endEvidence }} inspect />
        <Closure session={session ?? { status: SESSION_STATUS.INCOMPLETE, closure: { reason: flag.reason, closedBy: flag.closedBy ?? flag.triggeredBy, recoveryReason: flag.recoveryReason, recoveryRemarks: flag.recoveryRemarks } }} />
      </> : <dl className="admin-facts"><Fact label="Website previously recorded">{holderName(flag.previousRecordedHolder)}</Fact><Fact label="Reported source">{holderName(flag.reportedSource)}</Fact><Fact label="Received by">{memberName(flag.receiverId)}</Fact><Fact label="Reported by">{memberName(flag.reportingActorId)}</Fact><Fact label="Time">{friendlyTime(flag.createdAt)}</Fact></dl>}
      {flag.status === "OPEN" ? <div className="flag-resolution"><label className="reason-field"><span>Admin remarks (optional)</span><textarea maxLength={160} value={note} onChange={(event) => setNote(event.target.value)} /></label>{confirm ? <><p className="helper">Mark this flag as reviewed? Session outcomes, photos, and custody history will stay unchanged.</p><div className="split-actions"><button className="secondary-action" onClick={() => setConfirm(false)}>Cancel</button><button className="primary-action" onClick={() => { if (resolve(flag.id, note)) setConfirm(false); }}>Confirm Resolution</button></div></> : <button className="secondary-action" onClick={() => setConfirm(true)}>Resolve Flag</button>}</div> : <dl className="admin-facts"><Fact label="Resolved by">{memberName(flag.resolvedBy)}</Fact><Fact label="Resolved at">{friendlyTime(flag.resolvedAt)}</Fact><Fact label="Admin remarks">{flag.resolutionNote || "None recorded"}</Fact></dl>}
    </details>
  </article>;
}
function AuditCard({ event, data }) {
  const details = event.details;
  const flag = data.flags.find((item) => item.id === details.flagId);
  const session = data.sessions.find((item) => item.id === details.sessionId);
  const title = { SESSION_STARTED: "Session started", SESSION_CLOSED: "Session closed", KEY_CUSTODY_RECORDED: "Key custody recorded", FLAG_RESOLVED: "Flag resolved" }[event.type] ?? event.type;
  return <article className="admin-card"><div className="admin-card-heading"><h4>{title}</h4><span className="admin-time">{friendlyTime(event.timestamp)}</span></div><p>{roomName(data, details.roomId ?? flag?.roomId ?? session?.roomId)} · {memberName(event.actorId)}</p>
    <dl className="admin-facts">
      {session && <Fact label="Session owner">{memberName(session.memberId)}</Fact>}
      {details.outcome && <Fact label="Recorded outcome">{details.outcome}</Fact>}
      {details.reason && <Fact label="Reason">{reasonLabel(details.reason)}</Fact>}
      {details.recoveryReason && <Fact label="Recovery reason">{reasonLabel(details.recoveryReason)}</Fact>}
      {details.recoveryRemarks && <Fact label={`Remarks by ${memberName(event.actorId)}`}>{details.recoveryRemarks}</Fact>}
      {details.mode && <><Fact label="Recorded as">{modeLabel(details.mode)}</Fact><Fact label="Previous website record">{holderName(details.previousRecordedHolder)}</Fact>{details.reportedSource && <Fact label="Reported source">{holderName(details.reportedSource)}</Fact>}<Fact label="New holder">{holderName(details.newHolder)}</Fact></>}
      {details.keyDisposition && <Fact label="Key disposition">{details.keyDisposition.type === "retain" ? `Retained by ${memberName(details.keyDisposition.id)}` : `Transferred to ${holderName(details.keyDisposition)}`}</Fact>}
      {flag && <Fact label="Flag reviewed">{flagLabel(flag)}</Fact>}
      {event.type === "FLAG_RESOLVED" && <Fact label="Admin remarks">{details.note || "None recorded"}</Fact>}
    </dl>
  </article>;
}

function RoomDetail({ room, data, resolve, openCorrection, close }) {
  const dialog = useRef(null);
  useEffect(() => { const previous = document.activeElement; dialog.current.showModal(); return () => { previous?.focus(); }; }, []);
  const sessions = newestFirst(data.sessions.filter((session) => session.roomId === room.id), "startedAt");
  const active = sessions.filter((session) => session.status === SESSION_STATUS.ACTIVE);
  const flags = data.flags.filter((flag) => flag.roomId === room.id && flag.status === "OPEN");
  const custody = newestFirst(data.custodyEvents.filter((event) => event.roomId === room.id), "timestamp").slice(0, 3);
  return <dialog className="room-detail-dialog" ref={dialog} aria-label={`${room.name} details`} onCancel={close}><button className="flow-close" aria-label="Close room details" onClick={close}><X /></button><h2>{room.name}</h2><Status status={room.kind === "INVALID" ? "STATE ISSUE" : room.kind} />
    <dl className="admin-facts"><Fact label="Current key holder">{holderName({ type: room.keyHolderType, id: room.keyHolderId })}</Fact></dl>
    <button className="secondary-action" onClick={() => { close(); openCorrection(room); }}>Correct Custody</button>
    {room.issues.map((issue) => <p className="warning-text" key={issue.code}>{issue.message}</p>)}
    <section className="admin-section"><h3>Active Session</h3>{active.length ? active.map((session) => <AdminSessionCard key={session.id} session={session} data={data} />) : <Empty>No active session.</Empty>}</section>
    <section className="admin-section"><h3>Open Flags</h3>{flags.length ? flags.map((flag) => <FlagCard key={flag.id} flag={flag} data={data} resolve={resolve} />) : <Empty>No open flags.</Empty>}</section>
    <section className="admin-section"><h3>Recent Key History · latest 3</h3>{custody.length ? custody.map((event) => <CustodyCard key={event.id} event={event} data={data} />) : <Empty>No custody events.</Empty>}</section>
    <section className="admin-section"><h3>Recent Closed Sessions · latest 3</h3>{sessions.filter((session) => session.status !== SESSION_STATUS.ACTIVE).slice(0, 3).map((session) => <AdminSessionCard key={session.id} session={session} data={data} />)}{!sessions.some((session) => session.status !== SESSION_STATUS.ACTIVE) && <Empty>No closed sessions.</Empty>}</section>
  </dialog>;
}

export default function AdminView({ data, issues, resetDemo, resolveFlag, openCorrection }) {
  const [section, setSection] = useState("overview");
  const [flagStatus, setFlagStatus] = useState("OPEN");
  const [historyType, setHistoryType] = useState("sessions");
  const [filters, setFilters] = useState({});
  const [selectedRoom, setSelectedRoom] = useState(null);
  const summary = overview(data);
  const match = (record) => matchesRecord(record, filters, data);
  const flags = newestFirst(data.flags.filter((flag) => flag.status === flagStatus && match(flag)), "createdAt");
  const history = historyType === "sessions" ? newestFirst(data.sessions.filter(match), "startedAt") : historyType === "custody" ? newestFirst(data.custodyEvents.filter(match), "timestamp") : newestFirst(data.auditEvents.filter(match), "timestamp");
  const room = summary.rooms.find((item) => item.id === selectedRoom);
  return <div className="content-view admin-view"><div className="page-heading"><p className="eyebrow">ROOMS · KEYS · REVIEW</p><h2>Admin</h2><p className="helper">Demo admin · current state and recorded activity</p></div>
    <Segments label="Admin sections" value={section} onChange={(value) => { setSection(value); setFilters({}); }} options={[["overview", "Overview"], ["flags", `Flags (${summary.openFlags})`], ["history", "History"]]} />
    {section === "overview" && <>
      <div className="admin-summary"><div><strong>{summary.activeRooms}</strong><span>Rooms Active</span></div><div><strong>{summary.idleRooms}</strong><span>Rooms Idle</span></div><div><strong>{summary.openFlags}</strong><span>Open Flags</span></div></div>
      {issues.length > 0 && <section className="admin-section"><h3>State Issues</h3>{issues.map((issue, index) => <p className="warning-card" key={index}><AlertTriangle size={20} />{issue.message}</p>)}</section>}
      <section className="admin-section"><h3>Room Status</h3><div className="admin-grid">{summary.rooms.map((room) => <article className="admin-card" key={room.id}><div className="admin-card-heading"><h4>{room.name}</h4><Status status={room.kind === "INVALID" ? "STATE ISSUE" : room.kind} /></div><dl className="admin-facts"><Fact label="Key">{holderName({ type: room.keyHolderType, id: room.keyHolderId })}</Fact>{room.session && <><Fact label="Session">{memberName(room.session.memberId)}</Fact><Fact label="Started">{friendlyTime(room.session.startedAt)}</Fact></>}</dl>{room.openFlags > 0 && <p className="mismatch-label">⚠ {room.openFlags} unresolved {room.openFlags === 1 ? "issue" : "issues"}</p>}<div className="admin-actions"><button className="secondary-action" onClick={() => setSelectedRoom(room.id)}>View {room.name}</button><button className="text-action" onClick={() => openCorrection(room)}>Correct Custody</button></div></article>)}</div></section>
      <section className="admin-section"><h3>Active Sessions · {summary.active.length}</h3><div className="admin-grid">{summary.active.map((session) => <AdminSessionCard key={session.id} session={session} data={data} />)}</div>{!summary.active.length && <Empty>No active sessions.</Empty>}</section>
      <section className="admin-section"><h3>Incomplete Sessions · {summary.incomplete.length}</h3><div className="admin-grid">{summary.incomplete.map((session) => <AdminSessionCard key={session.id} session={session} data={data} />)}</div>{!summary.incomplete.length && <Empty>No incomplete sessions.</Empty>}</section>
      <details className="admin-details demo-tools"><summary>Demo tools</summary><button className="reset-button" onClick={resetDemo}>Reset Demo Data</button></details>
    </>}
    {section === "flags" && <><h3>Flag Review</h3><Segments label="Flag status" value={flagStatus} onChange={setFlagStatus} options={[["OPEN", `Open (${summary.openFlags})`], ["RESOLVED", `Resolved (${data.flags.filter((flag) => flag.status === "RESOLVED").length})`]]} /><Filters data={data} value={filters} onChange={setFilters} /><div className="admin-grid">{flags.map((flag) => <FlagCard key={flag.id} flag={flag} data={data} resolve={resolveFlag} />)}</div>{!flags.length && <Empty>No {flagStatus.toLowerCase()} flags match these filters.</Empty>}</>}
    {section === "history" && <><h3>History</h3><Segments label="History type" value={historyType} onChange={(value) => { setHistoryType(value); setFilters((previous) => ({ ...previous, status: "" })); }} options={[["sessions", "Sessions"], ["custody", "Key / Custody"], ["audit", "Audit Events"]]} /><Filters data={data} value={filters} onChange={setFilters} statuses={historyType === "sessions" ? Object.values(SESSION_STATUS) : []} /><p className="helper">Newest first · {history.length} {history.length === 1 ? "record" : "records"}. Member filter includes owners and recorded participants.</p><div className="admin-grid">{history.map((record) => historyType === "sessions" ? <AdminSessionCard key={record.id} session={record} data={data} /> : historyType === "custody" ? <CustodyCard key={record.id} event={record} data={data} /> : <AuditCard key={record.id} event={record} data={data} />)}</div>{!history.length && <Empty>No records match these filters.</Empty>}</>}
    {room && <RoomDetail room={room} data={data} resolve={resolveFlag} openCorrection={openCorrection} close={() => setSelectedRoom(null)} />}
  </div>;
}
