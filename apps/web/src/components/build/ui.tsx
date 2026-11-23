'use client';
import { ArrowLeft, ArrowRight } from 'lucide-react';

export type StepRef = React.RefObject<HTMLHeadingElement | null>;

export function StepHead({ stepRef, kicker, title, children }: { stepRef: StepRef; kicker: string; title: string; children?: React.ReactNode }) {
  return (
    <header className="stack-sm">
      <p className="kicker">{kicker}</p>
      <h1 id="step-h" ref={stepRef} tabIndex={-1}>{title}</h1>
      {children && <p className="muted">{children}</p>}
    </header>
  );
}

export function Nav({ onBack, onNext, next = 'Continue', disabled }: { onBack?: () => void; onNext?: () => void; next?: string; disabled?: boolean }) {
  return (
    <div className="build-nav">
      {onBack ? <button type="button" className="btn btn-ghost" onClick={onBack}><ArrowLeft size={16} aria-hidden="true" /> Back</button> : <span />}
      {onNext && <button type="button" className="btn btn-primary" onClick={onNext} disabled={disabled}>{next} <ArrowRight size={16} aria-hidden="true" /></button>}
    </div>
  );
}
