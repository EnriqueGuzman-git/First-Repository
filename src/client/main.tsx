/**
 * @file main.tsx
 * @description React application entry point.
 *
 * Mounts the root App component into the DOM.
 * StrictMode is enabled in development to surface potential issues early.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './App.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found in index.html');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
