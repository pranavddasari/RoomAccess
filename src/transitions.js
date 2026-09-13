export const SESSION_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  COMPLETE: "COMPLETE",
  INCOMPLETE: "INCOMPLETE",
});

export const FLAG_TYPE = Object.freeze({
  MISSING_END_CHECKOUT: "MISSING_END_CHECKOUT",
  KEY_CUSTODY_MISMATCH: "KEY_CUSTODY_MISMATCH",
});

const MEMBERS = new Set(["member-a", "member-b", "member-c", "member-d"]);
const LOCATIONS = new Set(["sw", "mho"]);

export const isoNow = () => new Date().toISOString();
export const makeOperationId = (prefix = "operation") =>
  `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const makeId = (prefix, operationId) => `${prefix}-${operationId}`;
const append = (items, item) => [item, ...items];

export function makeInitialData() {
  const activeStartedAt = "2026-09-13T09:34:00.000Z";
  const completeStartedAt = "2026-09-13T07:50:00.000Z";
  const completeClosedAt = "2026-09-13T08:42:00.000Z";
  const fixtureEvidence = (stage, category, acceptedAt) => ({
    id: `fixture-${stage}-${category}-${acceptedAt}`,
    stage,
    category,
    accepted: true,
    acceptedAt,
    fileName: "fixture-photo.jpg",
    mimeType: "image/jpeg",
    previewUrl: null,
    availability: "UNAVAILABLE_AFTER_RELOAD",
  });

  return {
    schemaVersion: 2,
    revision: 0,
    rooms: [
      { id: "mr-1", name: "MR-1", enabled: true, version: 0, keyHolderType: "member", keyHolderId: "member-a", activeSessionId: null },
      { id: "mr-2", name: "MR-2", enabled: true, version: 0, keyHolderType: "location", keyHolderId: "sw", activeSessionId: null },
      { id: "mr-3", name: "MR-3", enabled: true, version: 0, keyHolderType: "member", keyHolderId: "member-c", activeSessionId: null },
      { id: "mr-4", name: "MR-4", enabled: true, version: 0, keyHolderType: "member", keyHolderId: "member-d", activeSessionId: "session-demo-active" },
      { id: "mr-5", name: "MR-5", enabled: true, version: 0, keyHolderType: "location", keyHolderId: "mho", activeSessionId: null },
    ],
    sessions: [
      {
        id: "session-demo-complete",
        roomId: "mr-2",
        memberId: "member-c",
        startedAt: completeStartedAt,
        closedAt: completeClosedAt,
        status: SESSION_STATUS.COMPLETE,
        startEvidence: [fixtureEvidence("start", "room", completeStartedAt), fixtureEvidence("start", "cables", completeStartedAt)],
        endEvidence: [fixtureEvidence("end", "room", completeClosedAt), fixtureEvidence("end", "cables", completeClosedAt)],
        endDraftEvidence: [],
        closure: { outcome: SESSION_STATUS.COMPLETE, reason: "NORMAL_CHECKOUT", actorId: "member-c", timestamp: completeClosedAt, operationId: "fixture-complete", keyDisposition: { type: "location", id: "sw" } },
      },
      {
        id: "session-demo-active",
        roomId: "mr-4",
        memberId: "member-d",
        startedAt: activeStartedAt,
        closedAt: null,
        status: SESSION_STATUS.ACTIVE,
        startEvidence: [fixtureEvidence("start", "room", activeStartedAt), fixtureEvidence("start", "cables", activeStartedAt)],
        endEvidence: [],
        endDraftEvidence: [],
        closure: null,
      },
    ],
    custodyEvents: [],
    flags: [],
    auditEvents: [],
    processedOperations: [],
  };
}

export function friendlyError(code) {
  const messages = {
    DUPLICATE_OPERATION: "This action was already recorded.",
    ROOM_NOT_FOUND: "This room no longer exists.",
    ROOM_DISABLED: "This room is currently disabled.",
    ROOM_ALREADY_ACTIVE: "This room already has an active session.",
    INVALID_ROOM_STATE: "This room has inconsistent demo state and needs an admin correction.",
    NOT_KEY_HOLDER: "You are no longer the recorded key holder.",
    INVALID_EVIDENCE: "Both accepted photos are required.",
    SESSION_NOT_FOUND: "This session no longer exists.",
    SESSION_NOT_ACTIVE: "This session is already closed and cannot be changed.",
    STALE_SESSION: "This checkout belongs to an old session and was rejected.",
    WRONG_ACTOR: "This action belongs to a different mock user.",
    INVALID_DESTINATION: "Choose a valid key destination.",
    SELF_TRANSFER: "Use Keep Key With Me instead of transferring the key to yourself.",
    ACTIVE_SESSION_REQUIRES_CHECKOUT: "Account for the active session before transferring this key.",
    FLAG_NOT_FOUND: "This flag no longer exists.",
    FLAG_ALREADY_RESOLVED: "This flag has already been resolved.",
    REASON_REQUIRED: "Enter a short reason for the custody correction.",
  };
  return messages[code] ?? "This action could not be completed.";
}

function failure(code, state) {
  return { ok: false, code, error: friendlyError(code), state };
}

function success(state, operationId) {
  return { ok: true, state: { ...state, revision: state.revision + 1, processedOperations: [...state.processedOperations, operationId] }, operationId };
}

function begin(state, operationId) {
  if (!operationId || state.processedOperations.includes(operationId)) return failure("DUPLICATE_OPERATION", state);
  return null;
}

function validHolder(type, id) {
  return type === "member" ? MEMBERS.has(id) : type === "location" && LOCATIONS.has(id);
}

function validDestination(type, id, actorId) {
  if (!validHolder(type, id)) return "INVALID_DESTINATION";
  if (type === "member" && id === actorId) return "SELF_TRANSFER";
  return null;
}

export function hasRequiredEvidence(evidence, stage, requireAvailable = false) {
  if (!Array.isArray(evidence)) return false;
  return ["room", "cables"].every((category) =>
    evidence.some((item) => item?.stage === stage && item?.category === category && item.accepted === true && item.id && (!requireAvailable || (item.availability === "AVAILABLE" && item.previewUrl))),
  );
}

export function validateState(state) {
  const issues = [];
  if (!state || state.schemaVersion !== 2 || !Array.isArray(state.rooms) || !Array.isArray(state.sessions)
    || !Array.isArray(state.custodyEvents) || !Array.isArray(state.flags) || !Array.isArray(state.auditEvents)
    || !Array.isArray(state.processedOperations) || typeof state.revision !== "number") {
    return [{ code: "INVALID_SCHEMA", message: "Saved demo state has an unsupported structure." }];
  }
  for (const room of state.rooms) {
    const activeForRoom = state.sessions.filter((session) => session.roomId === room.id && session.status === SESSION_STATUS.ACTIVE);
    if (activeForRoom.length > 1) issues.push({ code: "MULTIPLE_ACTIVE_SESSIONS", roomId: room.id, message: `${room.name} has more than one active session.` });
    if (room.activeSessionId) {
      const linked = state.sessions.find((session) => session.id === room.activeSessionId);
      if (!linked) issues.push({ code: "MISSING_ACTIVE_SESSION", roomId: room.id, message: `${room.name} points to a missing session.` });
      else if (linked.roomId !== room.id || linked.status !== SESSION_STATUS.ACTIVE) issues.push({ code: "INVALID_ACTIVE_SESSION", roomId: room.id, message: `${room.name} points to a non-active or different-room session.` });
      else if (room.keyHolderType !== "member" || room.keyHolderId !== linked.memberId) issues.push({ code: "ACTIVE_KEY_HOLDER_MISMATCH", roomId: room.id, message: `${room.name}'s active session owner and recorded key holder do not match.` });
    } else if (activeForRoom.length) {
      issues.push({ code: "UNLINKED_ACTIVE_SESSION", roomId: room.id, message: `${room.name} has an active session that is not linked from the room.` });
    }
    if (!validHolder(room.keyHolderType, room.keyHolderId)) issues.push({ code: "INVALID_KEY_HOLDER", roomId: room.id, message: `${room.name} has an invalid key holder.` });
  }
  return issues;
}

export function roomState(state, roomId) {
  const room = state.rooms.find((item) => item.id === roomId);
  if (!room) return { kind: "INVALID", room: null, session: null, issues: [{ code: "ROOM_NOT_FOUND" }] };
  const issues = validateState(state).filter((issue) => issue.roomId === roomId);
  if (issues.length) return { kind: "INVALID", room, session: null, issues };
  const session = room.activeSessionId ? state.sessions.find((item) => item.id === room.activeSessionId) : null;
  return { kind: session ? "ACTIVE" : "IDLE", room, session, issues: [] };
}

function audit(type, operationId, timestamp, actorId, details) {
  return { id: makeId("audit", `${operationId}-${type}`), type, operationId, timestamp, actorId, details };
}

function custodyEvent({ operationId, timestamp, roomId, mode, previous, reportedSource = null, next, actorId, relatedSessionId = null, reason = null, mismatch = false }) {
  return { id: makeId("custody", operationId), operationId, timestamp, roomId, mode, previousRecordedHolder: previous, reportedSource, newHolder: next, actorId, relatedSessionId, reason, mismatch };
}

function missingCheckoutFlag({ operationId, timestamp, roomId, session, actorId, reason, evidence }) {
  return {
    id: makeId("flag-missing", operationId),
    type: FLAG_TYPE.MISSING_END_CHECKOUT,
    status: "OPEN",
    roomId,
    sessionId: session.id,
    subjectMemberId: session.memberId,
    createdAt: timestamp,
    triggeredBy: actorId,
    reason,
    evidenceSnapshot: evidence,
    resolvedBy: null,
    resolvedAt: null,
    resolutionNote: "",
  };
}

function mismatchFlag({ operationId, timestamp, roomId, previous, reportedSource, receiverId, actorId }) {
  return {
    id: makeId("flag-mismatch", operationId),
    type: FLAG_TYPE.KEY_CUSTODY_MISMATCH,
    status: "OPEN",
    roomId,
    sessionId: null,
    subjectMemberId: null,
    createdAt: timestamp,
    triggeredBy: actorId,
    previousRecordedHolder: previous,
    reportedSource,
    receiverId,
    reportingActorId: actorId,
    resolvedBy: null,
    resolvedAt: null,
    resolutionNote: "",
  };
}

function closeIncompleteParts(state, { room, session, actorId, reason, timestamp, operationId }) {
  const endEvidence = Array.isArray(session.endDraftEvidence) ? session.endDraftEvidence : [];
  const closedSession = {
    ...session,
    status: SESSION_STATUS.INCOMPLETE,
    closedAt: timestamp,
    endEvidence,
    endDraftEvidence: [],
    closure: { outcome: SESSION_STATUS.INCOMPLETE, reason, actorId, timestamp, operationId, keyDisposition: null },
  };
  const flag = missingCheckoutFlag({ operationId, timestamp, roomId: room.id, session: closedSession, actorId, reason, evidence: { start: closedSession.startEvidence, end: closedSession.endEvidence } });
  return {
    session: closedSession,
    flag,
    event: audit("SESSION_CLOSED", operationId, timestamp, actorId, { sessionId: session.id, roomId: room.id, outcome: SESSION_STATUS.INCOMPLETE, reason, evidenceSnapshot: flag.evidenceSnapshot, keyDisposition: null }),
  };
}

export function startSession(state, command) {
  const { roomId, actorId, evidence, operationId, timestamp = isoNow(), expectedRoomVersion } = command;
  const duplicate = begin(state, operationId); if (duplicate) return duplicate;
  const derived = roomState(state, roomId);
  if (!derived.room) return failure("ROOM_NOT_FOUND", state);
  if (derived.kind === "INVALID") return failure("INVALID_ROOM_STATE", state);
  const { room } = derived;
  if (!room.enabled) return failure("ROOM_DISABLED", state);
  if (derived.kind === "ACTIVE") return failure("ROOM_ALREADY_ACTIVE", state);
  if (expectedRoomVersion !== room.version) return failure("INVALID_ROOM_STATE", state);
  if (room.keyHolderType !== "member" || room.keyHolderId !== actorId) return failure("NOT_KEY_HOLDER", state);
  if (!hasRequiredEvidence(evidence, "start", true)) return failure("INVALID_EVIDENCE", state);
  const sessionId = makeId("session", operationId);
  const session = { id: sessionId, roomId, memberId: actorId, startedAt: timestamp, closedAt: null, status: SESSION_STATUS.ACTIVE, startEvidence: evidence, endEvidence: [], endDraftEvidence: [], closure: null };
  const next = {
    ...state,
    rooms: state.rooms.map((item) => item.id === roomId ? { ...item, activeSessionId: sessionId, version: item.version + 1 } : item),
    sessions: append(state.sessions, session),
    auditEvents: append(state.auditEvents, audit("SESSION_STARTED", operationId, timestamp, actorId, { sessionId, roomId, evidenceSnapshot: { start: evidence } })),
  };
  return success(next, operationId);
}

export function saveEndDraftEvidence(state, command) {
  const { roomId, sessionId, actorId, evidence } = command;
  const derived = roomState(state, roomId);
  if (derived.kind !== "ACTIVE" || derived.session?.id !== sessionId) return failure("STALE_SESSION", state);
  if (derived.session.memberId !== actorId) return failure("WRONG_ACTOR", state);
  if (!Array.isArray(evidence)) return failure("INVALID_EVIDENCE", state);
  return { ok: true, state: { ...state, revision: state.revision + 1, sessions: state.sessions.map((session) => session.id === sessionId ? { ...session, endDraftEvidence: evidence } : session) } };
}

export function completeSession(state, command) {
  const { roomId, sessionId, actorId, evidence, disposition, operationId, timestamp = isoNow(), expectedRoomVersion } = command;
  const duplicate = begin(state, operationId); if (duplicate) return duplicate;
  const derived = roomState(state, roomId);
  if (!derived.room) return failure("ROOM_NOT_FOUND", state);
  if (derived.kind === "INVALID") return failure("INVALID_ROOM_STATE", state);
  if (derived.kind !== "ACTIVE" || derived.session?.id !== sessionId) return failure("STALE_SESSION", state);
  const { room, session } = derived;
  if (expectedRoomVersion !== room.version) return failure("INVALID_ROOM_STATE", state);
  if (session.status !== SESSION_STATUS.ACTIVE) return failure("SESSION_NOT_ACTIVE", state);
  if (session.memberId !== actorId) return failure("WRONG_ACTOR", state);
  if (room.keyHolderType !== "member" || room.keyHolderId !== actorId) return failure("NOT_KEY_HOLDER", state);
  if (!hasRequiredEvidence(session.startEvidence, "start") || !hasRequiredEvidence(evidence, "end", true)) return failure("INVALID_EVIDENCE", state);
  if (!disposition || !["retain", "member", "location"].includes(disposition.type)) return failure("INVALID_DESTINATION", state);
  if (disposition.type !== "retain") {
    const destinationError = validDestination(disposition.type, disposition.id, actorId);
    if (destinationError) return failure(destinationError, state);
  }
  const keyDisposition = disposition.type === "retain" ? { type: "retain", id: actorId } : disposition;
  const closedSession = { ...session, status: SESSION_STATUS.COMPLETE, closedAt: timestamp, endEvidence: evidence, endDraftEvidence: [], closure: { outcome: SESSION_STATUS.COMPLETE, reason: "NORMAL_CHECKOUT", actorId, timestamp, operationId, keyDisposition } };
  let custodyEvents = state.custodyEvents;
  let auditEvents = append(state.auditEvents, audit("SESSION_CLOSED", operationId, timestamp, actorId, { sessionId, roomId, outcome: SESSION_STATUS.COMPLETE, reason: "NORMAL_CHECKOUT", evidenceSnapshot: { start: session.startEvidence, end: evidence }, keyDisposition }));
  const nextHolder = disposition.type === "retain" ? { type: room.keyHolderType, id: room.keyHolderId } : { type: disposition.type, id: disposition.id };
  if (disposition.type !== "retain") {
    const event = custodyEvent({ operationId, timestamp, roomId, mode: "OUTGOING", previous: { type: room.keyHolderType, id: room.keyHolderId }, next: nextHolder, actorId, relatedSessionId: sessionId });
    custodyEvents = append(custodyEvents, event);
    auditEvents = append(auditEvents, audit("KEY_CUSTODY_RECORDED", operationId, timestamp, actorId, event));
  }
  const next = {
    ...state,
    rooms: state.rooms.map((item) => item.id === roomId ? { ...item, activeSessionId: null, version: item.version + 1, keyHolderType: nextHolder.type, keyHolderId: nextHolder.id } : item),
    sessions: state.sessions.map((item) => item.id === sessionId ? closedSession : item),
    custodyEvents,
    auditEvents,
  };
  return success(next, operationId);
}

export function selfReportMissedCheckout(state, command) {
  const { roomId, sessionId, actorId, operationId, timestamp = isoNow(), expectedRoomVersion } = command;
  const duplicate = begin(state, operationId); if (duplicate) return duplicate;
  const derived = roomState(state, roomId);
  if (!derived.room) return failure("ROOM_NOT_FOUND", state);
  if (derived.kind === "INVALID") return failure("INVALID_ROOM_STATE", state);
  if (derived.kind !== "ACTIVE" || derived.session?.id !== sessionId) return failure("STALE_SESSION", state);
  if (derived.room.version !== expectedRoomVersion) return failure("INVALID_ROOM_STATE", state);
  if (derived.session.memberId !== actorId) return failure("WRONG_ACTOR", state);
  const closed = closeIncompleteParts(state, { room: derived.room, session: derived.session, actorId, reason: "MISSED_CHECKOUT_SELF_REPORTED", timestamp, operationId });
  const next = {
    ...state,
    rooms: state.rooms.map((room) => room.id === roomId ? { ...room, activeSessionId: null, version: room.version + 1 } : room),
    sessions: state.sessions.map((session) => session.id === sessionId ? closed.session : session),
    flags: append(state.flags, closed.flag),
    auditEvents: append(state.auditEvents, closed.event),
  };
  return success(next, operationId);
}

export function recordIncomingCustody(state, command) {
  const { roomId, actorId, reportedSource, operationId, timestamp = isoNow(), expectedRoomVersion } = command;
  const duplicate = begin(state, operationId); if (duplicate) return duplicate;
  const derived = roomState(state, roomId);
  if (!derived.room) return failure("ROOM_NOT_FOUND", state);
  if (derived.kind === "INVALID") return failure("INVALID_ROOM_STATE", state);
  const { room, session } = derived;
  if (room.version !== expectedRoomVersion) return failure("INVALID_ROOM_STATE", state);
  if (!MEMBERS.has(actorId) || !reportedSource || !validHolder(reportedSource.type, reportedSource.id)) return failure("INVALID_DESTINATION", state);
  if (reportedSource.type === "member" && reportedSource.id === actorId) return failure("SELF_TRANSFER", state);
  const previous = { type: room.keyHolderType, id: room.keyHolderId };
  const nextHolder = { type: "member", id: actorId };
  const mismatch = previous.type !== reportedSource.type || previous.id !== reportedSource.id;
  let sessions = state.sessions;
  let flags = state.flags;
  let auditEvents = state.auditEvents;
  let relatedSessionId = null;
  if (session && session.memberId !== actorId) {
    const closed = closeIncompleteParts(state, { room, session, actorId, reason: "KEY_MOVED_DURING_ACTIVE_SESSION", timestamp, operationId });
    sessions = state.sessions.map((item) => item.id === session.id ? closed.session : item);
    flags = append(flags, closed.flag);
    auditEvents = append(auditEvents, closed.event);
    relatedSessionId = session.id;
  }
  if (mismatch) flags = append(flags, mismatchFlag({ operationId, timestamp, roomId, previous, reportedSource, receiverId: actorId, actorId }));
  const event = custodyEvent({ operationId, timestamp, roomId, mode: "INCOMING", previous, reportedSource, next: nextHolder, actorId, relatedSessionId, mismatch });
  auditEvents = append(auditEvents, audit("KEY_CUSTODY_RECORDED", operationId, timestamp, actorId, event));
  const next = {
    ...state,
    rooms: state.rooms.map((item) => item.id === roomId ? { ...item, activeSessionId: session && session.memberId !== actorId ? null : item.activeSessionId, version: item.version + 1, keyHolderType: "member", keyHolderId: actorId } : item),
    sessions,
    custodyEvents: append(state.custodyEvents, event),
    flags,
    auditEvents,
  };
  return success(next, operationId);
}

export function recordOutgoingCustody(state, command) {
  const { roomId, actorId, destination, operationId, timestamp = isoNow(), expectedRoomVersion } = command;
  const duplicate = begin(state, operationId); if (duplicate) return duplicate;
  const derived = roomState(state, roomId);
  if (!derived.room) return failure("ROOM_NOT_FOUND", state);
  if (derived.kind === "INVALID") return failure("INVALID_ROOM_STATE", state);
  if (derived.kind === "ACTIVE") return failure("ACTIVE_SESSION_REQUIRES_CHECKOUT", state);
  const { room } = derived;
  if (room.version !== expectedRoomVersion) return failure("INVALID_ROOM_STATE", state);
  if (room.keyHolderType !== "member" || room.keyHolderId !== actorId) return failure("NOT_KEY_HOLDER", state);
  const destinationError = validDestination(destination?.type, destination?.id, actorId);
  if (destinationError) return failure(destinationError, state);
  const previous = { type: room.keyHolderType, id: room.keyHolderId };
  const nextHolder = { type: destination.type, id: destination.id };
  const event = custodyEvent({ operationId, timestamp, roomId, mode: "OUTGOING", previous, next: nextHolder, actorId });
  const next = {
    ...state,
    rooms: state.rooms.map((item) => item.id === roomId ? { ...item, version: item.version + 1, keyHolderType: nextHolder.type, keyHolderId: nextHolder.id } : item),
    custodyEvents: append(state.custodyEvents, event),
    auditEvents: append(state.auditEvents, audit("KEY_CUSTODY_RECORDED", operationId, timestamp, actorId, event)),
  };
  return success(next, operationId);
}

export function resolveFlag(state, command) {
  const { flagId, actorId = "admin-demo", note = "", operationId, timestamp = isoNow() } = command;
  const duplicate = begin(state, operationId); if (duplicate) return duplicate;
  const flag = state.flags.find((item) => item.id === flagId);
  if (!flag) return failure("FLAG_NOT_FOUND", state);
  if (flag.status === "RESOLVED") return failure("FLAG_ALREADY_RESOLVED", state);
  const resolved = { ...flag, status: "RESOLVED", resolvedBy: actorId, resolvedAt: timestamp, resolutionNote: note.trim().slice(0, 160) };
  const next = { ...state, flags: state.flags.map((item) => item.id === flagId ? resolved : item), auditEvents: append(state.auditEvents, audit("FLAG_RESOLVED", operationId, timestamp, actorId, { flagId, note: resolved.resolutionNote })) };
  return success(next, operationId);
}

export function correctCustody(state, command) {
  const { roomId, actorId = "admin-demo", destination, reason, operationId, timestamp = isoNow(), expectedRoomVersion } = command;
  const duplicate = begin(state, operationId); if (duplicate) return duplicate;
  const room = state.rooms.find((item) => item.id === roomId);
  if (!room) return failure("ROOM_NOT_FOUND", state);
  if (room.version !== expectedRoomVersion) return failure("INVALID_ROOM_STATE", state);
  if (!reason?.trim()) return failure("REASON_REQUIRED", state);
  if (!validHolder(destination?.type, destination?.id)) return failure("INVALID_DESTINATION", state);
  const session = room.activeSessionId
    ? state.sessions.find((item) => item.id === room.activeSessionId && item.roomId === roomId && item.status === SESSION_STATUS.ACTIVE)
    : null;
  const previous = { type: room.keyHolderType, id: room.keyHolderId };
  const nextHolder = { type: destination.type, id: destination.id };
  let sessions = state.sessions;
  let flags = state.flags;
  let auditEvents = state.auditEvents;
  let relatedSessionId = null;
  const incompatible = session && !(nextHolder.type === "member" && nextHolder.id === session.memberId);
  if (incompatible) {
    const closed = closeIncompleteParts(state, { room, session, actorId, reason: "ADMIN_RECOVERY", timestamp, operationId });
    sessions = state.sessions.map((item) => item.id === session.id ? closed.session : item);
    flags = append(flags, closed.flag);
    auditEvents = append(auditEvents, closed.event);
    relatedSessionId = session.id;
  }
  const event = custodyEvent({ operationId, timestamp, roomId, mode: "ADMIN_CORRECTION", previous, next: nextHolder, actorId, relatedSessionId, reason: reason.trim() });
  auditEvents = append(auditEvents, audit("KEY_CUSTODY_RECORDED", operationId, timestamp, actorId, event));
  const next = {
    ...state,
    rooms: state.rooms.map((item) => item.id === roomId ? { ...item, activeSessionId: incompatible ? null : item.activeSessionId, version: item.version + 1, keyHolderType: nextHolder.type, keyHolderId: nextHolder.id } : item),
    sessions,
    custodyEvents: append(state.custodyEvents, event),
    flags,
    auditEvents,
  };
  return success(next, operationId);
}

export function serializeDemoState(state) {
  const copy = structuredClone(state);
  const strip = (evidence) => evidence.map((item) => item.previewUrl ? { ...item, previewUrl: null, availability: "UNAVAILABLE_AFTER_RELOAD" } : item);
  copy.sessions = copy.sessions.map((session) => ({ ...session, startEvidence: strip(session.startEvidence ?? []), endEvidence: strip(session.endEvidence ?? []), endDraftEvidence: strip(session.endDraftEvidence ?? []) }));
  return JSON.stringify(copy);
}

export function parseDemoState(raw) {
  try {
    const parsed = JSON.parse(raw);
    return validateState(parsed).some((issue) => issue.code === "INVALID_SCHEMA") ? null : parsed;
  } catch {
    return null;
  }
}
