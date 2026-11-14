'use client';

export function SignOutButton() {
  return (
    <button type="button" className="btn btn-small" onClick={async () => { await fetch('/api/session', { method: 'DELETE' }); window.location.href = '/'; }}>
      Sign out
    </button>
  );
}
