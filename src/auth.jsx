import React, { useEffect, useRef, useState } from 'react';
import { supabase, configurationError } from './lib/supabase.js';
import { denialMessages, resolveAuthorization } from './auth-model.js';

export function AccessScreen({ state, error, login, signOut, retry }) {
 return <div className="auth-shell"><section className="auth-card"><p className="eyebrow">MUSIC CLUB</p><h1>Room &amp; Key Tracker</h1>
 {state === 'LOADING' ? <p role="status">Checking your access…</p> : state === 'LOGIN' ? <><p>Sign in using your VIT student Google account.</p><button className="primary-action" onClick={login}>Continue with Google</button><p className="helper">Only @vitstudent.ac.in accounts are permitted.</p></> : <><p role="alert">{error || denialMessages[state]}</p>{state === 'ERROR' && <button className="secondary-action" onClick={retry}>Try Again</button>}{state !== 'CONFIGURATION' && <button className="secondary-action" onClick={signOut}>Sign Out{state === 'DOMAIN_DENIED' && ' / Try Another Account'}</button>}</>}
 </section></div>;
}
export default function AuthGate({ children }) {
 const [auth, setAuth] = useState({ state: configurationError ? 'CONFIGURATION' : 'LOADING', error: configurationError });
 const generation = useRef(0);
 const refresh = async () => {
  const run = ++generation.current;
  setAuth(previous => previous.state === 'ACTIVE' ? previous : { state: 'LOADING' });
  try {
   const { data, error } = await supabase.auth.getSession(); if (error) throw error;
   const result = await resolveAuthorization(supabase, data.session);
   let directory = [];
   if (result.state === 'ACTIVE') { const response = await supabase.rpc('member_directory'); if (response.error) throw response.error; directory = response.data; }
   if (run === generation.current) setAuth({ ...result, directory });
  } catch (error) { if (run === generation.current) setAuth({ state: 'ERROR', error: error.message }); }
 };
 useEffect(() => {
  if (!supabase) return;
  const callbackError = new URLSearchParams(location.hash.slice(1)).get('error_description') || new URLSearchParams(location.search).get('error_description');
  if (callbackError) { history.replaceState(null, '', location.pathname); setAuth({ state: 'DOMAIN_DENIED', error: `${denialMessages.DOMAIN_DENIED} ${callbackError}` }); } else void refresh();
  // Defer Supabase calls outside onAuthStateChange to avoid its session lock.
  const { data: { subscription } } = supabase.auth.onAuthStateChange(() => { setTimeout(refresh, 0); });
  const timer = setInterval(refresh, 60000);
  const focus = () => void refresh(); window.addEventListener('focus', focus);
  return () => { ++generation.current; subscription.unsubscribe(); clearInterval(timer); window.removeEventListener('focus', focus); };
 }, []);
 const signOut = async () => {
  ++generation.current; setAuth({ state: 'LOADING' });
  const { error } = await supabase.auth.signOut({ scope: 'local' });
  setAuth(error ? { state: 'ERROR', error: error.message } : { state: 'LOGIN' });
 };
 const login = async () => {
  setAuth({ state: 'LOADING' });
  const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + '/', queryParams: { hd: 'vitstudent.ac.in', prompt: 'select_account' } } });
  if (error) setAuth({ state: 'ERROR', error: error.message });
 };
 return auth.state === 'ACTIVE' ? children({ member: auth.member, directory: auth.directory, signOut, refresh }) : <AccessScreen {...auth} login={login} signOut={signOut} retry={refresh} />;
}
