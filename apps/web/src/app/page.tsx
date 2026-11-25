import Link from 'next/link';
import { ArrowRight, Store } from 'lucide-react';
import { WelcomePrompt } from '@/components/build/WelcomePrompt';

const HOW = [
  { n: '1', label: 'Pick what to build', blurb: 'A home, flats, a plaza, offices, a hotel, a school, a clinic, a church or mosque: up to ten storeys.' },
  { n: '2', label: 'Give your plot', blurb: 'Its width and depth, and where it is. It appears in 3D, to scale.' },
  { n: '3', label: 'We design it all', blurb: 'Layouts checked against the rules, the 3D model, drawings, cooling, water and solar, the cost, and every material with where to buy it.' },
];

/** The front door: pick what to build and browse published plans. Shoppers go straight to the marketplace. */
export default function Welcome() {
  return (
    <>
      <section className="hero welcome" aria-labelledby="hero-h">
        <p className="announce glass rise"><span className="tag">Builder AI</span> Homes, commercial, hospitality and institutional buildings</p>
        <h1 id="hero-h" className="rise rise-2">What would you like to <span className="accent">build</span> today?</h1>
        <p className="lede rise rise-3">Pick a building type and a look you like. Browse published floor plans and exterior previews, then check build rights with the publisher.</p>
        <WelcomePrompt />
        <Link href="/market" className="shop-link rise rise-4">
          <Store size={18} aria-hidden="true" />
          <span><strong>Just shopping?</strong> Browse materials, tools and trades in the marketplace</span>
          <ArrowRight size={16} aria-hidden="true" />
        </Link>
      </section>

      <section aria-labelledby="how-h" className="how">
        <h2 id="how-h" className="sr-only">How it works</h2>
        <ol className="how-steps plain">
          {HOW.map((st) => (
            <li key={st.n} className="card"><span className="tile-icon" aria-hidden="true">{st.n}</span><strong>{st.label}</strong><span className="small muted">{st.blurb}</span></li>
          ))}
        </ol>
        <p className="small muted how-note">Concept designs to prepare you for your architect, engineers and builders: never a substitute for stamped drawings or approvals.</p>
      </section>
    </>
  );
}
