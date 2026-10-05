import { RECOVERY_REASONS, SESSION_STATUS, roomState } from "./transitions.js";

export const MEMBERS = ["a", "b", "c", "d"].map((letter) => ({ id: `member-${letter}`, name: `Member ${letter.toUpperCase()}` }));
export const memberName = (id) => id === "admin-demo" ? "Admin Demo" : MEMBERS.find((member) => member.id === id)?.name ?? id ?? "Not recorded";
export const holderName = (holder) => holder?.type === "member" ? memberName(holder.id) : ({ sw: "SW Office", mho: "MHO" }[holder?.id] ?? "Not recorded");
export const friendlyTime = (timestamp) => timestamp ? new Intl.DateTimeFormat([], { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp)) : "—";
export const reasonLabel = (reason) => RECOVERY_REASONS[reason] ?? ({ NORMAL_CHECKOUT: "Normal checkout", MISSED_CHECKOUT_SELF_REPORTED: "Member reported leaving without checkout", KEY_MOVED_DURING_ACTIVE_SESSION: "Key moved while checkout was unfinished", ADMIN_RECOVERY: "Closed during admin custody correction" }[reason] ?? reason ?? "Not recorded");
export const newestFirst = (items, field) => [...items].sort((a, b) => (b[field] ?? "").localeCompare(a[field] ?? ""));

export function overview(data) {
  const rooms = data.rooms.map((room) => ({ ...room, ...roomState(data, room.id), openFlags: data.flags.filter((flag) => flag.roomId === room.id && flag.status === "OPEN").length }));
  return {
    rooms,
    activeRooms: rooms.filter((room) => room.kind === "ACTIVE").length,
    idleRooms: rooms.filter((room) => room.kind === "IDLE").length,
    openFlags: data.flags.filter((flag) => flag.status === "OPEN").length,
    active: newestFirst(data.sessions.filter((session) => session.status === SESSION_STATUS.ACTIVE), "startedAt"),
    incomplete: newestFirst(data.sessions.filter((session) => session.status === SESSION_STATUS.INCOMPLETE), "closedAt"),
  };
}

// Include participants in both sides of a custody report, without assigning blame.
export function matchesRecord(record, filters, data) {
  const details = record.details ?? record;
  const flag = data.flags.find((item) => item.id === details.flagId);
  const session = data.sessions.find((item) => item.id === (details.sessionId ?? details.relatedSessionId));
  const roomId = details.roomId ?? flag?.roomId ?? session?.roomId;
  const participants = [record.memberId, record.actorId, details.actorId, details.subjectMemberId, details.closedBy,
    details.triggeredBy, details.receiverId, details.reportingActorId, details.resolvedBy, record.closure?.closedBy,
    record.closure?.actorId, session?.memberId, flag?.subjectMemberId, flag?.receiverId,
    ...[details.previousRecordedHolder, details.reportedSource, details.newHolder].filter((holder) => holder?.type === "member").map((holder) => holder.id)];
  return (!filters.room || filters.room === roomId) && (!filters.member || participants.includes(filters.member)) && (!filters.status || filters.status === record.status);
}

export function evidenceSlots(session) {
  const evidence = [...(session.startEvidence ?? []), ...(session.endEvidence ?? []), ...(session.status === SESSION_STATUS.ACTIVE ? session.endDraftEvidence ?? [] : [])];
  return ["start", "end"].flatMap((stage) => ["room", "cables"].map((category) => {
    const item = evidence.find((entry) => entry.stage === stage && entry.category === category && entry.accepted);
    return { stage, category, label: `${stage === "start" ? "Start" : "End"} ${category === "room" ? "Room" : "Cables"}`, item, captured: !!item, available: !!item?.previewUrl && item.availability === "AVAILABLE" };
  }));
}
