import {StrictMode, useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App';
import './style.css';
import {AdminMenu} from './AdminMenu';
function Root() {
  const [admin, setAdmin] = useState(location.hash === '#/admin');
  useEffect(() => {
    const change = () => setAdmin(location.hash === '#/admin');
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  return admin ? <AdminMenu/> : <App/>;
}
const operator = import.meta.env.DEV || import.meta.env.MODE === 'operator';
createRoot(document.getElementById('root')!).render(<StrictMode>{operator ? <Root/> : <App/>}</StrictMode>);
