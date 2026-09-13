import test from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_STATUS, completeSession, correctCustody, makeInitialData, parseDemoState,
  recordIncomingCustody, recordOutgoingCustody, resolveFlag, selfReportMissedCheckout,
  saveEndDraftEvidence, serializeDemoState, startSession,
} from "./transitions.js";

const evidence = (stage, suffix = "x") => ["room", "cables"].map((category) => ({
  id: `${stage}-${category}-${suffix}`, stage, category, accepted: true,
  acceptedAt: "2026-09-14T10:00:00.000Z", fileName: `${category}.jpg`, mimeType: "image/jpeg",
  previewUrl: `data:image/jpeg;base64,${suffix}`, availability: "AVAILABLE",
}));

function startA(state, roomId, operationId) {
  const room = state.rooms.find((item) => item.id === roomId);
  return startSession(state, { roomId, actorId: "member-a", evidence: evidence("start", operationId), operationId, timestamp: "2026-09-14T10:00:00.000Z", expectedRoomVersion: room.version });
}

test("one user may start multiple rooms but one room gets one active session", () => {
  let state = makeInitialData();
  state = { ...state, rooms: state.rooms.map((room) => room.id === "mr-2" ? { ...room, keyHolderType: "member", keyHolderId: "member-a" } : room) };
  const first = startA(state, "mr-1", "start-1"); assert.equal(first.ok, true);
  const second = startA(first.state, "mr-2", "start-2"); assert.equal(second.ok, true);
  assert.equal(second.state.sessions.filter((session) => session.memberId === "member-a" && session.status === SESSION_STATUS.ACTIVE).length, 2);
  const duplicateRoom = startA(second.state, "mr-1", "start-3"); assert.equal(duplicateRoom.ok, false); assert.equal(duplicateRoom.code, "ROOM_ALREADY_ACTIVE");
});

test("normal checkout can retain the key without a custody event", () => {
  const started = startA(makeInitialData(), "mr-1", "start-retain");
  const room = started.state.rooms.find((item) => item.id === "mr-1");
  const result = completeSession(started.state, { roomId: "mr-1", sessionId: room.activeSessionId, actorId: "member-a", evidence: evidence("end"), disposition: { type: "retain" }, operationId: "complete-retain", expectedRoomVersion: room.version });
  assert.equal(result.ok, true);
  assert.equal(result.state.rooms.find((item) => item.id === "mr-1").keyHolderId, "member-a");
  assert.equal(result.state.custodyEvents.length, 0);
  assert.equal(result.state.sessions.find((item) => item.id === room.activeSessionId).status, SESSION_STATUS.COMPLETE);
});

test("self-reported missed checkout is terminal and flagged", () => {
  const started = startA(makeInitialData(), "mr-1", "start-missed");
  const room = started.state.rooms.find((item) => item.id === "mr-1");
  const result = selfReportMissedCheckout(started.state, { roomId: "mr-1", sessionId: room.activeSessionId, actorId: "member-a", operationId: "missed", expectedRoomVersion: room.version });
  assert.equal(result.ok, true);
  const session = result.state.sessions.find((item) => item.id === room.activeSessionId);
  assert.equal(session.status, SESSION_STATUS.INCOMPLETE);
  assert.equal(result.state.flags[0].type, "MISSING_END_CHECKOUT");
  assert.equal(result.state.rooms.find((item) => item.id === "mr-1").keyHolderId, "member-a");
  const late = completeSession(result.state, { roomId: "mr-1", sessionId: session.id, actorId: "member-a", evidence: evidence("end"), disposition: { type: "retain" }, operationId: "late", expectedRoomVersion: result.state.rooms[0].version });
  assert.equal(late.ok, false); assert.equal(late.code, "STALE_SESSION");
});

test("incoming receipt closes another member's session and preserves source mismatch", () => {
  const started = startA(makeInitialData(), "mr-1", "start-receipt");
  const room = started.state.rooms.find((item) => item.id === "mr-1");
  const result = recordIncomingCustody(started.state, { roomId: "mr-1", actorId: "member-b", reportedSource: { type: "member", id: "member-c" }, operationId: "incoming", expectedRoomVersion: room.version });
  assert.equal(result.ok, true);
  assert.equal(result.state.sessions.find((item) => item.id === room.activeSessionId).status, SESSION_STATUS.INCOMPLETE);
  assert.equal(result.state.rooms.find((item) => item.id === "mr-1").keyHolderId, "member-b");
  assert.equal(result.state.custodyEvents[0].previousRecordedHolder.id, "member-a");
  assert.equal(result.state.custodyEvents[0].reportedSource.id, "member-c");
  assert.equal(result.state.flags.filter((flag) => flag.type === "KEY_CUSTODY_MISMATCH").length, 1);
});

test("duplicate operations and invalid outgoing transfers are rejected", () => {
  const state = makeInitialData();
  const room = state.rooms[0];
  const first = recordOutgoingCustody(state, { roomId: room.id, actorId: "member-a", destination: { type: "member", id: "member-b" }, operationId: "transfer", expectedRoomVersion: room.version });
  assert.equal(first.ok, true);
  const duplicate = recordOutgoingCustody(first.state, { roomId: room.id, actorId: "member-a", destination: { type: "member", id: "member-b" }, operationId: "transfer", expectedRoomVersion: room.version });
  assert.equal(duplicate.code, "DUPLICATE_OPERATION");
  const self = recordOutgoingCustody(state, { roomId: room.id, actorId: "member-a", destination: { type: "member", id: "member-a" }, operationId: "self", expectedRoomVersion: room.version });
  assert.equal(self.code, "SELF_TRANSFER");
});

test("admin correction closes an incompatible session and flag resolution preserves it", () => {
  const started = startA(makeInitialData(), "mr-1", "start-admin");
  const room = started.state.rooms.find((item) => item.id === "mr-1");
  const corrected = correctCustody(started.state, { roomId: "mr-1", destination: { type: "location", id: "sw" }, reason: "Physical key verified at SW", operationId: "correct", expectedRoomVersion: room.version });
  assert.equal(corrected.ok, true);
  const session = corrected.state.sessions.find((item) => item.id === room.activeSessionId);
  assert.equal(session.status, SESSION_STATUS.INCOMPLETE);
  const flag = corrected.state.flags.find((item) => item.type === "MISSING_END_CHECKOUT");
  const resolved = resolveFlag(corrected.state, { flagId: flag.id, operationId: "resolve", note: "Reviewed" });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.state.flags.find((item) => item.id === flag.id).status, "RESOLVED");
  assert.equal(resolved.state.sessions.find((item) => item.id === session.id).status, SESSION_STATUS.INCOMPLETE);
});

test("serialization marks temporary photo previews unavailable", () => {
  const started = startA(makeInitialData(), "mr-1", "start-persist");
  const restored = parseDemoState(serializeDemoState(started.state));
  const session = restored.sessions.find((item) => item.id === "session-start-persist");
  assert.equal(session.startEvidence[0].previewUrl, null);
  assert.equal(session.startEvidence[0].availability, "UNAVAILABLE_AFTER_RELOAD");
});

test("unavailable restored end drafts cannot complete checkout", () => {
  const started = startA(makeInitialData(), "mr-1", "start-reload-end");
  const room = started.state.rooms.find((item) => item.id === "mr-1");
  const withDraft = { ...started.state, sessions: started.state.sessions.map((session) => session.id === room.activeSessionId ? { ...session, endDraftEvidence: evidence("end", "draft") } : session) };
  const restored = parseDemoState(serializeDemoState(withDraft));
  const result = completeSession(restored, { roomId: room.id, sessionId: room.activeSessionId, actorId: "member-a", evidence: restored.sessions.find((session) => session.id === room.activeSessionId).endDraftEvidence, disposition: { type: "retain" }, operationId: "complete-after-reload", expectedRoomVersion: room.version });
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_EVIDENCE");
});

test("admin correction can close an active session with mismatched custody", () => {
  const started = startA(makeInitialData(), "mr-1", "start-inconsistent");
  const inconsistent = { ...started.state, rooms: started.state.rooms.map((room) => room.id === "mr-1" ? { ...room, keyHolderId: "member-b" } : room) };
  const room = inconsistent.rooms.find((item) => item.id === "mr-1");
  const result = correctCustody(inconsistent, { roomId: room.id, destination: { type: "member", id: "member-b" }, reason: "Verified with current holder", operationId: "repair-inconsistent", expectedRoomVersion: room.version });
  assert.equal(result.ok, true);
  assert.equal(result.state.rooms.find((item) => item.id === room.id).activeSessionId, null);
  assert.equal(result.state.sessions.find((item) => item.id === room.activeSessionId).status, SESSION_STATUS.INCOMPLETE);
});

test("partial end evidence is preserved when receipt recovery closes a session", () => {
  const started = startA(makeInitialData(), "mr-1", "start-partial");
  const room = started.state.rooms.find((item) => item.id === "mr-1");
  const partial = [evidence("end", "partial")[0]];
  const drafted = saveEndDraftEvidence(started.state, { roomId: room.id, sessionId: room.activeSessionId, actorId: "member-a", evidence: partial });
  assert.equal(drafted.ok, true);
  const recovered = recordIncomingCustody(drafted.state, { roomId: room.id, actorId: "member-b", reportedSource: { type: "member", id: "member-a" }, operationId: "recover-partial", expectedRoomVersion: room.version });
  const closed = recovered.state.sessions.find((item) => item.id === room.activeSessionId);
  assert.equal(closed.status, SESSION_STATUS.INCOMPLETE);
  assert.equal(closed.endEvidence.length, 1);
  assert.equal(closed.endEvidence[0].category, "room");
});

test("completing one room never changes another active room", () => {
  let state = makeInitialData();
  state = { ...state, rooms: state.rooms.map((room) => room.id === "mr-2" ? { ...room, keyHolderType: "member", keyHolderId: "member-a" } : room) };
  const first = startA(state, "mr-1", "isolated-1");
  const second = startA(first.state, "mr-2", "isolated-2");
  const roomOne = second.state.rooms.find((item) => item.id === "mr-1");
  const roomTwo = second.state.rooms.find((item) => item.id === "mr-2");
  const completed = completeSession(second.state, { roomId: roomOne.id, sessionId: roomOne.activeSessionId, actorId: "member-a", evidence: evidence("end", "isolated"), disposition: { type: "member", id: "member-b" }, operationId: "complete-isolated", expectedRoomVersion: roomOne.version });
  assert.equal(completed.ok, true);
  assert.equal(completed.state.rooms.find((item) => item.id === "mr-2").activeSessionId, roomTwo.activeSessionId);
  assert.equal(completed.state.sessions.find((item) => item.id === roomTwo.activeSessionId).status, SESSION_STATUS.ACTIVE);
});

test("admin correction recovers dangling pointers and duplicate active sessions", () => {
  let state = makeInitialData();
  state = { ...state, rooms: state.rooms.map((room) => room.id === "mr-1" ? { ...room, activeSessionId: "missing-session" } : room) };
  let room = state.rooms.find((item) => item.id === "mr-1");
  const dangling = correctCustody(state, { roomId: room.id, destination: { type: "location", id: "sw" }, reason: "Repair dangling pointer", operationId: "repair-dangling", expectedRoomVersion: room.version });
  assert.equal(dangling.ok, true);
  assert.equal(dangling.state.rooms.find((item) => item.id === room.id).activeSessionId, null);

  const started = startA(makeInitialData(), "mr-1", "first-duplicate");
  room = started.state.rooms.find((item) => item.id === "mr-1");
  const duplicateSession = { ...started.state.sessions.find((item) => item.id === room.activeSessionId), id: "duplicate-active" };
  const corrupt = { ...started.state, sessions: [duplicateSession, ...started.state.sessions] };
  const recovered = correctCustody(corrupt, { roomId: room.id, destination: { type: "location", id: "sw" }, reason: "Close duplicate sessions", operationId: "repair-duplicates", expectedRoomVersion: room.version });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.state.sessions.filter((item) => item.roomId === room.id && item.status === SESSION_STATUS.ACTIVE).length, 0);
  assert.equal(recovered.state.flags.filter((item) => item.type === "MISSING_END_CHECKOUT").length, 2);
});

test("malformed persisted data is rejected", () => {
  assert.equal(parseDemoState('{"schemaVersion":2,"rooms":[],"sessions":[]}'), null);
});
