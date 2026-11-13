'use client';

import { useEffect } from 'react';

/** Counts the open, then reports time on the page when the visitor leaves or switches tabs. */
export function ViewTracker({ token }: { token: string }) {
  useEffect(() => {
    const url = `/a/${token}/view`;
    let shownAt = Date.now();
    const send = (seconds: number) => {
      const body = JSON.stringify({ seconds });
      if (seconds > 0 && navigator.sendBeacon) navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      else void fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    };
    send(0);
    const onHide = () => {
      if (document.visibilityState === 'hidden') {
        const s = Math.min(600, Math.round((Date.now() - shownAt) / 1000));
        if (s > 0) send(s);
      } else {
        shownAt = Date.now();
      }
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [token]);
  return null;
}
