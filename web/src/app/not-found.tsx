import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="auth">
      <p className="brand">AI SDR Platform</p>
      <h1>Page not found</h1>
      <p className="muted">This page does not exist, or you do not have access to it.</p>
      <Link className="btn btn-primary" href="/workspaces">Go to your workspaces</Link>
    </main>
  );
}
