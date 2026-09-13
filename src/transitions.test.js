import test from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_STATUS, completeSession, correctCustody, makeInitialData, parseDemoState,
  recordIncomingCustody, recordOutgoingCustody, resolveFlag, selfReportMissedCheckout,
  serializeDemoState, startSession,
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
