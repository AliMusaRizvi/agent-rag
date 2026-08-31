import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { Toaster } from 'react-hot-toast';
import { ErrorBoundary } from './components/ErrorBoundary';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
    <Toaster
      position="top-right" 
      toastOptions={{
        className: 'bg-surface border border-border text-textMain shadow-lg rounded-xl text-sm font-medium',
        style: {
          background: 'var(--color-surface)',
          color: 'var(--color-text-main)',
          border: '1px solid var(--color-border)'
        }
      }} 
    />
  </React.StrictMode>,
);
