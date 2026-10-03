import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// No <StrictMode>: in development it renders every component twice, which would
// double every render count the React rendering lab reports.
createRoot(document.getElementById('root')).render(<App />);
