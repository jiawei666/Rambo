import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

document.documentElement.dataset.platform = window.rambo.platform;

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
