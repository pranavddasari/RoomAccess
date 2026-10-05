import { supabase } from '../lib/supabase.js';
export const operationId = () => crypto.randomUUID();
import { adaptSnapshot } from './shared-model.js';
export { sharedRoomState } from './shared-model.js';
export async function loadOperations() {
 const [{data,error},names]=await Promise.all([supabase.rpc('operational_snapshot'),supabase.rpc('operational_directory')]);
 if(error)throw error;if(names.error)throw names.error;
 return {data:adaptSnapshot(data),names:names.data};
}
export async function runCommand(action,room,{operation=operationId(),version,session=null,payload={}}={}) {
 const {data,error}=await supabase.rpc('operational_command',{p_operation_id:operation,p_action:action,p_room_id:room,p_expected_version:version,p_session_id:session,p_payload:payload});
 if(error)throw error;return data;
}
export function subscribeOperations(refresh) {
 let timer, realtimeReady=false;
 const schedule=()=>{clearTimeout(timer);timer=setTimeout(refresh,150);};
 const channel=supabase.channel(`room-state-${crypto.randomUUID()}`).on('postgres_changes',{event:'UPDATE',schema:'public',table:'rooms'},schedule).subscribe(status=>{realtimeReady=status==='SUBSCRIBED';});
 const focus=()=>schedule(),visible=()=>{if(document.visibilityState==='visible')schedule();};
 window.addEventListener('focus',focus);document.addEventListener('visibilitychange',visible);
 // Modest fallback if Realtime disconnects/misses a broadcast.
 const fallback=setInterval(()=>{if(!realtimeReady && document.visibilityState==='visible')schedule();},30000);
 return ()=>{clearTimeout(timer);clearInterval(fallback);void supabase.removeChannel(channel);window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',visible);};
}
