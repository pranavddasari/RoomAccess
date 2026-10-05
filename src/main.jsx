import React, { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowLeft, Camera, Check, CheckCircle2, Clock3, History, ImageOff, KeyRound, Music2, RotateCcw, ShieldCheck, UserRound, Users, X } from "lucide-react";
import { FLAG_TYPE, RECOVERY_REASONS, SESSION_STATUS } from "./transitions.js";
import AdminView from "./admin.jsx";
import { canAdmin } from "./auth-model.js";
import { setMemberDirectory } from "./admin-model.js";
import { loadOperations, runCommand, operationId, sharedRoomState as roomState, subscribeOperations } from "./data/operations.js";
import { uploadPhoto } from "./data/photos.js";
import PrivatePhoto from "./private-photo.jsx";
let MEMBERS = [];
let ACTIVE_MEMBERS = [];
const LOCATIONS = { sw: "SW Office", mho: "Men's Hostel Office (MHO)" };
const memberName = (id) => MEMBERS.find((member) => member.id === id)?.name ?? id;
const holderName = (holderOrType, id) => {
  const type = typeof holderOrType === "object" ? holderOrType?.type : holderOrType;
  const holderId = typeof holderOrType === "object" ? holderOrType?.id : id;
  return type === "member" ? memberName(holderId) : LOCATIONS[holderId] ?? "Key status not initialized";
};
const friendlyTime = (timestamp) => timestamp ? new Intl.DateTimeFormat([], { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp)) : "—";
const reasonLabel = (reason) => ({
  NORMAL_CHECKOUT: "Normal checkout",
  MISSED_CHECKOUT_SELF_REPORTED: "Member reported leaving without checkout",
  KEY_MOVED_DURING_ACTIVE_SESSION: "Key moved while checkout was unfinished",
  ADMIN_RECOVERY: "Closed during admin custody correction",
}[reason] ?? reason);

export default function App({ member, directory, signOut, refresh }) {
  ACTIVE_MEMBERS = directory;
  const [names,setNames] = useState(directory);
  MEMBERS = names;
  setMemberDirectory(names);
  const isAdmin = canAdmin(member), currentUser = member.id;
  const [data,setData] = useState(null), [tab,setTab] = useState("rooms"), [flow,setFlow] = useState(null);
  const [notice,setNotice] = useState(null), [busy,setBusy] = useState(false);
  const profileRole = useRef(member.role); profileRole.current=member.role;
  const mutation = useRef(false), request = useRef(0), mounted=useRef(true), previews=useRef(new Set());
  const reload = async () => {
    const run=++request.current, authorizedRole=profileRole.current;
    const loaded=await loadOperations();
    if(mounted.current && run===request.current) {setData({...loaded.data,profileRole:authorizedRole});setNames(loaded.names);}
    return loaded.data;
  };
  useEffect(()=>{
    mounted.current=true;
    const load=()=>reload().catch(e=>{if(mounted.current)setNotice(e.message || 'Could not refresh shared state. Try again.');});
    void load();const unsubscribe=subscribeOperations(load);
    return ()=>{mounted.current=false;++request.current;unsubscribe();for(const url of previews.current)URL.revokeObjectURL(url);};
  },[]);
  useEffect(()=>{
    if(!flow || flow.type==='success'){for(const url of previews.current)URL.revokeObjectURL(url);previews.current.clear();}
  },[flow?.type]);
  useEffect(()=>{
    if(data && data.profileRole!==member.role)void reload().catch(e=>setNotice(e.message));
  },[member.role]);
  const execute = async (action, roomId, options, success) => {
    if(mutation.current)return false;mutation.current=true;setBusy(true);setNotice(null);
    try {await runCommand(action,roomId,options);const latest=await reload();success?.(latest);return true;}
    catch(e){setNotice(e.message || 'Could not save. Retry after refreshing shared state.');try{await reload();}catch{/* Original error stays visible. */}return false;}
    finally{mutation.current=false;setBusy(false);}
  };
  const openFlow = (type,room,session=null) => {
    if(type==='admin-correct' && !isAdmin)return;
    setFlow({type,roomId:room.id,sessionId:session?.id??(type==='start'?operationId():null),actorId:currentUser,roomVersion:room.version,operationId:operationId(),evidence:session?.endDraftEvidence??[],step:'choose'});
  };
  const options = (payload={}) => ({operation:flow.operationId,version:flow.roomVersion,session:flow.sessionId,payload});
  const roomName = () => data.rooms.find(r=>r.id===flow.roomId)?.name;
  const showSuccess=(title,detail)=>setFlow({type:'success',title,roomName:roomName(),detail});
  const start=()=>execute('START',flow.roomId,options({roomPhoto:flow.evidence.find(p=>p.category==='room'),cablesPhoto:flow.evidence.find(p=>p.category==='cables')}),()=>setFlow(null));
  const finish=destination=>execute('END',flow.roomId,options({destination}),()=>showSuccess('Session Complete',destination.type==='retain'?`${memberName(currentUser)} retained the key.`:`${memberName(currentUser)} → ${holderName(destination)}`));
  const selfRecover=()=>execute('SELF_RECOVER',flow.roomId,options(),()=>showSuccess('Session Marked Incomplete',`Key remains with ${memberName(currentUser)}.`));
  const transfer=destination=>execute('TRANSFER',flow.roomId,options({destination}),()=>showSuccess('Key Transfer Recorded',`${memberName(currentUser)} → ${holderName(destination)}`));
  const receive=()=>{
    const source=flow.reportedSource;if(!source?.id)return;
    const room=data.rooms.find(r=>r.id===flow.roomId);
    const mismatch=room.keyHolderType!==source.type || room.keyHolderId!==source.id;
    if((mismatch || room.activeSessionId) && flow.step!=='confirm'){setFlow(previous=>({...previous,step:'confirm'}));return;}
    return execute('RECEIVE',flow.roomId,options({source,recoveryReason:flow.recoveryReason,recoveryRemarks:flow.recoveryRemarks??''}),()=>showSuccess('Key Received',`Reported ${holderName(source)} → ${memberName(currentUser)}`));
  };
  const resolveAdminFlag=(flagId,note)=>{
    if(!isAdmin)return false;const flag=data.flags.find(f=>f.id===flagId);
    return execute('RESOLVE_FLAG',flag.roomId,{operation:operationId(),version:null,payload:{flagId,note}});
  };
  const correctAdminCustody=(destination,reason)=>isAdmin && execute('CORRECT',flow.roomId,options({destination,reason}),()=>showSuccess('Custody Corrected',`Current key holder: ${holderName(destination)}`));
  const acceptPhoto=async candidate=>{
    if(mutation.current)throw new Error('Another action is still being saved.');mutation.current=true;setBusy(true);
    try {
      const saved=await uploadPhoto(candidate.file,{id:operationId(),sessionId:flow.sessionId,stage:candidate.stage,category:candidate.category});
      previews.current.add(saved.previewUrl);
      if(candidate.stage==='end') {
        const result=await runCommand('END_PHOTO',flow.roomId,{operation:operationId(),version:flow.roomVersion,session:flow.sessionId,payload:{...saved,category:saved.category.toUpperCase()}});
        setFlow(previous=>({...previous,roomVersion:result.version}));await reload();
      }
      return saved;
    }catch(e){try{await reload();}catch{}throw e;}
    finally{mutation.current=false;setBusy(false);}
  };
  const saveEndEvidence=evidence=>setFlow(previous=>({...previous,evidence}));
  const close=()=>{if(!mutation.current)setFlow(null);};
  if(!data || data.profileRole!==member.role)return <div className="app-shell"><p role="status">Loading shared room state…</p>{notice&&<p role="alert">{notice}</p>}<button className="secondary-action" onClick={()=>reload().then(()=>setNotice(null)).catch(e=>setNotice(e.message))}>Retry</button><button className="text-action" onClick={signOut}>Sign Out</button></div>;
  return <div className={`app-shell ${tab==='admin'?'app-shell--admin':''}`}>
    <header className="topbar"><div className="brand-mark"><Music2 size={20}/></div><div><p className="eyebrow">COLLEGE MUSIC CLUB</p><h1>Music Club Rooms</h1></div></header>
    <section className="account-area"><div><strong>{member.name}</strong><span>{member.email}</span><span>{isAdmin?'Admin':'Member'}</span></div><button className="text-action" disabled={busy} onClick={signOut}>Sign Out</button></section>
    {notice&&<div className="notice" role="alert">{notice}<button onClick={()=>setNotice(null)} aria-label="Dismiss message"><X size={16}/></button></div>}
    <main>{tab==='rooms'&&<RoomsView data={data} currentUser={currentUser} openFlow={openFlow}/>}{tab==='history'&&<HistoryView data={data}/>}
    {tab==='admin'&&(isAdmin?<AdminView data={data} issues={[]} resolveFlag={resolveAdminFlag} busy={busy} openCorrection={room=>openFlow('admin-correct',room,data.sessions.find(s=>s.id===room.activeSessionId))} member={member} refreshAuthorization={refresh}/>:<p role="alert">Administrator access required.</p>)}</main>
    <BottomNav isAdmin={isAdmin} tab={tab} setTab={next=>{if(!busy){setTab(next);setFlow(null);}}} activeCount={data.sessions.filter(s=>s.status==='ACTIVE').length}/>
    {flow&&(flow.type!=='admin-correct'||isAdmin)&&<FlowPanel flow={flow} data={data} currentUser={currentUser} busy={busy} close={close} setFlow={setFlow} start={start} saveEndEvidence={saveEndEvidence} onUpload={acceptPhoto} finish={finish} selfRecover={selfRecover} transfer={transfer} receive={receive} correctCustody={correctAdminCustody}/>}
    {busy&&<p className="saving-indicator" role="status">Saving…</p>}
  </div>;
}

function RoomsView({ data, currentUser, openFlow }) {
  return <>

    <div className="section-heading"><h2>Rooms</h2><span>{data.sessions.filter((session) => session.status === SESSION_STATUS.ACTIVE).length} active</span></div>
    <section className="room-list" aria-label="Music rooms">{data.rooms.map((room) => {
      const derived = roomState(data, room.id);
      const session = derived.session;
      const ownsKey = room.keyHolderType === "member" && room.keyHolderId === currentUser;
      const ownsSession = session?.memberId === currentUser;
      return <article className={`room-card ${session ? "is-active" : ""} ${derived.kind === "INVALID" ? "is-invalid" : ""}`} key={room.id}>
        <div className="room-card__header"><h3>{room.name}</h3><span className={`status ${derived.kind === "INVALID" ? "status--error" : session ? "status--active" : "status--idle"}`}>{derived.kind === "INVALID" ? "STATE ISSUE" : session ? "SESSION ACTIVE" : "IDLE"}</span></div>
        {derived.kind === "INVALID" ? <p className="warning-text">{derived.issues[0]?.message}</p> : session ? <div className="session-summary"><strong>{memberName(session.memberId)}</strong><span>Started {friendlyTime(session.startedAt)}</span><EvidenceSummary evidence={session.startEvidence} compact /></div> : <p className="room-state">{derived.kind === "UNINITIALIZED" ? "Key custody needs initialization" : "Ready for a session"}</p>}
        <div className="key-row"><KeyRound size={18} /><span>Key</span><strong>{holderName(room.keyHolderType, room.keyHolderId)}</strong></div>
        {derived.kind === "UNINITIALIZED" ? <p className="helper">Key status not initialized. An administrator must record physical custody first.</p> : derived.kind === "INVALID" ? <p className="helper">Ask a club administrator to correct this room’s current custody.</p> : session ? ownsSession ? <div className="card-actions"><button className="primary-action danger" onClick={() => openFlow("end", room, session)}>End Session</button><button className="recovery-action" onClick={() => openFlow("missed", room, session)}>I already left without checking out</button></div> : <div className="card-actions"><p className="occupied-note">This room has an unfinished session from {memberName(session.memberId)}.</p><button className="secondary-action" onClick={() => openFlow("receive", room, session)}>I Received This Key</button></div>
          : ownsKey ? <div className="card-actions"><button className="primary-action" onClick={() => openFlow("start", room)}>Start Session</button><button className="text-action" onClick={() => openFlow("transfer", room)}>Transfer Key</button></div>
          : <><p className="helper">You need to have the {room.name} key before starting a session.</p><button className="secondary-action" onClick={() => openFlow("receive", room)}>I Received This Key</button></>}
      </article>;
    })}</section>
  </>;
}

export function BottomNav({ tab, setTab, activeCount, isAdmin }) {
  return <nav className="bottom-nav" aria-label="Main navigation">
    <button className={tab === "rooms" ? "selected" : ""} onClick={() => setTab("rooms")}><Music2 size={18} /> Rooms</button>
    <button className={tab === "history" ? "selected" : ""} onClick={() => setTab("history")}><History size={18} /> History</button>
    {isAdmin && <button className={tab === "admin" ? "selected" : ""} onClick={() => setTab("admin")}><ShieldCheck size={18} /> Admin {activeCount > 0 && <span className="nav-count">{activeCount}</span>}</button>}
  </nav>;
}

function FlowPanel(props) {
  const { flow, data, close } = props;
  const room = data.rooms.find((item) => item.id === flow.roomId);
  const session = data.sessions.find((item) => item.id === flow.sessionId);
  if (flow.type === "success") return <Dialog label={flow.title}><SuccessScreen flow={flow} close={close} /></Dialog>;
  const heading = flow.type === "start" ? `START ${room?.name} SESSION` : flow.type === "end" ? `END ${room?.name} SESSION` : flow.type === "receive" ? `I RECEIVED THE ${room?.name} KEY` : flow.type === "transfer" ? `TRANSFER ${room?.name} KEY` : flow.type === "missed" ? "MISSED CHECKOUT" : `CORRECT ${room?.name} CUSTODY`;
  return <Dialog label={heading}><button className="flow-close" onClick={close} aria-label="Close"><X size={22} /></button><button className="back-link" onClick={close}><ArrowLeft size={18} /> Back</button><h2>{heading}</h2>
    {flow.type === "start" && <PhotoFlow onUpload={props.onUpload} stage="start" roomName={room.name} evidence={flow.evidence} onChange={(evidence) => props.setFlow((previous) => ({ ...previous, evidence }))} onComplete={props.start} busy={props.busy} />}
    {flow.type === "end" && <EndFlow onUpload={props.onUpload} flow={flow} room={room} evidence={flow.evidence} onEvidenceChange={props.saveEndEvidence} setFlow={props.setFlow} finish={props.finish} busy={props.busy} />}
    {flow.type === "missed" && <MissedCheckoutFlow room={room} session={session} busy={props.busy} confirm={props.selfRecover} close={close} />}
    {flow.type === "transfer" && <DestinationPicker currentUser={flow.actorId} title="Who are you giving the key to?" confirmLabel="Confirm Key Transfer" onConfirm={props.transfer} busy={props.busy} />}
    {flow.type === "receive" && <ReceiveFlow flow={flow} room={room} session={session} currentUser={flow.actorId} setFlow={props.setFlow} confirm={props.receive} busy={props.busy} close={close} />}
    {flow.type === "admin-correct" && <AdminCorrectionFlow room={room} data={data} close={close} onConfirm={props.correctCustody} busy={props.busy} />}
  </Dialog>;
}

function Dialog({ label, children }) { return <div className="flow-backdrop" role="dialog" aria-modal="true" aria-label={label}><section className="flow-panel">{children}</section></div>; }

function PhotoFlow({ stage, roomName, evidence, onChange, onComplete, continueLabel, busy, onUpload }) {
  const accepted = (category) => evidence.find((item) => item.category === category && item.stage === stage && item.accepted);
  const accept = async (candidate) => { const item=await onUpload(candidate); onChange([...evidence.filter((existing) => !(existing.stage === stage && existing.category === item.category)), item]); };
  const beginReplacement = (category) => onChange(evidence.filter((existing) => !(existing.stage === stage && existing.category === category)));
  const ready = [accepted("room"), accepted("cables")].every((item) => item?.accepted && (item.storagePath || item.previewUrl));
  return <div className="flow-content"><p className="flow-intro">{stage === "start" ? "Before using the room, take two photos." : "Before leaving the room, take two photos."}</p>
    <PhotoCapture title="Overall room condition" label="Room Photo" stage={stage} category="room" acceptedEvidence={accepted("room")} onReplacementSelected={beginReplacement} onAccept={accept} busy={busy} />
    <PhotoCapture title="Cables / equipment condition" label="Cable Photo" stage={stage} category="cables" acceptedEvidence={accepted("cables")} onReplacementSelected={beginReplacement} onAccept={accept} busy={busy} />
    <button className="primary-action sticky-action" disabled={!ready || busy} onClick={onComplete}>{ready ? (continueLabel ?? `Start ${roomName} Session`) : "Add both photos to continue"}</button>
  </div>;
}

function PhotoCapture({ title, label, stage, category, acceptedEvidence, onReplacementSelected, onAccept, busy }) {
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
      setCandidate({ id: operationId(), file, stage, category, accepted: false, acceptedAt: null, fileName: file.name, mimeType: file.type, previewUrl, availability: "AVAILABLE" });
    } catch { setError("This image could not be displayed. Choose or take another photo."); }
  };
  const usePhoto = async () => { if (!candidate || busy) return; setError(null); try { await onAccept(candidate); setCandidate(null); } catch(e) { setError(e.message || "Upload failed. Try again."); } };
  return <section className={`photo-capture ${acceptedEvidence ? "photo-capture--ready" : ""}`}>
    <div className="photo-title-row"><div><span className="photo-kicker">REQUIRED PHOTO</span><h3>{title}</h3></div>{acceptedEvidence && !candidate && <span className="ready-check"><Check size={16} /> Used</span>}</div>
    <input ref={inputRef} className="visually-hidden" type="file" accept="image/*" capture="environment" onChange={selectFile} aria-label={`Take or choose ${label.toLowerCase()}`} />
    {!displayed ? <button className="camera-action" disabled={busy} onClick={() => inputRef.current?.click()}><Camera size={24} /> Take {label}</button> : <>
      {displayed.previewUrl ? <div className="photo-preview-wrap"><img className="photo-preview" src={displayed.previewUrl} alt={`${label} preview`} /><span className="preview-status"><CheckCircle2 size={17} /> {candidate ? "Photo ready" : "Photo used"}</span></div> : <PrivatePhoto photo={displayed} label={label} />}
      <div className="photo-actions"><button className="secondary-action" disabled={busy} onClick={() => inputRef.current?.click()}><RotateCcw size={18} /> Retake</button>{candidate && <button className="primary-action" disabled={busy} onClick={usePhoto}><Check size={18} /> {busy ? "Uploading…" : "Use Photo"}</button>}</div>
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

function EndFlow({ flow, room, evidence, onEvidenceChange, setFlow, finish, busy, onUpload }) {
  if (flow.step === "disposition") return <DestinationPicker includeRetain currentUser={flow.actorId} title={`What are you doing with the ${room.name} key?`} confirmLabel="Confirm & Complete Session" onConfirm={finish} busy={busy} />;
  return <PhotoFlow onUpload={onUpload} stage="end" roomName={room.name} evidence={evidence} onChange={onEvidenceChange} continueLabel="Continue to Key Disposition" onComplete={() => setFlow((previous) => ({ ...previous, step: "disposition" }))} busy={busy} />;
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
  const recoveryReady = !consequence || (flow.recoveryReason && (flow.recoveryReason !== "OTHER" || flow.recoveryRemarks?.trim()));
  if (flow.step === "confirm") return <div className="flow-content">{consequence && <><RecoveryConsequence room={room} session={session} /><p>Reason: {RECOVERY_REASONS[flow.recoveryReason]}</p><p>Remarks by {memberName(currentUser)}: {flow.recoveryRemarks?.trim() || "None provided"}</p></>}{mismatch && <div className="warning-card"><AlertTriangle size={28} /><div><h3>Key record mismatch</h3><p>Website record: <strong>{holderName(room.keyHolderType, room.keyHolderId)}</strong></p><p>You reported: <strong>{holderName(source)} → {memberName(currentUser)}</strong></p></div></div>}<TransferPreview from={holderName(source)} to={memberName(currentUser)} /><button className="text-action" onClick={() => setFlow((previous) => ({ ...previous, step: "choose" }))}>Edit receipt details</button><div className="split-actions"><button className="secondary-action" onClick={close}>Cancel</button><button className="primary-action danger" disabled={busy || !recoveryReady} onClick={confirm}>{consequence ? "Confirm Recovery & Receipt" : "Confirm Receipt"}</button></div></div>;
  return <div className="flow-content">{consequence && <RecoveryConsequence room={room} session={session} />}<p className="choice-title">Who gave you this key?</p><SourcePicker currentUser={currentUser} source={source} onSelect={(reportedSource) => setFlow((previous) => ({ ...previous, reportedSource }))} />{consequence && <><label className="reason-field"><span>Recovery reason (required)</span><select value={flow.recoveryReason ?? ""} onChange={(event) => setFlow((previous) => ({ ...previous, recoveryReason: event.target.value }))}><option value="">Choose a reason</option>{Object.entries(RECOVERY_REASONS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="reason-field"><span>Recovery remarks ({flow.recoveryReason === "OTHER" ? "required" : "optional"})</span><textarea maxLength={500} value={flow.recoveryRemarks ?? ""} onChange={(event) => setFlow((previous) => ({ ...previous, recoveryRemarks: event.target.value }))} /></label><p className="helper">Recorded as your report, alongside the previous member’s unchanged evidence.</p></>}{source?.id && <TransferPreview from={holderName(source)} to={memberName(currentUser)} />}<button className="primary-action sticky-action" disabled={!source?.id || !recoveryReady || busy} onClick={confirm}>{consequence || mismatch ? "Review Receipt" : "Confirm Receipt"}</button></div>;
}

function RecoveryConsequence({ room, session }) { return <div className="consequence-card"><AlertTriangle size={22} /><p><strong>{room.name}</strong> still has an unfinished session from {memberName(session.memberId)}. Continuing will mark that session as incomplete. Missing checkout photos cannot be added later. This action will be recorded for admin review.</p></div>; }

function SourcePicker({ currentUser, source, onSelect }) { return <div className="choice-stack"><button className={source?.type === "member" ? "choice-card selected" : "choice-card"} onClick={() => onSelect({ type: "member", id: null })}><Users size={22} /><span><strong>Club Member</strong></span></button><button className={source?.type === "location" && source.id === "sw" ? "choice-card selected" : "choice-card"} onClick={() => onSelect({ type: "location", id: "sw" })}><KeyRound size={22} /><span><strong>SW Office</strong></span></button><button className={source?.type === "location" && source.id === "mho" ? "choice-card selected" : "choice-card"} onClick={() => onSelect({ type: "location", id: "mho" })}><KeyRound size={22} /><span><strong>Men's Hostel Office</strong></span></button>{source?.type === "member" && <MemberPicker excludedId={currentUser} selected={source.id} onSelect={(id) => onSelect({ type: "member", id })} />}</div>; }
function MemberPicker({ excludedId, selected, onSelect }) { return <div className="member-picker"><span>Select a member</span><div className="member-grid">{ACTIVE_MEMBERS.filter((member) => member.id !== excludedId).map((member) => <button key={member.id} className={selected === member.id ? "selected" : ""} onClick={() => onSelect(member.id)}><UserRound size={18} /> {member.name}</button>)}</div></div>; }

function AdminCorrectionFlow({ room, data, close, onConfirm, busy }) {
  const [destination, setDestination] = useState(null); const [reason, setReason] = useState("");
  const structuralIssue = false;
  const closing = destination?.id ? data.sessions.filter((session) => session.roomId === room.id && session.status === SESSION_STATUS.ACTIVE && (structuralIssue || destination.type !== "member" || destination.id !== session.memberId)) : [];
  return <div className="flow-content"><p className="flow-intro">Current key holder: <strong>{holderName(room.keyHolderType, room.keyHolderId)}</strong></p><HolderPicker destination={destination} setDestination={setDestination} /><label className="reason-field"><span>Reason for correction (required)</span><input value={reason} maxLength={160} onChange={(event) => setReason(event.target.value)} placeholder="Example: Key verified at SW Office" /></label>{closing.map((session) => <div className="consequence-card" key={session.id}><AlertTriangle size={22} /><p>{room.name} has an active session belonging to {memberName(session.memberId)}. This correction will close that session as incomplete and create a missing-checkout flag. Missing photos cannot be added later.</p></div>)}<div className="split-actions"><button className="secondary-action" onClick={close}>Cancel</button><button className="primary-action sticky-action" disabled={!destination?.id || !reason.trim() || busy} onClick={() => onConfirm(destination, reason)}>Confirm Correction</button></div></div>;
}
function HolderPicker({ destination, setDestination }) { return <div className="choice-stack"><button className={destination?.type === "member" ? "choice-card selected" : "choice-card"} onClick={() => setDestination({ type: "member", id: null })}><Users size={22} /><span><strong>Club Member</strong></span></button><button className={destination?.type === "location" && destination.id === "sw" ? "choice-card selected" : "choice-card"} onClick={() => setDestination({ type: "location", id: "sw" })}><KeyRound size={22} /><span><strong>SW Office</strong></span></button><button className={destination?.type === "location" && destination.id === "mho" ? "choice-card selected" : "choice-card"} onClick={() => setDestination({ type: "location", id: "mho" })}><KeyRound size={22} /><span><strong>Men's Hostel Office</strong></span></button>{destination?.type === "member" && <MemberPicker selected={destination.id} onSelect={(id) => setDestination({ type: "member", id })} />}</div>; }

function EvidenceSummary({ evidence = [], stage, compact = false }) {
  const stages = stage ? [stage] : ["start", "end"];
  return <div className={compact ? "evidence-summary compact" : "evidence-summary"}>{stages.map((currentStage) => <div key={currentStage}><span>{currentStage === "start" ? "Start" : "End"}</span>{["room", "cables"].map((category) => { const item = evidence.find((entry) => entry.stage === currentStage && entry.category === category && entry.accepted); const unavailable = item?.availability === "UNAVAILABLE_AFTER_RELOAD"; return <small key={category} className={item && !unavailable ? "has-evidence" : "missing-evidence"}>{unavailable ? <ImageOff size={14} /> : item ? <Check size={14} /> : <X size={14} />}{category === "room" ? "Room" : "Cables"}{unavailable && " · captured previously; preview unavailable"}</small>; })}</div>)}</div>;
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
function HistoryView({ data }) { return <div className="content-view"><div className="page-heading"><p className="eyebrow">ACTIVITY LOG</p><h2>History</h2><p className="helper">Shared retained history · approximately the last 30 days</p></div><section className="history-section"><h3>Key / Custody History</h3>{data.custodyEvents.length ? data.custodyEvents.map((event) => <CustodyCard key={event.id} event={event} data={data} />) : <EmptyState icon={KeyRound} text="No custody events recorded yet." />}</section><section className="history-section"><h3>Session History</h3>{data.sessions.map((session) => <SessionCard key={session.id} session={session} data={data} />)}</section></div>; }

function EmptyState({ icon: Icon, text }) { return <div className="empty-state"><Icon size={22} /><span>{text}</span></div>; }
