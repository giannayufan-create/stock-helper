// src/lib/runtime.ts — environment detection (zero dependencies; safe to
// import from anywhere without cycles)

export const isTauri =
    typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// In Tauri the frontend is served from tauri://localhost — API calls must
// target the local nova-pro server explicitly.
const FIREBASE_HOSTING =
    typeof window !== 'undefined' &&
    /(?:web\.app|firebaseapp\.com)$/.test(window.location.hostname);

/** Render API used when the SPA is hosted on Firebase without VITE_API_BASE. */
const HOSTED_API_FALLBACK = 'https://stock-helper-eskj.onrender.com';

export function getApiBase(): string {
    const env = (import.meta.env.VITE_API_BASE as string | undefined)?.trim();
    if (env) return env.replace(/\/$/, '');
    if (isTauri) return 'http://127.0.0.1:8787';
    // Firebase Hosting has no /api rewrite — empty base would fetch index.html.
    if (FIREBASE_HOSTING) return HOSTED_API_FALLBACK;
    return '';
}

export function isHostedApi(): boolean {
    return /onrender\.com$/i.test(getApiBase().replace(/\/$/, ''));
}
