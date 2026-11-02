import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Report } from '../../src/report.js';
import { ReportTable } from './ReportTable.js';
import './style.css';

// The key the server accepts when it is started without TENANT_KEYS. Local demo use only.
const DEMO_KEY = 'local-demo-key-alpha-000001';

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; report: Report };

function App() {
  const [key, setKey] = useState(DEMO_KEY);
  const [state, setState] = useState<State>({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const res = await fetch('/v1/report', { headers: { authorization: `Bearer ${key}` } });
      if (!res.ok) {
        const body: { error?: { message?: string } } | null = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      setState({ status: 'ok', report: (await res.json()) as Report });
    } catch (err) {
      setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, [key]);

  useEffect(() => {
    void load();
    // Load once when the page opens; after that, the button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main>
      <h1>Impressions per ad</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <label>
          API key
          <input value={key} onChange={(e) => setKey(e.target.value)} spellCheck={false} autoComplete="off" />
        </label>
        <button type="submit">Reload</button>
      </form>
      <div aria-live="polite">
        {state.status === 'loading' && <p>Loading…</p>}
        {state.status === 'error' && <p className="error">Could not load the report: {state.message}</p>}
        {state.status === 'ok' && <ReportTable report={state.report} />}
      </div>
      <p className="note">All events behind these numbers are synthetic.</p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
