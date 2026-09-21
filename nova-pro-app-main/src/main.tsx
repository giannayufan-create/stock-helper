// src/main.tsx

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/error-boundary';
import './index.css';
import { startApiWarmup } from './lib/api-ready';
import { initTheme } from './lib/theme-store';
import { startTriggerEngine } from './lib/trigger-engine';

initTheme();
startApiWarmup();
startTriggerEngine();

const rootElement = document.getElementById('root');
if (!rootElement) {
    throw new Error('Root element #root not found');
}

createRoot(rootElement).render(
    <StrictMode>
        <ErrorBoundary>
            <App />
        </ErrorBoundary>
    </StrictMode>,
);
