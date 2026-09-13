import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AlertTriangle, ArrowDown, ArrowLeft, Camera, Check, CheckCircle2, Clock3, History, ImageOff, KeyRound, Music2, RotateCcw, ShieldCheck, UserRound, Users, X } from "lucide-react";
import {
  FLAG_TYPE, SESSION_STATUS, completeSession, correctCustody, friendlyError,
  makeInitialData, makeOperationId, parseDemoState, recordIncomingCustody,
  recordOutgoingCustody, resolveFlag, roomState, saveEndDraftEvidence,
  selfReportMissedCheckout, serializeDemoState, startSession, validateState,
} from "./transitions.js";
import "./styles.css";

const STORAGE_KEY = "music-club-rooms-demo-v2";
const MEMBERS = [
  { id: "member-a", name: "Member A" }, { id: "member-b", name: "Member B" },
  { id: "member-c", name: "Member C" }, { id: "member-d", name: "Member D" },
];
const LOCATIONS = { sw: "SW Office", mho: "Men's Hostel Office (MHO)" };
const memberName = (id) => MEMBERS.find((member) => member.id === id)?.name ?? id;
const holderName = (holderOrType, id) => {
  const type = typeof holderOrType === "object" ? holderOrType?.type : holderOrType;
  const holderId = typeof holderOrType === "object" ? holderOrType?.id : id;
  return type === "member" ? memberName(holderId) : LOCATIONS[holderId] ?? holderId;
};
const friendlyTime = (timestamp) => timestamp ? new Intl.DateTimeFormat([], { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp)) : "—";
const reasonLabel = (reason) => ({
  NORMAL_CHECKOUT: "Normal checkout",
  MISSED_CHECKOUT_SELF_REPORTED: "Member reported leaving without checkout",
  KEY_MOVED_DURING_ACTIVE_SESSION: "Key moved while checkout was unfinished",
  ADMIN_RECOVERY: "Closed during admin custody correction",
}[reason] ?? reason);

function loadDemo() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return { data: makeInitialData(), notice: null };
  const parsed = parseDemoState(raw);
  return parsed
    ? { data: parsed, notice: "Demo state restored. Temporary photo previews from the previous page load are marked unavailable." }
    : { data: makeInitialData(), notice: "Saved demo state was invalid, so known demo data was restored safely." };
}

function App() {
  const [loaded] = useState(loadDemo);
  const [data, setData] = useState(loaded.data);
  const [currentUser, setCurrentUser] = useState("member-a");
  const [tab, setTab] = useState("rooms");
  const [flow, setFlow] = useState(null);
  const [notice, setNotice] = useState(loaded.notice);
  const [busy, setBusy] = useState(false);
  const issues = useMemo(() => validateState(data), [data]);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, serializeDemoState(data)); }
    catch { setNotice("Demo state is too large for browser storage. Current page data is still available until refresh."); }
  }, [data]);

  const changeUser = (memberId) => { setCurrentUser(memberId); setFlow(null); setBusy(false); setNotice(null); };
  const apply = (result, onSuccess) => {
    if (!result.ok) { setNotice(result.error ?? friendlyError(result.code)); setBusy(false); return false; }
    setData(result.state); setNotice(null); setBusy(false); onSuccess?.(result.state); return true;
  };
  const openFlow = (type, room, session = null) => setFlow({
    type, roomId: room.id, sessionId: session?.id ?? null, actorId: currentUser,
    roomVersion: room.version, operationId: makeOperationId(type), evidence: session?.endDraftEvidence ?? [], step: "choose",
  });

  const start = () => {
    if (busy || flow?.actorId !== currentUser) return;
    setBusy(true);
    const result = startSession(data, { roomId: flow.roomId, actorId: flow.actorId, evidence: flow.evidence, operationId: flow.operationId, expectedRoomVersion: flow.roomVersion });
    apply(result, () => setFlow(null));
  };
  const saveEndEvidence = (evidence) => {
    const result = saveEndDraftEvidence(data, { roomId: flow.roomId, sessionId: flow.sessionId, actorId: flow.actorId, evidence });
    if (result.ok) { setData(result.state); setFlow((previous) => ({ ...previous, evidence })); }
    else setNotice(result.error);
  };
  const finish = (disposition) => {
    if (busy || flow?.actorId !== currentUser) return;
    setBusy(true);
    const result = completeSession(data, { roomId: flow.roomId, sessionId: flow.sessionId, actorId: flow.actorId, evidence: flow.evidence, disposition, operationId: flow.operationId, expectedRoomVersion: flow.roomVersion });
    const room = data.rooms.find((item) => item.id === flow.roomId);
    apply(result, () => setFlow({ type: "success", title: "Session Complete", roomName: room.name, detail: disposition.type === "retain" ? `${memberName(currentUser)} retained the key.` : `${memberName(currentUser)} → ${holderName(disposition)}` }));
  };
  const selfRecover = () => {
    if (busy || flow?.actorId !== currentUser) return;
    setBusy(true);
    const room = data.rooms.find((item) => item.id === flow.roomId);
    const result = selfReportMissedCheckout(data, { roomId: flow.roomId, sessionId: flow.sessionId, actorId: flow.actorId, operationId: flow.operationId, expectedRoomVersion: flow.roomVersion });
    apply(result, () => setFlow({ type: "success", title: "Session Marked Incomplete", roomName: room.name, detail: `Key remains with ${memberName(currentUser)}.` }));
  };
  const transfer = (destination) => {
    if (busy || flow?.actorId !== currentUser) return;
    setBusy(true);
    const room = data.rooms.find((item) => item.id === flow.roomId);
    const result = recordOutgoingCustody(data, { roomId: flow.roomId, actorId: flow.actorId, destination, operationId: flow.operationId, expectedRoomVersion: flow.roomVersion });
    apply(result, () => setFlow({ type: "success", title: "Key Transfer Recorded", roomName: room.name, detail: `${memberName(currentUser)} → ${holderName(destination)}` }));
  };
  const receive = () => {
    if (busy || flow?.actorId !== currentUser) return;
    const source = flow.reportedSource;
    if (!source) return;
    const room = data.rooms.find((item) => item.id === flow.roomId);
    const mismatch = room.keyHolderType !== source.type || room.keyHolderId !== source.id;
    if (mismatch && flow.step !== "confirm") { setFlow((previous) => ({ ...previous, step: "confirm" })); return; }
    setBusy(true);
    const result = recordIncomingCustody(data, { roomId: flow.roomId, actorId: flow.actorId, reportedSource: source, operationId: flow.operationId, expectedRoomVersion: flow.roomVersion });
    apply(result, () => setFlow({ type: "success", title: "Key Received", roomName: room.name, detail: `Reported ${holderName(source)} → ${memberName(currentUser)}` }));
  };
  const resolveAdminFlag = (flagId, note) => apply(resolveFlag(data, { flagId, note, operationId: makeOperationId("resolve-flag") }));
  const correctAdminCustody = (destination, reason) => {
    if (busy) return;
    setBusy(true);
    const room = data.rooms.find((item) => item.id === flow.roomId);
    const result = correctCustody(data, { roomId: room.id, destination, reason, operationId: flow.operationId, expectedRoomVersion: flow.roomVersion });
    apply(result, () => setFlow({ type: "success", title: "Custody Corrected", roomName: room.name, detail: `${holderName({ type: room.keyHolderType, id: room.keyHolderId })} → ${holderName(destination)}` }));
  };
  const resetDemo = () => { localStorage.removeItem(STORAGE_KEY); setData(makeInitialData()); setCurrentUser("member-a"); setTab("rooms"); setFlow(null); setNotice("Demo data reset to the original fixtures."); setBusy(false); };

  useWebMcp({ data, currentUser, changeUser, resetDemo });

  return <div className="app-shell">
    <header className="topbar"><div className="brand-mark"><Music2 size={20} /></div><div><p className="eyebrow">COLLEGE MUSIC CLUB</p><h1>Music Club Rooms</h1></div></header>
    {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice(null)} aria-label="Dismiss message"><X size={16} /></button></div>}
    <main>
      {tab === "rooms" && <RoomsView data={data} currentUser={currentUser} changeUser={changeUser} openFlow={openFlow} />}
      {tab === "history" && <HistoryView data={data} />}
      {tab === "admin" && <AdminView data={data} issues={issues} resetDemo={resetDemo} resolveFlag={resolveAdminFlag} openCorrection={(room) => openFlow("admin-correct", room)} />}
    </main>
    <BottomNav tab={tab} setTab={(next) => { setTab(next); setFlow(null); }} activeCount={data.sessions.filter((session) => session.status === SESSION_STATUS.ACTIVE).length} />
    {flow && <FlowPanel flow={flow} data={data} currentUser={currentUser} busy={busy} close={() => { setFlow(null); setBusy(false); }} setFlow={setFlow} start={start} saveEndEvidence={saveEndEvidence} finish={finish} selfRecover={selfRecover} transfer={transfer} receive={receive} correctCustody={correctAdminCustody} />}
  </div>;
}

function RoomsView({ data, currentUser, changeUser, openFlow }) {
  return <>
    <label className="user-switcher"><span>Current user</span><select value={currentUser} onChange={(event) => changeUser(event.target.value)}>{MEMBERS.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
    <div className="section-heading"><h2>Rooms</h2><span>{data.sessions.filter((session) => session.status === SESSION_STATUS.ACTIVE).length} active</span></div>
    <section className="room-list" aria-label="Music rooms">{data.rooms.map((room) => {
      const derived = roomState(data, room.id);
      const session = derived.session;
      const ownsKey = room.keyHolderType === "member" && room.keyHolderId === currentUser;
      const ownsSession = session?.memberId === currentUser;
      return <article className={`room-card ${session ? "is-active" : ""} ${derived.kind === "INVALID" ? "is-invalid" : ""}`} key={room.id}>
        <div className="room-card__header"><h3>{room.name}</h3><span className={`status ${derived.kind === "INVALID" ? "status--error" : session ? "status--active" : "status--idle"}`}>{derived.kind === "INVALID" ? "STATE ISSUE" : session ? "SESSION ACTIVE" : "IDLE"}</span></div>
        {derived.kind === "INVALID" ? <p className="warning-text">{derived.issues[0]?.message}</p> : session ? <div className="session-summary"><strong>{memberName(session.memberId)}</strong><span>Started {friendlyTime(session.startedAt)}</span><EvidenceSummary evidence={session.startEvidence} compact /></div> : <p className="room-state">Ready for a session</p>}
        <div className="key-row"><KeyRound size={18} /><span>Key</span><strong>{holderName(room.keyHolderType, room.keyHolderId)}</strong></div>
        {derived.kind === "INVALID" ? <p className="helper">Use Admin Demo to correct this room’s current custody.</p> : session ? ownsSession ? <div className="card-actions"><button className="primary-action danger" onClick={() => openFlow("end", room, session)}>End Session</button><button className="recovery-action" onClick={() => openFlow("missed", room, session)}>I already left without checking out</button></div> : <div className="card-actions"><p className="occupied-note">This room has an unfinished session from {memberName(session.memberId)}.</p><button className="secondary-action" onClick={() => openFlow("receive", room, session)}>I Received This Key</button></div>
          : ownsKey ? <div className="card-actions"><button className="primary-action" onClick={() => openFlow("start", room)}>Start Session</button><button className="text-action" onClick={() => openFlow("transfer", room)}>Transfer Key</button></div>
          : <><p className="helper">You need to have the {room.name} key before starting a session.</p><button className="secondary-action" onClick={() => openFlow("receive", room)}>I Received This Key</button></>}
      </article>;
    })}</section>
  </>;
}

function BottomNav({ tab, setTab, activeCount }) {
  return <nav className="bottom-nav" aria-label="Main navigation">
    <button className={tab === "rooms" ? "selected" : ""} onClick={() => setTab("rooms")}><Music2 size={18} /> Rooms</button>
    <button className={tab === "history" ? "selected" : ""} onClick={() => setTab("history")}><History size={18} /> History</button>
    <button className={tab === "admin" ? "selected" : ""} onClick={() => setTab("admin")}><ShieldCheck size={18} /> Admin {activeCount > 0 && <span className="nav-count">{activeCount}</span>}</button>
  </nav>;
}

function FlowPanel(props) {
  const { flow, data, close } = props;
  const room = data.rooms.find((item) => item.id === flow.roomId);
  const session = data.sessions.find((item) => item.id === flow.sessionId);
  if (flow.type === "success") return <Dialog label={flow.title}><SuccessScreen flow={flow} close={close} /></Dialog>;
  const heading = flow.type === "start" ? `START ${room?.name} SESSION` : flow.type === "end" ? `END ${room?.name} SESSION` : flow.type === "receive" ? `I RECEIVED THE ${room?.name} KEY` : flow.type === "transfer" ? `TRANSFER ${room?.name} KEY` : flow.type === "missed" ? "MISSED CHECKOUT" : `CORRECT ${room?.name} CUSTODY`;
  return <Dialog label={heading}><button className="flow-close" onClick={close} aria-label="Close"><X size={22} /></button><button className="back-link" onClick={close}><ArrowLeft size={18} /> Back</button><h2>{heading}</h2>
    {flow.type === "start" && <PhotoFlow stage="start" roomName={room.name} evidence={flow.evidence} onChange={(evidence) => props.setFlow((previous) => ({ ...previous, evidence }))} onComplete={props.start} busy={props.busy} />}
    {flow.type === "end" && <EndFlow flow={flow} room={room} evidence={flow.evidence} onEvidenceChange={props.saveEndEvidence} setFlow={props.setFlow} finish={props.finish} busy={props.busy} />}
    {flow.type === "missed" && <MissedCheckoutFlow room={room} session={session} busy={props.busy} confirm={props.selfRecover} close={close} />}
    {flow.type === "transfer" && <DestinationPicker currentUser={flow.actorId} title="Who are you giving the key to?" confirmLabel="Confirm Key Transfer" onConfirm={props.transfer} busy={props.busy} />}
    {flow.type === "receive" && <ReceiveFlow flow={flow} room={room} session={session} currentUser={flow.actorId} setFlow={props.setFlow} confirm={props.receive} busy={props.busy} close={close} />}
    {flow.type === "admin-correct" && <AdminCorrectionFlow room={room} onConfirm={props.correctCustody} busy={props.busy} />}
  </Dialog>;
}

function Dialog({ label, children }) { return <div className="flow-backdrop" role="dialog" aria-modal="true" aria-label={label}><section className="flow-panel">{children}</section></div>; }

function PhotoFlow({ stage, roomName, evidence, onChange, onComplete, continueLabel, busy }) {
  const accepted = (category) => evidence.find((item) => item.category === category && item.stage === stage && item.accepted);
  const accept = (item) => onChange([...evidence.filter((existing) => !(existing.stage === stage && existing.category === item.category)), item]);
  const beginReplacement = (category) => onChange(evidence.filter((existing) => !(existing.stage === stage && existing.category === category)));
  const ready = Boolean(accepted("room") && accepted("cables"));
  return <div className="flow-content"><p className="flow-intro">{stage === "start" ? "Before using the room, take two photos." : "Before leaving the room, take two photos."}</p>
    <PhotoCapture title="Overall room condition" label="Room Photo" stage={stage} category="room" acceptedEvidence={accepted("room")} onReplacementSelected={beginReplacement} onAccept={accept} />
    <PhotoCapture title="Cables / equipment condition" label="Cable Photo" stage={stage} category="cables" acceptedEvidence={accepted("cables")} onReplacementSelected={beginReplacement} onAccept={accept} />
    <button className="primary-action sticky-action" disabled={!ready || busy} onClick={onComplete}>{ready ? (continueLabel ?? `Start ${roomName} Session`) : "Add both photos to continue"}</button>
  </div>;
}

function PhotoCapture({ title, label, stage, category, acceptedEvidence, onReplacementSelected, onAccept }) {
  const inputRef = useRef(null);
  const [candidate, setCandidate] = useState(null);
  const [error, setError] = useState(null);
  const displayed = candidate ?? acceptedEvidence;
  const selectFile = async (event) => {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
    setError(null);
    try {
      const previewUrl = await readImage(file);
      onReplacementSelected(category);
      setCandidate({ id: makeOperationId("evidence"), stage, category, accepted: false, acceptedAt: null, fileName: file.name, mimeType: file.type, previewUrl, availability: "AVAILABLE" });
    } catch { setError("This image could not be displayed. Choose or take another photo."); }
  };
  const usePhoto = () => { if (!candidate) return; const acceptedAt = new Date().toISOString(); onAccept({ ...candidate, accepted: true, acceptedAt }); setCandidate(null); };
  return <section className={`photo-capture ${acceptedEvidence ? "photo-capture--ready" : ""}`}>
    <div className="photo-title-row"><div><span className="photo-kicker">REQUIRED PHOTO</span><h3>{title}</h3></div>{acceptedEvidence && !candidate && <span className="ready-check"><Check size={16} /> Used</span>}</div>
    <input ref={inputRef} className="visually-hidden" type="file" accept="image/*" capture="environment" onChange={selectFile} aria-label={`Take or choose ${label.toLowerCase()}`} />
    {!displayed ? <button className="camera-action" onClick={() => inputRef.current?.click()}><Camera size={24} /> Take {label}</button> : <>
      {displayed.previewUrl ? <div className="photo-preview-wrap"><img className="photo-preview" src={displayed.previewUrl} alt={`${label} preview`} /><span className="preview-status"><CheckCircle2 size={17} /> {candidate ? "Photo ready" : "Photo used"}</span></div> : <div className="photo-unavailable"><ImageOff size={24} /><span>Photo was captured previously but is no longer available in this browser prototype.</span></div>}
      <div className="photo-actions"><button className="secondary-action" onClick={() => inputRef.current?.click()}><RotateCcw size={18} /> Retake</button>{candidate && <button className="primary-action" onClick={usePhoto}><Check size={18} /> Use Photo</button>}</div>
    </>}
    {error && <p className="field-error">{error}</p>}
  </section>;
}

function readImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const image = new Image(); image.onerror = reject; image.onload = () => resolve(reader.result); image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function EndFlow({ flow, room, evidence, onEvidenceChange, setFlow, finish, busy }) {
  if (flow.step === "disposition") return <DestinationPicker includeRetain currentUser={flow.actorId} title={`What are you doing with the ${room.name} key?`} confirmLabel="Confirm & Complete Session" onConfirm={finish} busy={busy} />;
  return <PhotoFlow stage="end" roomName={room.name} evidence={evidence} onChange={onEvidenceChange} continueLabel="Continue to Key Disposition" onComplete={() => setFlow((previous) => ({ ...previous, step: "disposition" }))} busy={busy} />;
}

function MissedCheckoutFlow({ room, session, busy, confirm, close }) {
  return <div className="flow-content"><div className="warning-card"><AlertTriangle size={28} /><div><h3>Required checkout was not completed</h3><p>This {room.name} session will be recorded as incomplete. Missing checkout photos cannot be added later.</p><p>You will remain the recorded key holder.</p></div></div><EvidenceSummary evidence={session?.endDraftEvidence ?? []} stage="end" /><div className="split-actions"><button className="secondary-action" onClick={close}>Cancel</button><button className="primary-action danger" disabled={busy} onClick={confirm}>Mark Session Incomplete</button></div></div>;
}

function DestinationPicker({ title, currentUser, confirmLabel, onConfirm, includeRetain = false, busy = false }) {
  const [destination, setDestination] = useState(null);
  return <div className="flow-content"><p className="choice-title">{title}</p><div className="choice-stack">
    {includeRetain && <button className={destination?.type === "retain" ? "choice-card selected" : "choice-card"} onClick={() => setDestination({ type: "retain" })}><KeyRound size={22} /><span><strong>Keep Key With Me</strong><small>Finish checkout and retain custody</small></span></button>}
    <button className={destination?.type === "member" ? "choice-card selected" : "choice-card"} onClick={() => setDestination({ type: "member", id: null })}><Users size={22} /><span><strong>Give to Club Member</strong></span></button>
    <button className={destination?.type === "location" && destination.id === "sw" ? "choice-card selected" : "choice-card"} onClick={() => setDestination({ type: "location", id: "sw" })}><KeyRound size={22} /><span><strong>Return to SW Office</strong></span></button>
    <button className={destination?.type === "location" && destination.id === "mho" ? "choice-card selected" : "choice-card"} onClick={() => setDestination({ type: "location", id: "mho" })}><KeyRound size={22} /><span><strong>Return to Men's Hostel Office</strong></span></button>
  </div>{destination?.type === "member" && <MemberPicker excludedId={currentUser} selected={destination.id} onSelect={(id) => setDestination({ type: "member", id })} />}{destination?.type && (destination.type !== "member" || destination.id) && <button className="primary-action sticky-action" disabled={busy} onClick={() => onConfirm(destination)}>{confirmLabel}</button>}</div>;
}

function ReceiveFlow({ flow, room, session, currentUser, setFlow, confirm, busy, close }) {
  const source = flow.reportedSource;
  const mismatch = source && (room.keyHolderType !== source.type || room.keyHolderId !== source.id);
  const consequence = session && session.memberId !== currentUser;
  if (flow.step === "confirm") return <div className="flow-content">{consequence && <RecoveryConsequence room={room} session={session} />}{mismatch && <div className="warning-card"><AlertTriangle size={28} /><div><h3>Key record mismatch</h3><p>Website record: <strong>{holderName(room.keyHolderType, room.keyHolderId)}</strong></p><p>You reported: <strong>{holderName(source)} → {memberName(currentUser)}</strong></p></div></div>}<div className="split-actions"><button className="secondary-action" onClick={close}>Cancel</button><button className="primary-action danger" disabled={busy} onClick={confirm}>Confirm Anyway</button></div></div>;
  return <div className="flow-content">{consequence && <RecoveryConsequence room={room} session={session} />}<p className="choice-title">Who gave you this key?</p><SourcePicker currentUser={currentUser} source={source} onSelect={(reportedSource) => setFlow((previous) => ({ ...previous, reportedSource }))} />{source && <TransferPreview from={holderName(source)} to={memberName(currentUser)} />}<button className="primary-action sticky-action" disabled={!source || busy} onClick={confirm}>Confirm Receipt</button></div>;
}

function RecoveryConsequence({ room, session }) { return <div className="consequence-card"><AlertTriangle size={22} /><p><strong>{room.name}</strong> still has an unfinished session from {memberName(session.memberId)}. Recording this receipt will close it as incomplete. Missing checkout photos cannot be added later.</p></div>; }

function SourcePicker({ currentUser, source, onSelect }) { return <div className="choice-stack"><button className={source?.type === "member" ? "choice-card selected" : "choice-card"} onClick={() => onSelect({ type: "member", id: null })}><Users size={22} /><span><strong>Club Member</strong></span></button><button className={source?.type === "location" && source.id === "sw" ? "choice-card selected" : "choice-card"} onClick={() => onSelect({ type: "location", id: "sw" })}><KeyRound size={22} /><span><strong>SW Office</strong></span></button><button className={source?.type === "location" && source.id === "mho" ? "choice-card selected" : "choice-card"} onClick={() => onSelect({ type: "location", id: "mho" })}><KeyRound size={22} /><span><strong>Men's Hostel Office</strong></span></button>{source?.type === "member" && <MemberPicker excludedId={currentUser} selected={source.id} onSelect={(id) => onSelect({ type: "member", id })} />}</div>; }
function MemberPicker({ excludedId, selected, onSelect }) { return <div className="member-picker"><span>Select a member</span><div className="member-grid">{MEMBERS.filter((member) => member.id !== excludedId).map((member) => <button key={member.id} className={selected === member.id ? "selected" : ""} onClick={() => onSelect(member.id)}><UserRound size={18} /> {member.name}</button>)}</div></div>; }

function AdminCorrectionFlow({ room, onConfirm, busy }) {
  const [destination, setDestination] = useState(null); const [reason, setReason] = useState("");
  return <div className="flow-content"><p className="flow-intro">Current key holder: <strong>{holderName(room.keyHolderType, room.keyHolderId)}</strong></p><HolderPicker destination={destination} setDestination={setDestination} /><label className="reason-field"><span>Reason for correction</span><input value={reason} maxLength={160} onChange={(event) => setReason(event.target.value)} placeholder="Example: Key verified at SW Office" /></label><button className="primary-action sticky-action" disabled={!destination || !reason.trim() || busy} onClick={() => onConfirm(destination, reason)}>Record Custody Correction</button></div>;
}
function HolderPicker({ destination, setDestination }) { return <div className="choice-stack"><button className={destination?.type === "member" ? "choice-card selected" : "choice-card"} onClick={() => setDestination({ type: "member", id: null })}><Users size={22} /><span><strong>Club Member</strong></span></button><button className={destination?.type === "location" && destination.id === "sw" ? "choice-card selected" : "choice-card"} onClick={() => setDestination({ type: "location", id: "sw" })}><KeyRound size={22} /><span><strong>SW Office</strong></span></button><button className={destination?.type === "location" && destination.id === "mho" ? "choice-card selected" : "choice-card"} onClick={() => setDestination({ type: "location", id: "mho" })}><KeyRound size={22} /><span><strong>Men's Hostel Office</strong></span></button>{destination?.type === "member" && <MemberPicker selected={destination.id} onSelect={(id) => setDestination({ type: "member", id })} />}</div>; }

function EvidenceSummary({ evidence = [], stage, compact = false }) {
  const stages = stage ? [stage] : ["start", "end"];
  return <div className={compact ? "evidence-summary compact" : "evidence-summary"}>{stages.map((currentStage) => <div key={currentStage}><span>{currentStage === "start" ? "Start" : "End"}</span>{["room", "cables"].map((category) => { const item = evidence.find((entry) => entry.stage === currentStage && entry.category === category && entry.accepted); return <small key={category} className={item ? "has-evidence" : "missing-evidence"}>{item ? <Check size={14} /> : <X size={14} />}{category === "room" ? "Room" : "Cables"}{item?.availability === "UNAVAILABLE_AFTER_RELOAD" && " · preview unavailable"}</small>; })}</div>)}</div>;
}
function TransferPreview({ from, to }) { return <div className="transfer-preview"><strong>{from}</strong><ArrowDown size={20} /><strong>{to}</strong></div>; }
function SuccessScreen({ flow, close }) { return <div className="success-screen"><div className="success-icon"><Check size={40} /></div><p className="eyebrow">RECORDED</p><h2>{flow.title}</h2><div className="success-room">{flow.roomName}</div><p>{flow.detail}</p><button className="primary-action" onClick={close}>Done</button></div>; }

function SessionCard({ session, data }) {
  const room = data.rooms.find((item) => item.id === session.roomId);
  return <article className="session-log"><div className="session-log__head"><strong>{room?.name} · {memberName(session.memberId)}</strong><span className={`status status--${session.status.toLowerCase()}`}>{session.status}</span></div><div className="time-line"><Clock3 size={16} /> {friendlyTime(session.startedAt)} – {session.closedAt ? friendlyTime(session.closedAt) : "Now"}</div><EvidenceSummary evidence={[...(session.startEvidence ?? []), ...(session.endEvidence ?? []), ...(session.endDraftEvidence ?? [])]} />{session.closure && <p className="reason-line">Reason: {reasonLabel(session.closure.reason)}</p>}</article>;
}
function CustodyCard({ event, data }) {
  const room = data.rooms.find((item) => item.id === event.roomId);
  return <article className="log-row custody-log"><div className="log-time">{friendlyTime(event.timestamp)}</div><div><strong>{room?.name} custody updated</strong>{event.mode === "INCOMING" ? <><p>Reported: {holderName(event.reportedSource)} → {holderName(event.newHolder)}</p><small>Previous website record: {holderName(event.previousRecordedHolder)}</small>{event.mismatch && <span className="mismatch-label">⚠ Custody mismatch</span>}</> : <p>{holderName(event.previousRecordedHolder)} → {holderName(event.newHolder)} · {event.mode === "ADMIN_CORRECTION" ? "Admin correction" : "Outgoing"}</p>}{event.reason && <small>Reason: {event.reason}</small>}</div></article>;
}
function HistoryView({ data }) { return <div className="content-view"><div className="page-heading"><p className="eyebrow">ACTIVITY LOG</p><h2>History</h2></div><section className="history-section"><h3>Key / Custody History</h3>{data.custodyEvents.length ? data.custodyEvents.map((event) => <CustodyCard key={event.id} event={event} data={data} />) : <EmptyState icon={KeyRound} text="No custody events recorded yet." />}</section><section className="history-section"><h3>Session History</h3>{data.sessions.map((session) => <SessionCard key={session.id} session={session} data={data} />)}</section></div>; }

function AdminView({ data, issues, resetDemo, resolveFlag: resolve, openCorrection }) {
  const [notes, setNotes] = useState({}); const active = data.sessions.filter((session) => session.status === SESSION_STATUS.ACTIVE); const incomplete = data.sessions.filter((session) => session.status === SESSION_STATUS.INCOMPLETE);
  return <div className="content-view"><div className="page-heading"><p className="eyebrow">PROTOTYPE VIEW</p><h2>Admin Demo</h2></div>
    {issues.length > 0 && <section className="admin-section"><h3>State Issues</h3>{issues.map((issue, index) => <div className="warning-card" key={`${issue.code}-${index}`}><AlertTriangle size={22} /><p>{issue.message}</p></div>)}</section>}
    <section className="admin-section"><h3>Room Status</h3><div className="admin-room-list">{data.rooms.map((room) => { const derived = roomState(data, room.id); return <article key={room.id}><div><strong>{room.name}</strong><span>{derived.kind === "INVALID" ? "State issue" : derived.session ? `Active — ${memberName(derived.session.memberId)}` : "Idle"}</span></div><p><KeyRound size={15} /> {holderName(room.keyHolderType, room.keyHolderId)}</p><button className="mini-action" onClick={() => openCorrection(room)}>Correct</button></article>; })}</div></section>
    <section className="admin-section"><h3>Active Sessions</h3>{active.length ? active.map((session) => <SessionCard key={session.id} session={session} data={data} />) : <EmptyState icon={CheckCircle2} text="No active sessions." />}</section>
    <section className="admin-section"><h3>Incomplete Sessions</h3>{incomplete.length ? incomplete.map((session) => <SessionCard key={session.id} session={session} data={data} />) : <EmptyState icon={CheckCircle2} text="No incomplete sessions." />}</section>
    <section className="admin-section"><h3>Flags</h3>{data.flags.length ? data.flags.map((flag) => <article className={`flag-card ${flag.status === "RESOLVED" ? "resolved" : ""}`} key={flag.id}><AlertTriangle size={22} /><div><strong>{flag.type === FLAG_TYPE.MISSING_END_CHECKOUT ? "Missing end checkout" : "Key custody mismatch"}</strong><p>{data.rooms.find((room) => room.id === flag.roomId)?.name} · {flag.status}</p>{flag.type === FLAG_TYPE.MISSING_END_CHECKOUT ? <><small>Member: {memberName(flag.subjectMemberId)}</small><small>Reason: {reasonLabel(flag.reason)}</small><small>Recovery by: {memberName(flag.triggeredBy)}</small><EvidenceSummary evidence={[...(flag.evidenceSnapshot?.start ?? []), ...(flag.evidenceSnapshot?.end ?? [])]} /></> : <><small>Previous record: {holderName(flag.previousRecordedHolder)}</small><small>Reported: {holderName(flag.reportedSource)} → {memberName(flag.receiverId)}</small><small>Reporting actor: {memberName(flag.reportingActorId)}</small></>}{flag.status === "OPEN" ? <><input className="resolution-note" value={notes[flag.id] ?? ""} maxLength={160} onChange={(event) => setNotes((previous) => ({ ...previous, [flag.id]: event.target.value }))} placeholder="Optional resolution note" /><button className="mini-action" onClick={() => resolve(flag.id, notes[flag.id] ?? "")}>Resolve Flag</button></> : <small>Resolved {friendlyTime(flag.resolvedAt)}{flag.resolutionNote ? ` · ${flag.resolutionNote}` : ""}</small>}</div></article>) : <EmptyState icon={ShieldCheck} text="No flags recorded." />}</section>
    <section className="admin-section"><h3>Session History</h3>{data.sessions.map((session) => <SessionCard key={`admin-${session.id}`} session={session} data={data} />)}</section>
    <section className="admin-section"><h3>Key / Custody History</h3>{data.custodyEvents.length ? data.custodyEvents.map((event) => <CustodyCard key={`admin-${event.id}`} event={event} data={data} />) : <EmptyState icon={KeyRound} text="No custody events recorded yet." />}</section>
    <button className="reset-button" onClick={resetDemo}><RotateCcw size={18} /> Demo only · Reset Demo Data</button>
  </div>;
}
function EmptyState({ icon: Icon, text }) { return <div className="empty-state"><Icon size={22} /><span>{text}</span></div>; }

function useWebMcp({ data, currentUser, changeUser, resetDemo }) {
  const latest = useRef({ data, currentUser, changeUser, resetDemo }); latest.current = { data, currentUser, changeUser, resetDemo };
  useEffect(() => {
    const context = document.modelContext; if (!context?.registerTool) return undefined;
    const lifecycle = new AbortController(); const register = (tool) => { try { void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => {}); } catch { /* unsupported browser draft */ } };
    register({ name: "read_music_room_demo_status", title: "Read music room demo status", description: "Read current room-session and key-custody state from the visible prototype.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: false }, execute: () => ({ currentUser: memberName(latest.current.currentUser), rooms: latest.current.data.rooms.map((room) => ({ room: room.name, status: room.activeSessionId ? "active" : "idle", keyHolder: holderName(room.keyHolderType, room.keyHolderId) })) }) });
    register({ name: "switch_music_room_demo_user", title: "Switch demo user", description: "Switch the mock current user and cancel any open flow.", inputSchema: { type: "object", properties: { memberId: { type: "string", enum: MEMBERS.map((member) => member.id) } }, required: ["memberId"], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false }, execute: ({ memberId }) => { if (!MEMBERS.some((member) => member.id === memberId)) throw new Error("Unknown mock member"); latest.current.changeUser(memberId); return { currentUser: memberName(memberId), openFlowCancelled: true }; } });
    register({ name: "reset_music_room_demo", title: "Reset music room demo", description: "Restore original fixtures and clear persisted prototype state.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false }, execute: () => { latest.current.resetDemo(); return { reset: true }; } });
    return () => lifecycle.abort();
  }, []);
}

createRoot(document.getElementById("root")).render(<App />);
