import React from 'react';
import { createRoot } from 'react-dom/client';
const App = React.lazy(() => import('./main.jsx'));
import AuthGate from './auth.jsx';
import './styles.css';
const root = createRoot(document.getElementById('root'));
root.render(<AuthGate>{props => <React.Suspense fallback={<p role="status">Loading rooms…</p>}><App key={props.member.auth_user_id} {...props} /></React.Suspense>}</AuthGate>);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
