'use client';

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="stack" style={{ maxWidth: '40rem' }} role="alert">
      <h1>Something went wrong</h1>
      <p>We could not load this page. Check your connection and try again.</p>
      <button type="button" className="btn" onClick={reset}>Try again</button>
    </div>
  );
}
