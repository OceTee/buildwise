'use client';
import { LogOut } from 'lucide-react';

export function SignOutButton() {
  return (
    <button type="button" className="btn btn-ghost btn-small" onClick={async () => { await fetch('/api/session', { method: 'DELETE' }); window.location.href = '/'; }}>
      <LogOut size={16} aria-hidden="true" /> Sign out
    </button>
  );
}
