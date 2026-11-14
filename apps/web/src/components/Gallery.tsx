'use client';
import { useState } from 'react';

interface Photo { id: string; alt: string | null; width: number; height: number; urls: { thumb: string; card: string; full: string } }

export function Gallery({ photos, title }: { photos: Photo[]; title: string }) {
  const [i, setI] = useState(0);
  if (!photos.length) return <div className="gallery-main" role="img" aria-label="No photos" />;
  const p = photos[Math.min(i, photos.length - 1)]!;
  return (
    <div className="gallery">
      <div className="gallery-main">
        <img src={p.urls.full} alt={p.alt || `${title}, photo ${i + 1} of ${photos.length}`} width={p.width} height={p.height} fetchPriority="high" />
      </div>
      {photos.length > 1 && (
        <div className="thumbs" role="group" aria-label="Photos">
          {photos.map((ph, n) => (
            <button key={ph.id} type="button" aria-current={n === i} aria-label={`Show photo ${n + 1} of ${photos.length}`} onClick={() => setI(n)}>
              <img src={ph.urls.thumb} alt="" width={84} height={63} loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
