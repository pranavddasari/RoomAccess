const evidence = photo => ({ id: photo.id, stage: photo.stage.toLowerCase(), category: photo.category.toLowerCase(), accepted: true, acceptedAt: photo.uploaded_at, storagePath: photo.storage_path, mimeType: photo.mime_type, byteSize: photo.byte_size, availability: 'AVAILABLE', previewUrl: null });
export function adaptSnapshot(snapshot) {
 const { rooms = [], keys = [], sessions = [], photos = [], custody = [], flags = [], audit = [] } = snapshot;
 const sessionRows = sessions.map(s => {
  const all = photos.filter(p => p.session_id === s.id).map(evidence);
  return { id:s.id, roomId:s.room_id, memberId:s.member_id, status:s.status, startedAt:s.started_at, closedAt:s.closed_at, version:s.version,
   startEvidence:all.some(p=>p.stage==='start') ? all.filter(p=>p.stage==='start') : s.status==='ACTIVE' ? ['room','cables'].map(category=>({stage:'start',category,accepted:true,availability:'PRIVATE'})) : [], endEvidence:all.filter(p=>p.stage==='end'), endDraftEvidence:all.filter(p=>p.stage==='end'),
   closure:s.status==='ACTIVE' ? null : { reason:s.closure_reason, closedBy:s.closed_by, recoveryReason:s.recovery_reason, recoveryRemarks:s.recovery_remarks, keyDisposition:s.key_disposition } };
 });
 const events=custody.map(e=>({id:e.id,roomId:e.room_id,previousRecordedHolder:e.previous_recorded_holder,reportedSource:e.reported_source,newHolder:e.new_holder,mode:e.mode,actorId:e.actor_id,relatedSessionId:e.session_id,mismatch:e.mismatch,reason:e.reason,timestamp:e.created_at}));
 return { shared:true,schemaVersion:2,revision:0,processedOperations:[], rooms:rooms.map(r=>{
  const key=keys.find(k=>k.room_id===r.id),active=sessionRows.find(s=>s.roomId===r.id && s.status==='ACTIVE');
  return {id:r.id,name:r.display_name,enabled:r.active,version:r.version,keyHolderType:!key?'uninitialized':key.holder_type==='MEMBER'?'member':'location',keyHolderId:!key?null:key.holder_type==='MEMBER'?key.holder_member_id:key.holder_type.toLowerCase(),activeSessionId:active?.id??null};
 }),sessions:sessionRows,custodyEvents:events,
 flags:flags.map(f=>{const e=events.find(e=>e.id===f.custody_event_id),s=sessionRows.find(s=>s.id===f.session_id);return {id:f.id,type:f.type,roomId:f.room_id,sessionId:f.session_id,subjectMemberId:f.subject_member_id,status:f.status,createdAt:f.created_at,resolvedAt:f.resolved_at,resolvedBy:f.resolved_by,resolutionNote:f.resolution_note,
 previousRecordedHolder:e?.previousRecordedHolder,reportedSource:e?.reportedSource,receiverId:e?.newHolder?.id,reportingActorId:e?.actorId,closedBy:s?.closure?.closedBy,recoveryReason:s?.closure?.recoveryReason,recoveryRemarks:s?.closure?.recoveryRemarks};}),
 auditEvents:audit.map(e=>({id:e.id,type:e.event,actorId:e.actor_id,timestamp:e.created_at,details:{...e.details,roomId:e.room_id,sessionId:e.session_id,custodyEventId:e.custody_event_id}})) };
}
export function sharedRoomState(data,roomId) {
 const room=data.rooms.find(r=>r.id===roomId), session=data.sessions.find(s=>s.id===room?.activeSessionId);
 return { room,session,kind:room?.keyHolderType==='uninitialized'?'UNINITIALIZED':session?'ACTIVE':'IDLE',issues:[] };
}
