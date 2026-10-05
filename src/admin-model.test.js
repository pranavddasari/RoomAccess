import test from "node:test";
import assert from "node:assert/strict";
import { evidenceSlots, matchesRecord, overview } from "./admin-model.js";
import { makeInitialData, recordIncomingCustody, resolveFlag, startSession } from "./transitions.js";

const evidence = ["room", "cables"].map((category) => ({ id: `start-${category}`, stage: "start", category, accepted: true, previewUrl: "data:image/png;base64,test", availability: "AVAILABLE" }));

test("admin overview lists multiple rooms for one member and keeps active separate from incomplete", () => {
  let state = makeInitialData();
  state.rooms[1].keyHolderType = "member";
  state.rooms[1].keyHolderId = "member-a";
  for (const roomId of ["mr-1", "mr-2"]) state = startSession(state, { roomId, actorId: "member-a", evidence, operationId: roomId, expectedRoomVersion: 0 }).state;
  const before = overview(state);
  assert.equal(before.active.length, 3);
  assert.equal(before.active.filter((session) => session.memberId === "member-a").length, 2);
  assert.equal(before.incomplete.length, 0);
  assert.equal(before.activeRooms, 3);
  const otherRoom = structuredClone(state.sessions.find((session) => session.roomId === "mr-2" && session.status === "ACTIVE"));
  const recovered = recordIncomingCustody(state, { roomId: "mr-1", actorId: "member-b", reportedSource: { type: "member", id: "member-a" }, recoveryReason: "PREVIOUS_BAND_LEFT", operationId: "recover-one", expectedRoomVersion: 1 });
  assert.equal(recovered.ok, true);
  const after = overview(recovered.state);
  assert.equal(after.active.length, 2);
  assert.equal(after.incomplete.length, 1);
  assert.equal(after.incomplete[0].roomId, "mr-1");
  assert.deepEqual(after.active.find((session) => session.roomId === "mr-2"), otherRoom);
  assert.equal(after.openFlags, 1);
  assert.equal(after.rooms.find((room) => room.id === "mr-1").openFlags, 1);
  const recoveredRoom = recovered.state.rooms.find((room) => room.id === "mr-1");
  const nextSession = startSession(recovered.state, { roomId: "mr-1", actorId: "member-b", evidence, operationId: "member-b-start", expectedRoomVersion: recoveredRoom.version });
  assert.equal(nextSession.ok, true);
  assert.equal(nextSession.state.sessions.find((session) => session.id === "session-member-b-start").memberId, "member-b");
  assert.deepEqual(nextSession.state.sessions.find((session) => session.id === "session-mr-1").endEvidence, []);
});

test("evidence distinguishes missing, captured but unavailable, and inspectable photos", () => {
  const session = makeInitialData().sessions[1];
  let slots = evidenceSlots(session);
  assert.equal(slots[0].captured, true);
  assert.equal(slots[0].available, false);
  assert.equal(slots[2].captured, false);
  slots = evidenceSlots({ ...session, startEvidence: evidence });
  assert.equal(slots[0].available, true);
  assert.equal(slots[1].available, true);
});

test("room/member filters include custody participants and resolved flag audit records", () => {
  const recovered = recordIncomingCustody(makeInitialData(), { roomId: "mr-4", actorId: "member-b", reportedSource: { type: "member", id: "member-a" }, recoveryReason: "OTHER", recoveryRemarks: "Key received in the corridor", operationId: "filter-receipt", expectedRoomVersion: 0 });
  const mismatch = recovered.state.flags.find((flag) => flag.type === "KEY_CUSTODY_MISMATCH");
  for (const member of ["member-a", "member-b", "member-d"]) assert.equal(matchesRecord(mismatch, { member, room: "mr-4" }, recovered.state), true);
  assert.equal(matchesRecord(mismatch, { member: "member-c" }, recovered.state), false);
  assert.equal(matchesRecord(mismatch, { room: "mr-1" }, recovered.state), false);
  const resolved = resolveFlag(recovered.state, { flagId: mismatch.id, operationId: "filter-resolve" });
  assert.equal(matchesRecord(resolved.state.flags.find((flag) => flag.id === mismatch.id), { status: "RESOLVED" }, resolved.state), true);
  assert.equal(matchesRecord(resolved.state.auditEvents[0], { member: "member-b", room: "mr-4" }, resolved.state), true);
});
