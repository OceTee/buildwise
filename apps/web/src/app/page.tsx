import Link from 'next/link';
import { ArrowRight, Box, ClipboardList, PencilRuler, ShoppingCart, Store } from 'lucide-react';
import { WelcomePrompt } from '@/components/build/WelcomePrompt';

/** The front door: an AI building assistant. Shoppers go straight to the marketplace. */
export default function Welcome() {
  return (
    <>
      <section className="hero welcome" aria-labelledby="hero-h">
        <p className="announce glass rise"><span className="tag">New</span> Design your home in 3D, then buy everything it takes</p>
        <h1 id="hero-h" className="rise rise-2">What would you like to <span className="accent">build</span> today?</h1>
        <p className="lede rise rise-3">Tell us your land size and the home you want. We model it to scale on your plot, check it against the rules architects use, list every bag of cement and block you need, and show you where to buy them.</p>
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
          <li className="card"><span className="tile-icon"><Box size={18} aria-hidden="true" /></span><strong>Your land in 3D</strong><span className="small muted">Enter the plot size and see it to scale, with the building setbacks marked.</span></li>
          <li className="card"><span className="tile-icon"><PencilRuler size={18} aria-hidden="true" /></span><strong>Designs that fit</strong><span className="small muted">Pick from layouts generated for your plot and checked for room sizes, daylight, ventilation and access.</span></li>
          <li className="card"><span className="tile-icon"><ClipboardList size={18} aria-hidden="true" /></span><strong>Every material, counted</strong><span className="small muted">Blocks, cement, sand, steel, roofing, doors and finishes, with how each was worked out.</span></li>
          <li className="card"><span className="tile-icon"><ShoppingCart size={18} aria-hidden="true" /></span><strong>Where to buy it</strong><span className="small muted">Live prices from sellers near you, and the total for your build.</span></li>
        </ol>
      </section>
    </>
  );
}
