import { createRoot } from 'react-dom/client';
import App from './App';

/** Render without StrictMode's duplicate development requests to keep local usage lean. */
const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
createRoot(root).render(<App />);
