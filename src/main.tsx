import React from 'react';
import ReactDOM from 'react-dom/client';

import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* The last resort: the notes are safe on the device, and a restart of
        the interface shows them again. */}
    <ErrorBoundary
      fallback={(error) => (
        <div className="failure-screen" role="alert">
          <img className="brand-mark" src="/bever.svg" alt="" />
          <h1>Bever could not go on</h1>
          <p>Your notes are stored and unharmed. Starting the interface again shows them.</p>
          <pre>{error.message}</pre>
          <button onClick={() => window.location.reload()}>Start again</button>
        </div>
      )}
    >
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
