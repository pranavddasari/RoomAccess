import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AlertTriangle, ArrowDown, ArrowLeft, Camera, Check, CheckCircle2, Clock3, History, KeyRound, Music2, RotateCcw, ShieldCheck, UserRound, Users, X } from "lucide-react";
import "./styles.css";

const MEMBERS = [
  { id: "member-a", name: "Member A" }, { id: "member-b", name: "Member B" },
  { id: "member-c", name: "Member C" }, { id: "member-d", name: "Member D" },
];
const LOCATIONS = { sw: "SW Office", mho: "Men's Hostel Office (MHO)" };
const memberName = (id) => MEMBERS.find((m) => m.id === id)?.name ?? id;
const holderName = (type, id) => type === "member" ? memberName(id) : LOCATIONS[id];
const nowTime = () => new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const makeId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

function makeInitialData() {
  return {
    rooms: [
      { id: "mr-1", name: "MR-1", keyHolderType: "member", keyHolderId: "member-a", activeSessionId: null },
      { id: "mr-2", name: "MR-2", keyHolderType: "location", keyHolderId: "sw", activeSessionId: null },
      { id: "mr-3", name: "MR-3", keyHolderType: "member", keyHolderId: "member-c", activeSessionId: null },
      { id: "mr-4", name: "MR-4", keyHolderType: "member", keyHolderId: "member-d", activeSessionId: "session-demo-active" },
      { id: "mr-5", name: "MR-5", keyHolderType: "location", keyHolderId: "mho", activeSessionId: null },
    ],
    sessions: [
      { id: "session-demo-complete", roomId: "mr-2", memberId: "member-c", startTime: "1:20 PM", endTime: "2:12 PM", startRoomPhoto: true, startCablePhoto: true, endRoomPhoto: true, endCablePhoto: true, status: "complete" },
      { id: "session-demo-active", roomId: "mr-4", memberId: "member-d", startTime: "3:04 PM", endTime: null, startRoomPhoto: true, startCablePhoto: true, endRoomPhoto: false, endCablePhoto: false, status: "active" },
    ],
    keyTransfers: [], flags: [],
  };
}

function App() {
  const [data, setData] = useState(makeInitialData);
  const [currentUser, setCurrentUser] = useState("member-a");
  const [tab, setTab] = useState("rooms");
  const [flow, setFlow] = useState(null);
  const activeCount = useMemo(() => data.sessions.filter((s) => s.status === "active").length, [data.sessions]);

  const startSession = (roomId) => {
    const room = data.rooms.find((r) => r.id === roomId);
    if (!room || room.activeSessionId || room.keyHolderType !== "member" || room.keyHolderId !== currentUser) return;
    const sessionId = makeId("session");
    const session = { id: sessionId, roomId, memberId: currentUser, startTime: nowTime(), endTime: null, startRoomPhoto: true, startCablePhoto: true, endRoomPhoto: false, endCablePhoto: false, status: "active" };
    setData((prev) => ({ ...prev, rooms: prev.rooms.map((r) => r.id === roomId ? { ...r, activeSessionId: sessionId } : r), sessions: [session, ...prev.sessions] }));
    setFlow(null);
  };

  const recordTransfer = ({ roomId, fromType, fromId, toType, toId, direction, mismatch = false, reportedFromName }) => {
    const transfer = { id: makeId("transfer"), roomId, fromType, fromId, toType, toId, timestamp: nowTime(), recordedBy: currentUser, direction };
    setData((prev) => ({
      ...prev,
      rooms: prev.rooms.map((r) => r.id === roomId ? { ...r, keyHolderType: toType, keyHolderId: toId } : r),
      keyTransfers: [transfer, ...prev.keyTransfers],
      flags: mismatch ? [{ id: makeId("flag"), type: "KEY_CUSTODY_MISMATCH", roomId, timestamp: nowTime(), details: { previousRecordedHolder: holderName(fromType, fromId), reportedFrom: reportedFromName, receivedBy: memberName(currentUser) } }, ...prev.flags] : prev.flags,
    }));
  };

  const confirmIndependentTransfer = ({ roomId, toType, toId }) => {
    const room = data.rooms.find((r) => r.id === roomId);
    if (!room || room.activeSessionId || room.keyHolderType !== "member" || room.keyHolderId !== currentUser) return;
    recordTransfer({ roomId, fromType: room.keyHolderType, fromId: room.keyHolderId, toType, toId, direction: "given" });
    setFlow({ type: "success", title: "Key Transfer Recorded", roomName: room.name, from: memberName(currentUser), to: holderName(toType, toId) });
  };

  const confirmReceipt = ({ roomId, fromType, fromId, confirmAnyway = false, reportedFromName: suppliedName }) => {
    const room = data.rooms.find((r) => r.id === roomId);
    if (!room || room.activeSessionId) return;
    const mismatch = room.keyHolderType !== fromType || room.keyHolderId !== fromId;
    const reportedFromName = suppliedName ?? holderName(fromType, fromId);
    if (mismatch && !confirmAnyway) {
      setFlow((prev) => ({ ...prev, step: "mismatch", fromType, fromId, reportedFromName, recordedHolderName: holderName(room.keyHolderType, room.keyHolderId) }));
      return;
    }
    recordTransfer({ roomId, fromType: room.keyHolderType, fromId: room.keyHolderId, toType: "member", toId: currentUser, direction: "received", mismatch, reportedFromName });
    setFlow({ type: "success", title: "Key Received", roomName: room.name, from: reportedFromName, to: memberName(currentUser) });
  };

  const finishSession = ({ roomId, toType, toId }) => {
    const room = data.rooms.find((r) => r.id === roomId);
    const session = data.sessions.find((s) => s.id === room?.activeSessionId);
    if (!room || !session || session.memberId !== currentUser) return;
    const transfer = { id: makeId("transfer"), roomId, fromType: "member", fromId: currentUser, toType, toId, timestamp: nowTime(), recordedBy: currentUser, direction: "given-after-session" };
    setData((prev) => ({
      ...prev,
      rooms: prev.rooms.map((r) => r.id === roomId ? { ...r, activeSessionId: null, keyHolderType: toType, keyHolderId: toId } : r),
      sessions: prev.sessions.map((s) => s.id === session.id ? { ...s, endTime: nowTime(), endRoomPhoto: true, endCablePhoto: true, status: "complete" } : s),
      keyTransfers: [transfer, ...prev.keyTransfers],
    }));
    setFlow({ type: "success", title: "Session Complete", roomName: room.name, from: memberName(currentUser), to: holderName(toType, toId) });
  };

  const resetDemo = () => { setData(makeInitialData()); setCurrentUser("member-a"); setTab("rooms"); setFlow(null); };
  useWebMcp({ data, currentUser, setCurrentUser, resetDemo });

  return <div className="app-shell">
    <header className="topbar"><div className="brand-mark"><Music2 size={20} /></div><div><p className="eyebrow">COLLEGE MUSIC CLUB</p><h1>Music Club Rooms</h1></div></header>
    <main>
      {tab === "rooms" && <RoomsView rooms={data.rooms} sessions={data.sessions} currentUser={currentUser} setCurrentUser={setCurrentUser} openFlow={setFlow} />}
      {tab === "history" && <HistoryView data={data} />}
      {tab === "admin" && <AdminView data={data} resetDemo={resetDemo} />}
    </main>
    <BottomNav tab={tab} setTab={setTab} activeCount={activeCount} />
    {flow && <FlowPanel flow={flow} room={data.rooms.find((r) => r.id === flow.roomId)} currentUser={currentUser} close={() => setFlow(null)} setFlow={setFlow} startSession={startSession} finishSession={finishSession} confirmIndependentTransfer={confirmIndependentTransfer} confirmReceipt={confirmReceipt} />}
  </div>;
}

function RoomsView({ rooms, sessions, currentUser, setCurrentUser, openFlow }) {
  return <>
    <label className="user-switcher"><span>Current user</span><select value={currentUser} onChange={(e) => setCurrentUser(e.target.value)}>{MEMBERS.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
    <div className="section-heading"><h2>Rooms</h2><span>{rooms.filter((r) => r.activeSessionId).length} active</span></div>
    <section className="room-list" aria-label="Music rooms">{rooms.map((room) => {
      const session = sessions.find((s) => s.id === room.activeSessionId);
      const ownsKey = room.keyHolderType === "member" && room.keyHolderId === currentUser;
      const ownsSession = session?.memberId === currentUser;
      return <article className={`room-card ${session ? "is-active" : ""}`} key={room.id}>
        <div className="room-card__header"><h3>{room.name}</h3><span className={`status ${session ? "status--active" : "status--idle"}`}>{session ? "SESSION ACTIVE" : "IDLE"}</span></div>
        {session ? <div className="session-summary"><strong>{memberName(session.memberId)}</strong><span>Started {session.startTime}</span><div className="photo-checks"><Check size={15} /> Start photos complete</div></div> : <p className="room-state">Ready for a session</p>}
        <div className="key-row"><KeyRound size={18} /><span>Key</span><strong>{holderName(room.keyHolderType, room.keyHolderId)}</strong></div>
        {session ? ownsSession ? <button className="primary-action danger" onClick={() => openFlow({ type: "end", roomId: room.id })}>End Session</button> : <p className="occupied-note">This room is currently in use.</p>
          : ownsKey ? <div className="card-actions"><button className="primary-action" onClick={() => openFlow({ type: "start", roomId: room.id })}>Start Session</button><button className="text-action" onClick={() => openFlow({ type: "transfer", roomId: room.id })}>Transfer Key</button></div>
          : <><p className="helper">You need to have the {room.name} key before starting a session.</p><button className="secondary-action" onClick={() => openFlow({ type: "receive", roomId: room.id, step: "choose" })}>I Received This Key</button></>}
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
  const { flow, room, close } = props;
  const heading = flow.type === "start" ? `START ${room?.name} SESSION` : flow.type === "end" ? `END ${room?.name} SESSION` : flow.type === "transfer" ? `TRANSFER ${room?.name} KEY` : flow.type === "receive" ? `I RECEIVED THE ${room?.name} KEY` : flow.title;
  return <div className="flow-backdrop" role="dialog" aria-modal="true" aria-label={heading}><section className="flow-panel">
    {flow.type !== "success" && <button className="flow-close" onClick={close} aria-label="Close"><X size={22} /></button>}
    {flow.type === "success" ? <SuccessScreen flow={flow} close={close} /> : <>
      <button className="back-link" onClick={close}><ArrowLeft size={18} /> Back to rooms</button><h2>{heading}</h2>
      {flow.type === "start" && <PhotoFlow mode="start" roomName={room.name} onComplete={() => props.startSession(room.id)} />}
      {flow.type === "end" && <EndFlow flow={flow} room={room} currentUser={props.currentUser} setFlow={props.setFlow} onFinish={props.finishSession} />}
      {flow.type === "transfer" && <TransferFlow room={room} currentUser={props.currentUser} onConfirm={props.confirmIndependentTransfer} />}
      {flow.type === "receive" && <ReceiveFlow flow={flow} room={room} currentUser={props.currentUser} setFlow={props.setFlow} onConfirm={props.confirmReceipt} close={close} />}
    </>}
  </section></div>;
}

function PhotoFlow({ mode, roomName, onComplete, continueLabel }) {
  const [roomReady, setRoomReady] = useState(false), [cableReady, setCableReady] = useState(false);
  const allReady = roomReady && cableReady;
  return <div className="flow-content"><p className="flow-intro">{mode === "start" ? "Before using the room, take two photos." : "Before leaving the room, take two photos."}</p>
    <PhotoCapture title="Overall room condition" shortLabel="Room Photo" onReadyChange={setRoomReady} />
    <PhotoCapture title="Cables / equipment condition" shortLabel="Cable Photo" onReadyChange={setCableReady} />
    <button className="primary-action sticky-action" disabled={!allReady} onClick={onComplete}>{allReady ? (continueLabel ?? `Start ${roomName} Session`) : "Add both photos to continue"}</button>
  </div>;
}

function PhotoCapture({ title, shortLabel, onReadyChange }) {
  const inputRef = useRef(null), previewRef = useRef(null);
  const [preview, setPreview] = useState(null), [ready, setReady] = useState(false);
  useEffect(() => () => { if (previewRef.current) URL.revokeObjectURL(previewRef.current); }, []);
  const selectFile = (e) => { const file = e.target.files?.[0]; if (!file) return; if (previewRef.current) URL.revokeObjectURL(previewRef.current); const url = URL.createObjectURL(file); previewRef.current = url; setPreview(url); setReady(false); onReadyChange(false); e.target.value = ""; };
  const usePhoto = () => { setReady(true); onReadyChange(true); };
  return <section className={`photo-capture ${ready ? "photo-capture--ready" : ""}`}>
    <div className="photo-title-row"><div><span className="photo-kicker">REQUIRED PHOTO</span><h3>{title}</h3></div>{ready && <span className="ready-check"><Check size={16} /> Used</span>}</div>
    <input ref={inputRef} className="visually-hidden" type="file" accept="image/*" capture="environment" onChange={selectFile} aria-label={`Take or choose ${shortLabel.toLowerCase()}`} />
    {!preview ? <button className="camera-action" onClick={() => inputRef.current?.click()}><Camera size={24} /> Take {shortLabel}</button> : <><div className="photo-preview-wrap"><img className="photo-preview" src={preview} alt={`${shortLabel} preview`} /><span className="preview-status"><CheckCircle2 size={17} /> Photo ready</span></div><div className="photo-actions"><button className="secondary-action" onClick={() => inputRef.current?.click()}><RotateCcw size={18} /> Retake</button><button className="primary-action" disabled={ready} onClick={usePhoto}><Check size={18} /> {ready ? "Photo Used" : "Use Photo"}</button></div></>}
  </section>;
}

function EndFlow({ flow, room, currentUser, setFlow, onFinish }) {
  if (flow.step === "key") return <DestinationPicker title={`What are you doing with the ${room.name} key?`} currentUser={currentUser} confirmLabel="Confirm & Complete Session" onConfirm={(destination) => onFinish({ roomId: room.id, ...destination })} />;
  return <PhotoFlow mode="end" roomName={room.name} continueLabel="Continue to Key Transfer" onComplete={() => setFlow((prev) => ({ ...prev, step: "key" }))} />;
}
function TransferFlow({ room, currentUser, onConfirm }) { return <DestinationPicker title="Who are you giving the key to?" currentUser={currentUser} confirmLabel="Confirm Key Transfer" onConfirm={(destination) => onConfirm({ roomId: room.id, ...destination })} />; }

function DestinationPicker({ title, currentUser, confirmLabel, onConfirm }) {
  const [toType, setToType] = useState(null), [toId, setToId] = useState(null);
  const choose = (type, id = null) => { setToType(type); setToId(id); };
  return <div className="flow-content"><p className="choice-title">{title}</p><div className="choice-stack">
    <button className={toType === "member" ? "choice-card selected" : "choice-card"} onClick={() => choose("member")}><Users size={22} /><span><strong>Give to Club Member</strong><small>Hand the key to another member</small></span></button>
    <button className={toType === "location" && toId === "sw" ? "choice-card selected" : "choice-card"} onClick={() => choose("location", "sw")}><KeyRound size={22} /><span><strong>Return to SW Office</strong></span></button>
    <button className={toType === "location" && toId === "mho" ? "choice-card selected" : "choice-card"} onClick={() => choose("location", "mho")}><KeyRound size={22} /><span><strong>Return to Men's Hostel Office</strong></span></button>
  </div>{toType === "member" && <MemberPicker currentUser={currentUser} selected={toId} onSelect={setToId} />}{toType && toId && <TransferPreview from={memberName(currentUser)} to={holderName(toType, toId)} />}<button className="primary-action sticky-action" disabled={!toType || !toId} onClick={() => onConfirm({ toType, toId })}>{confirmLabel}</button></div>;
}

function ReceiveFlow({ flow, room, currentUser, setFlow, onConfirm, close }) {
  const [fromType, setFromType] = useState(flow.fromType ?? null), [fromId, setFromId] = useState(flow.fromId ?? null);
  if (flow.step === "mismatch") return <div className="flow-content"><div className="warning-card"><AlertTriangle size={28} /><div><h3>Key record mismatch</h3><p>The website currently records this key with <strong>{flow.recordedHolderName}</strong>.</p><p>You are reporting that you received it from <strong>{flow.reportedFromName}</strong>.</p></div></div><div className="split-actions"><button className="secondary-action" onClick={close}>Cancel</button><button className="primary-action danger" onClick={() => onConfirm({ roomId: room.id, fromType: flow.fromType, fromId: flow.fromId, reportedFromName: flow.reportedFromName, confirmAnyway: true })}>Confirm Anyway</button></div></div>;
  const choose = (type, id = null) => { setFromType(type); setFromId(id); setFlow((prev) => ({ ...prev, fromType: type, fromId: id })); };
  return <div className="flow-content"><p className="choice-title">Who gave you this key?</p><div className="choice-stack">
    <button className={fromType === "member" ? "choice-card selected" : "choice-card"} onClick={() => choose("member")}><Users size={22} /><span><strong>Club Member</strong></span></button>
    <button className={fromType === "location" && fromId === "sw" ? "choice-card selected" : "choice-card"} onClick={() => choose("location", "sw")}><KeyRound size={22} /><span><strong>SW Office</strong></span></button>
    <button className={fromType === "location" && fromId === "mho" ? "choice-card selected" : "choice-card"} onClick={() => choose("location", "mho")}><KeyRound size={22} /><span><strong>Men's Hostel Office</strong></span></button>
  </div>{fromType === "member" && <MemberPicker currentUser={currentUser} selected={fromId} onSelect={(id) => choose("member", id)} />}{fromType && fromId && <TransferPreview from={holderName(fromType, fromId)} to={memberName(currentUser)} />}<button className="primary-action sticky-action" disabled={!fromType || !fromId} onClick={() => onConfirm({ roomId: room.id, fromType, fromId })}>Confirm Receipt</button></div>;
}

function MemberPicker({ currentUser, selected, onSelect }) { return <div className="member-picker"><span>Select a member</span><div className="member-grid">{MEMBERS.filter((m) => m.id !== currentUser).map((m) => <button key={m.id} className={selected === m.id ? "selected" : ""} onClick={() => onSelect(m.id)}><UserRound size={18} /> {m.name}</button>)}</div></div>; }
function TransferPreview({ from, to }) { return <div className="transfer-preview" aria-label={`${from} to ${to}`}><strong>{from}</strong><ArrowDown size={20} /><strong>{to}</strong></div>; }
function SuccessScreen({ flow, close }) { return <div className="success-screen"><div className="success-icon"><Check size={40} /></div><p className="eyebrow">RECORDED</p><h2>{flow.title}</h2><div className="success-room">{flow.roomName}</div><TransferPreview from={flow.from} to={flow.to} /><button className="primary-action" onClick={close}>Done</button></div>; }

function HistoryView({ data }) { return <div className="content-view"><div className="page-heading"><p className="eyebrow">ACTIVITY LOG</p><h2>History</h2></div>
  <section className="history-section"><h3>Key History</h3>{data.keyTransfers.length === 0 ? <EmptyState icon={KeyRound} text="No key transfers recorded yet." /> : data.keyTransfers.map((t) => <article className="log-row" key={t.id}><div className="log-time">{t.timestamp}</div><div><strong>{data.rooms.find((r) => r.id === t.roomId)?.name}</strong><p>{holderName(t.fromType, t.fromId)} → {holderName(t.toType, t.toId)}</p></div></article>)}</section>
  <section className="history-section"><h3>Session History</h3>{data.sessions.map((s) => <article className="session-log" key={s.id}><div className="session-log__head"><strong>{data.rooms.find((r) => r.id === s.roomId)?.name}</strong><span className={`status ${s.status === "active" ? "status--active" : "status--idle"}`}>{s.status}</span></div><p>{memberName(s.memberId)}</p><div className="time-line"><Clock3 size={16} /> {s.startTime} – {s.endTime ?? "Now"}</div><div className="check-line"><Check size={15} /> Start photos</div><div className={s.endRoomPhoto && s.endCablePhoto ? "check-line" : "check-line muted"}>{s.endRoomPhoto && s.endCablePhoto ? <Check size={15} /> : <Clock3 size={15} />} End photos {s.status === "active" && "pending"}</div></article>)}</section>
  </div>; }

function AdminView({ data, resetDemo }) { const active = data.sessions.filter((s) => s.status === "active"); return <div className="content-view"><div className="page-heading"><p className="eyebrow">PROTOTYPE VIEW</p><h2>Admin Demo</h2></div>
  <section className="admin-section"><h3>Room Status</h3><div className="admin-room-list">{data.rooms.map((r) => { const s = data.sessions.find((x) => x.id === r.activeSessionId); return <article key={r.id}><div><strong>{r.name}</strong><span>{s ? `Active — ${memberName(s.memberId)}` : "Idle"}</span></div><p><KeyRound size={15} /> {holderName(r.keyHolderType, r.keyHolderId)}</p></article>; })}</div></section>
  <section className="admin-section"><h3>Current Flags</h3>{data.flags.length === 0 ? <EmptyState icon={ShieldCheck} text="No custody mismatches recorded." /> : data.flags.map((f) => <article className="flag-card" key={f.id}><AlertTriangle size={22} /><div><strong>Key custody mismatch</strong><p>{data.rooms.find((r) => r.id === f.roomId)?.name}</p><small>Recorded holder: {f.details.previousRecordedHolder}</small><small>Reported transfer: {f.details.reportedFrom} → {f.details.receivedBy}</small></div></article>)}</section>
  <section className="admin-section"><h3>Incomplete Sessions</h3>{active.length === 0 ? <EmptyState icon={CheckCircle2} text="No incomplete sessions." /> : active.map((s) => <article className="incomplete-row" key={s.id}><Clock3 size={20} /><div><strong>{data.rooms.find((r) => r.id === s.roomId)?.name} — {memberName(s.memberId)}</strong><span>Started {s.startTime}</span></div></article>)}</section>
  <button className="reset-button" onClick={resetDemo}><RotateCcw size={18} /> Reset Demo Data</button></div>; }

function EmptyState({ icon: Icon, text }) { return <div className="empty-state"><Icon size={22} /><span>{text}</span></div>; }

function useWebMcp({ data, currentUser, setCurrentUser, resetDemo }) {
  const latest = useRef({ data, currentUser, setCurrentUser, resetDemo }); latest.current = { data, currentUser, setCurrentUser, resetDemo };
  useEffect(() => {
    const context = document.modelContext; if (!context?.registerTool) return undefined;
    const lifecycle = new AbortController(); const register = (tool) => { try { void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => {}); } catch { /* unsupported draft */ } };
    register({ name: "read_music_room_demo_status", title: "Read music room demo status", description: "Read current room-session and key-custody state from the visible prototype.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: false }, execute: () => ({ currentUser: memberName(latest.current.currentUser), rooms: latest.current.data.rooms.map((r) => ({ room: r.name, status: r.activeSessionId ? "active" : "idle", keyHolder: holderName(r.keyHolderType, r.keyHolderId) })) }) });
    register({ name: "switch_music_room_demo_user", title: "Switch demo user", description: "Switch the mock current user shown in the music-room prototype.", inputSchema: { type: "object", properties: { memberId: { type: "string", enum: MEMBERS.map((m) => m.id) } }, required: ["memberId"], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false }, execute: ({ memberId }) => { if (!MEMBERS.some((m) => m.id === memberId)) throw new Error("Unknown mock member"); latest.current.setCurrentUser(memberId); return { currentUser: memberName(memberId) }; } });
    register({ name: "reset_music_room_demo", title: "Reset music room demo", description: "Restore the prototype to its original mock rooms, sessions, and key holders.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false }, execute: () => { latest.current.resetDemo(); return { reset: true }; } });
    return () => lifecycle.abort();
  }, []);
}

createRoot(document.getElementById("root")).render(<App />);
