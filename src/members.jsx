import React, { useEffect, useState } from 'react';
import { supabase } from './lib/supabase.js';
import { memberInput, membershipError } from './auth-model.js';
export default function Members({ refreshAuthorization }) {
 const [members, setMembers] = useState([]), [search, setSearch] = useState(''), [filter, setFilter] = useState('ALL');
 const [adding, setAdding] = useState(false), [form, setForm] = useState({ name: '', email: '', role: 'MEMBER' });
 const [confirmation, setConfirmation] = useState(null), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
 const [loading, setLoading] = useState(true);
 const load = async () => { const response = await supabase.from('club_members').select('*').order('name'); if (response.error) throw response.error; setMembers(response.data); };
 useEffect(() => { load().catch(e => setError(membershipError(e))).finally(() => setLoading(false)); }, []);
 const save = async () => {
  if (busy) return; setBusy(true); setError(''); setMessage('');
  try {
   const args = confirmation ? { p_id: confirmation.member.id, ...confirmation.change } : memberInput(form.name, form.email, form.role);
   const { data, error } = await supabase.rpc(confirmation ? 'change_club_member' : 'add_club_member', args);
   if (error) throw error;
   setMessage(confirmation ? `${data.name}'s access has been updated.` : `${data.name} has been added as ${data.role === 'ADMIN' ? 'an Admin' : 'a Member'}. They can now sign in using: ${data.email}`);
   setAdding(false); setConfirmation(null); setForm({ name: '', email: '', role: 'MEMBER' }); await load(); await refreshAuthorization();
  } catch(e) { setError(membershipError(e)); } finally { setBusy(false); }
 };
 const visible = members.filter(m => `${m.name} ${m.email}`.toLowerCase().includes(search.toLowerCase()) && (filter === 'ALL' || (filter === 'DISABLED' ? m.status === filter : m.role === filter)));
 return <section className="members-section"><div className="section-heading"><h3>Members</h3><button className="secondary-action" onClick={() => {setAdding(true); setError('');}}>Add Person</button></div>
 {message && <p className="notice" role="status">{message}</p>}{error && <p className="warning-card" role="alert">{error}</p>}
 <label className="reason-field"><span>Search name or email</span><input type="search" value={search} onChange={e=>setSearch(e.target.value)} /></label>
 <label className="reason-field"><span>Filter</span><select value={filter} onChange={e=>setFilter(e.target.value)}><option value="ALL">All</option><option value="MEMBER">Members</option><option value="ADMIN">Admins</option><option value="DISABLED">Disabled</option></select></label>
 {loading ? <p role="status">Loading members…</p> : <p className="helper">{visible.length} people</p>}
 <div className="admin-grid">{visible.map(m=><article className="admin-card" key={m.id}><h4>{m.name}</h4><p className="member-email">{m.email}</p><p>{m.role} · {m.status}</p><div className="admin-actions"><button className="secondary-action" disabled={busy} onClick={()=>setConfirmation({member:m,change:{p_role:m.role==='ADMIN'?'MEMBER':'ADMIN'}})}>{m.role==='ADMIN'?'Make Member':'Make Admin'}</button><button className="text-action" disabled={busy} onClick={()=>setConfirmation({member:m,change:{p_status:m.status==='ACTIVE'?'DISABLED':'ACTIVE'}})}>{m.status==='ACTIVE'?'Disable':'Re-enable'}</button></div></article>)}</div>
 {(adding || confirmation) && <div className="flow-backdrop" role="dialog" aria-modal="true" aria-label={confirmation ? 'Confirm membership change' : 'Add Person'}><section className="flow-panel">
 {confirmation ? <><h2>{confirmation.change.p_role ? `Make ${confirmation.member.name} ${confirmation.change.p_role==='ADMIN'?'an administrator':'a member'}?` : `${confirmation.change.p_status==='DISABLED'?'Disable':'Re-enable'} ${confirmation.member.name}?`}</h2><p>{confirmation.change.p_role==='ADMIN' ? 'Administrators can view all room/session records and photos, manage club members, resolve flags, and correct key custody.' : confirmation.change.p_role ? 'They will lose administrator permissions and keep member access.' : 'Their identity and historical records will be retained.'}</p></> : <><h2>Add Person</h2>{['name','email'].map(key=><label className="reason-field" key={key}><span>{key==='name'?'Name':'Email'}</span><input type={key==='email'?'email':'text'} maxLength={key==='name'?120:254} value={form[key]} onChange={e=>setForm({...form,[key]:e.target.value})} /></label>)}<label className="reason-field"><span id="member-role-label">Role</span><select aria-labelledby="member-role-label" value={form.role} onChange={e=>setForm({...form,role:e.target.value})}><option value="MEMBER">Member</option><option value="ADMIN">Admin</option></select></label><p className="helper">Use their @vitstudent.ac.in Google email.</p></>}
 {error && <p role="alert" className="warning-text">{error}</p>}<div className="split-actions"><button className="secondary-action" disabled={busy} onClick={()=>{setAdding(false);setConfirmation(null);setError('');}}>Cancel</button><button className="primary-action" disabled={busy} onClick={save}>{busy?'Saving…':confirmation ? 'Confirm' : 'Add'}</button></div>
 </section></div>}
 </section>;
}
