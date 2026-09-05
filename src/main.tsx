import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { Toaster } from 'react-hot-toast';
import { ErrorBoundary } from './components/ErrorBoundary';

// index.html's static #boot-fallback spinner covers the case where this
// bundle is slow to arrive at all (a blocked/CSP-restricted inline
// <script> in the HTML itself can't help there — this module executing
// is the earliest point any of our own JS runs). This covers the other
// real case: the bundle DID load and is executing (we're here), but
// something after this point is slow — a flaky connection retrying a
// later request, a slow first render. If #boot-fallback-text is still in
// the DOM 8s from now, createRoot().render() below hasn't replaced it yet,
// so say why instead of leaving an unexplained spinner running forever.
setTimeout(() => {
  const el = document.getElementById('boot-fallback-text');
  if (el) el.textContent = 'Still waking up — this demo sleeps after inactivity and can take up to a minute on its first load. Hang tight...';
}, 8000);

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
