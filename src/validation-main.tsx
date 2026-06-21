import React from 'react';
import { createRoot } from 'react-dom/client';
import { ValidationApp } from './components/validation/ValidationApp';
import './components/validation/validation-console.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ValidationApp />
  </React.StrictMode>,
);
