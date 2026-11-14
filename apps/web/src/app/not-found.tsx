import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="stack" style={{ maxWidth: '40rem' }}>
      <h1>Page not found</h1>
      <p>The page may have moved, or the listing may have been removed.</p>
      <p><Link className="btn" href="/search">Search listings</Link></p>
    </div>
  );
}
