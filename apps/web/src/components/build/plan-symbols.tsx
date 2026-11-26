'use client';
import type { ReactNode } from 'react';
import type { Furnishing, Rect, Room } from '@bw/domain';

/**
 * Top-view furniture and fittings for the drawings, in the style of a presentation floor plan: beds with pillows and a
 * turned-down duvet, sofas with back and seat cushions, dining tables ringed with chairs, worktops with a sink and hob,
 * WCs, basins and showers. Each symbol is drawn in its own frame (width along the wall it backs onto, depth out into
 * the room, back at the top) and turned onto the sheet, so it always faces the way the furnishing rules placed it.
 */

/** Sheet frame: plan metres to sheet millimetres, the street (y = 0) at the bottom. */
export interface PlanFrame { k: number; X: (x: number) => number; Y: (y: number) => number }
export type Tone = 'board' | 'line';

const PAL = {
  board: { line: '#6c6964', fill: '#fff', soft: '#ebe8e3', dark: '#5d5a55', sw: 0.13 },
  line: { line: '#8a8a8a', fill: '#fff', soft: '#fff', dark: '#8a8a8a', sw: 0.16 },
};

/** Where a symbol sits on the sheet: an SVG transform into its own frame, its width along the back wall and its depth. */
export function placement(item: Rect & { back: Furnishing['back'] }, f: PlanFrame): { t: string; L: number; D: number } {
  const x = f.X(item.x); const y = f.Y(item.y + item.d); const w = item.w * f.k; const h = item.d * f.k;
  // Plan n (the street side, low y) is the bottom of the sheet; s the top; e the right; w the left.
  switch (item.back) {
    case 's': return { t: `translate(${x} ${y})`, L: w, D: h };
    case 'n': return { t: `translate(${x + w} ${y + h}) rotate(180)`, L: w, D: h };
    case 'w': return { t: `translate(${x} ${y + h}) rotate(-90)`, L: h, D: w };
    default: return { t: `translate(${x + w} ${y}) rotate(90)`, L: h, D: w };
  }
}

export function FurnitureSymbol({ item, f, tone = 'board' }: { item: Furnishing; f: PlanFrame; tone?: Tone }) {
  const { t, L, D } = placement(item, f);
  const m = f.k; // millimetres per metre
  const p = PAL[tone];
  const base = { fill: p.fill, stroke: p.line, strokeWidth: p.sw } as const;
  const soft = { fill: p.soft, stroke: p.line, strokeWidth: p.sw } as const;
  const thin = { fill: 'none', stroke: p.line, strokeWidth: p.sw * 0.8 } as const;
  const out: ReactNode[] = [];
  const rect = (x: number, y: number, w: number, h: number, props: object, rx = 0, key = out.length) =>
    out.push(<rect key={key} x={x} y={y} width={Math.max(0, w)} height={Math.max(0, h)} rx={rx} {...props} />);
  const line = (x1: number, y1: number, x2: number, y2: number, props: object = thin) => out.push(<line key={out.length} x1={x1} y1={y1} x2={x2} y2={y2} {...props} />);
  const circle = (cx: number, cy: number, r: number, props: object) => out.push(<circle key={out.length} cx={cx} cy={cy} r={r} {...props} />);
  const ellipse = (cx: number, cy: number, rx: number, ry: number, props: object) => out.push(<ellipse key={out.length} cx={cx} cy={cy} rx={rx} ry={ry} {...props} />);

  switch (item.kind) {
    case 'bed': {
      rect(0, 0, L, D, base, 0.08 * m);
      rect(0, 0, L, 0.07 * m, soft);
      const n = L > 1.2 * m ? 2 : 1;
      const gap = 0.12 * m; const pw = (L - gap * (n + 1)) / n;
      for (let i = 0; i < n; i++) rect(gap + i * (pw + gap), 0.13 * m, pw, 0.3 * m, base, 0.08 * m);
      // The duvet, turned down, with a throw across the foot.
      rect(0.03 * m, 0.52 * m, L - 0.06 * m, D - 0.55 * m, base, 0.05 * m);
      line(0.03 * m, 0.66 * m, L - 0.03 * m, 0.66 * m);
      rect(0.03 * m, D - 0.5 * m, L - 0.06 * m, 0.32 * m, soft);
      break;
    }
    case 'side-table': {
      rect(0, 0, L, D, base, 0.03 * m);
      const r = Math.min(L, D) * 0.3;
      circle(L / 2, D / 2, r, base); circle(L / 2, D / 2, r * 0.4, soft);
      break;
    }
    case 'sofa': case 'armchair': {
      const arm = Math.min(0.2 * m, L * 0.16); const back = Math.min(0.24 * m, D * 0.3);
      rect(0, 0, L, D, base, 0.1 * m);
      rect(arm * 0.6, 0, L - arm * 1.2, back, soft, 0.06 * m);
      rect(0, 0.02 * m, arm, D - 0.04 * m, base, 0.08 * m);
      rect(L - arm, 0.02 * m, arm, D - 0.04 * m, base, 0.08 * m);
      const seats = item.kind === 'armchair' ? 1 : L > 2 * m ? 3 : 2;
      const sw = (L - 2 * arm) / seats;
      for (let i = 0; i < seats; i++) rect(arm + i * sw + 0.01 * m, back + 0.01 * m, sw - 0.02 * m, D - back - 0.05 * m, base, 0.06 * m);
      if (item.kind === 'sofa') {
        // Two cushions thrown in the corners.
        const c = 0.3 * m;
        out.push(<rect key="c1" x={arm + 0.06 * m} y={back - 0.02 * m} width={c} height={c * 0.55} rx={0.05 * m} {...soft} transform={`rotate(-12 ${arm + 0.06 * m + c / 2} ${back})`} />);
        out.push(<rect key="c2" x={L - arm - 0.06 * m - c} y={back - 0.02 * m} width={c} height={c * 0.55} rx={0.05 * m} {...soft} transform={`rotate(12 ${L - arm - 0.06 * m - c / 2} ${back})`} />);
      }
      break;
    }
    case 'coffee-table': {
      rect(0, 0, L, D, base, Math.min(L, D) * 0.3);
      rect(0.06 * m, 0.06 * m, L - 0.12 * m, D - 0.12 * m, thin, Math.min(L, D) * 0.24);
      circle(L * 0.32, D / 2, Math.min(D, L) * 0.14, soft);
      rect(L * 0.55, D * 0.32, L * 0.2, D * 0.36, soft);
      break;
    }
    case 'tv-unit': {
      rect(0, 0, L, D, base);
      rect(L * 0.15, 0.08 * m, L * 0.7, 0.06 * m, { fill: p.dark, stroke: 'none' });
      for (let i = 1; i < 3; i++) line((L * i) / 3, 0.18 * m, (L * i) / 3, D);
      break;
    }
    case 'wardrobe': {
      rect(0, 0, L, D, base);
      line(0, D / 2, L, D / 2, { ...thin, strokeDasharray: `${0.08 * m} ${0.05 * m}` });
      for (let x = 0.1 * m; x < L - 0.05 * m; x += 0.1 * m) line(x, D * 0.22, x + 0.02 * m, D * 0.78, { ...thin, strokeWidth: p.sw * 0.6 });
      line(0, D - 0.03 * m, L, D - 0.03 * m);
      break;
    }
    case 'dining-table': {
      // The footprint holds the chairs: the table is 0.1 m in from each end and 0.45 m in from each side.
      const tl = L - 0.2 * m; const td = D - 0.9 * m;
      const per = Math.max(1, Math.round(tl / (0.62 * m)));
      const cw = 0.44 * m; const cd = 0.42 * m;
      const chair = (cx: number, cy: number, rot: number, key: string) => (
        <g key={key} transform={`translate(${cx} ${cy}) rotate(${rot})`}>
          <rect x={-cw / 2} y={-cd / 2} width={cw} height={cd} rx={0.07 * m} {...base} />
          <rect x={-cw / 2 + 0.03 * m} y={-cd / 2} width={cw - 0.06 * m} height={0.07 * m} rx={0.03 * m} {...soft} />
        </g>
      );
      for (let i = 0; i < per; i++) {
        const cx = 0.1 * m + (tl * (i + 0.5)) / per;
        out.push(chair(cx, 0.45 * m - 0.08 * m, 0, `ct${i}`));
        out.push(chair(cx, D - 0.45 * m + 0.08 * m, 180, `cb${i}`));
      }
      if (tl >= 2 * m || tl <= 1.05 * m) { out.push(chair(0.1 * m - 0.12 * m, D / 2, -90, 'cl')); out.push(chair(L - 0.1 * m + 0.12 * m, D / 2, 90, 'cr')); }
      if (tl <= 1.05 * m) ellipse(L / 2, D / 2, tl / 2, td / 2, base);
      else rect(0.1 * m, 0.45 * m, tl, td, base, 0.06 * m);
      // A runner and a bowl down the middle.
      rect(L / 2 - tl * 0.3, D / 2 - td * 0.16, tl * 0.6, td * 0.32, soft, 0.02 * m);
      circle(L / 2, D / 2, Math.min(td * 0.14, 0.12 * m), base);
      break;
    }
    case 'counter': {
      rect(0, 0, L, D, base);
      line(0, D - 0.04 * m, L, D - 0.04 * m);
      const first = /:0$/.test(item.id);
      const sink = (cx: number) => {
        rect(cx - 0.42 * m, 0.1 * m, 0.84 * m, 0.44 * m, base, 0.04 * m);
        rect(cx - 0.38 * m, 0.14 * m, 0.36 * m, 0.36 * m, soft, 0.05 * m);
        rect(cx + 0.02 * m, 0.14 * m, 0.36 * m, 0.36 * m, soft, 0.05 * m);
        circle(cx, 0.1 * m, 0.03 * m, { fill: p.line });
      };
      const hob = (cx: number) => {
        rect(cx - 0.3 * m, 0.04 * m, 0.6 * m, 0.52 * m, thin, 0.02 * m);
        for (const [dx, dy, r] of [[-0.14, 0.17, 0.09], [0.14, 0.17, 0.07], [-0.14, 0.42, 0.07], [0.14, 0.42, 0.09]] as const) {
          circle(cx + dx * m, dy * m, r * m, base); circle(cx + dx * m, dy * m, r * 0.45 * m, thin);
        }
      };
      if (first && L >= 2.4 * m) { hob(L * 0.26); sink(L * 0.7); } else if (first && L >= 1 * m) sink(L / 2);
      else if (L >= 0.8 * m) hob(L / 2);
      break;
    }
    case 'fridge': {
      rect(0, 0, L, D, base, 0.02 * m);
      rect(0.04 * m, 0.04 * m, L - 0.08 * m, D - 0.12 * m, thin);
      line(L / 2, D - 0.08 * m, L / 2, D);
      line(L * 0.3, D - 0.02 * m, L * 0.45, D - 0.02 * m, { ...thin, strokeWidth: p.sw * 2 });
      line(L * 0.55, D - 0.02 * m, L * 0.7, D - 0.02 * m, { ...thin, strokeWidth: p.sw * 2 });
      break;
    }
    case 'toilet': {
      rect(0.02 * m, 0, L - 0.04 * m, 0.18 * m, base, 0.03 * m);
      ellipse(L / 2, 0.18 * m + Math.min(0.26 * m, (D - 0.18 * m) / 2), L * 0.4, Math.min(0.26 * m, (D - 0.18 * m) / 2), base);
      ellipse(L / 2, 0.2 * m + Math.min(0.24 * m, (D - 0.2 * m) / 2), L * 0.27, Math.min(0.17 * m, (D - 0.2 * m) / 2.6), soft);
      break;
    }
    case 'shower': {
      rect(0, 0, L, D, soft);
      rect(0.05 * m, 0.05 * m, L - 0.1 * m, D - 0.1 * m, thin);
      line(0.05 * m, 0.05 * m, L - 0.05 * m, D - 0.05 * m); line(L - 0.05 * m, 0.05 * m, 0.05 * m, D - 0.05 * m);
      circle(L / 2, D / 2, 0.05 * m, base);
      line(0, D, L, D, { stroke: '#8fb3c4', strokeWidth: p.sw * 3 });
      break;
    }
    case 'basin': {
      rect(0, 0, L, D, base, 0.02 * m);
      ellipse(L / 2, D * 0.56, L * 0.34, D * 0.3, soft);
      circle(L / 2, 0.08 * m, 0.025 * m, { fill: p.line });
      break;
    }
    case 'desk': case 'gaming-desk': {
      const dd = Math.min(0.7 * m, D * 0.55);
      rect(0, 0, L, dd, base);
      if (item.kind === 'gaming-desk') { rect(L * 0.2, 0.08 * m, L * 0.28, 0.04 * m, { fill: p.dark }); rect(L * 0.52, 0.08 * m, L * 0.28, 0.04 * m, { fill: p.dark }); }
      else { rect(L * 0.35, 0.12 * m, L * 0.3, 0.22 * m, soft, 0.01 * m); circle(L * 0.12, 0.15 * m, 0.08 * m, base); }
      const c = 0.5 * m;
      rect(L / 2 - c / 2, dd - 0.12 * m, c, c, base, 0.12 * m);
      rect(L / 2 - c / 2 + 0.04 * m, dd + c - 0.22 * m, c - 0.08 * m, 0.08 * m, soft, 0.03 * m);
      break;
    }
    case 'training-bench': {
      rect(L * 0.18, D / 2 - 0.15 * m, L * 0.64, 0.3 * m, soft, 0.06 * m);
      line(0, 0.14 * m, L, 0.14 * m, { stroke: p.dark, strokeWidth: p.sw * 2 });
      for (const x of [0.06 * m, L - 0.12 * m]) rect(x, 0.02 * m, 0.06 * m, 0.24 * m, { fill: p.dark });
      break;
    }
    default: rect(0, 0, L, D, base);
  }
  return <g transform={t}>{out}</g>;
}

/** A potted plant from above: a pot and a spray of leaves. */
export function Plant({ cx, cy, r, seed = 0 }: { cx: number; cy: number; r: number; seed?: number }) {
  const n = 9;
  const leaves = Array.from({ length: n }, (_, i) => {
    const a = ((i + seed * 0.37) / n) * Math.PI * 2;
    const lx = cx + Math.cos(a) * r * 0.62; const ly = cy + Math.sin(a) * r * 0.62;
    return <ellipse key={i} cx={lx} cy={ly} rx={r * 0.42} ry={r * 0.17} transform={`rotate(${(a * 180) / Math.PI} ${lx} ${ly})`} fill="#93ad7c" stroke="#5f7a4b" strokeWidth={0.08} />;
  });
  return <g><circle cx={cx} cy={cy} r={r * 0.5} fill="#55524d" />{leaves}<circle cx={cx} cy={cy} r={r * 0.18} fill="#6f8f58" /></g>;
}

/** The rugs a presentation plan lays under a seating group, the foot of a bed and a dining set (plan metres). */
export function rugsFor(room: Room, items: Furnishing[]): Rect[] {
  const mine = items.filter((i) => i.roomId === room.id);
  const clip = (r: Rect): Rect | null => {
    const x0 = Math.max(r.x, room.x + 0.15); const y0 = Math.max(r.y, room.y + 0.15);
    const x1 = Math.min(r.x + r.w, room.x + room.w - 0.15); const y1 = Math.min(r.y + r.d, room.y + room.d - 0.15);
    return x1 - x0 > 0.6 && y1 - y0 > 0.6 ? { x: x0, y: y0, w: x1 - x0, d: y1 - y0 } : null;
  };
  const out: Rect[] = [];
  const group = mine.filter((i) => i.kind === 'coffee-table' || i.kind === 'sofa' || i.kind === 'armchair');
  if (group.some((i) => i.kind === 'coffee-table')) {
    const x0 = Math.min(...group.map((i) => i.x)); const y0 = Math.min(...group.map((i) => i.y));
    const x1 = Math.max(...group.map((i) => i.x + i.w)); const y1 = Math.max(...group.map((i) => i.y + i.d));
    // Under the front legs of every seat: inset from the group's outer edge.
    const r = clip({ x: x0 + 0.3, y: y0 + 0.3, w: x1 - x0 - 0.6, d: y1 - y0 - 0.6 });
    if (r) out.push(r);
  }
  const bed = mine.find((i) => i.kind === 'bed');
  if (bed) {
    // The lower two-thirds of the bed and 0.55 m round it.
    const s = 0.55;
    const r = bed.back === 'n' ? { x: bed.x - s, y: bed.y + bed.d * 0.35, w: bed.w + 2 * s, d: bed.d * 0.65 + s }
      : bed.back === 's' ? { x: bed.x - s, y: bed.y - s, w: bed.w + 2 * s, d: bed.d * 0.65 + s }
        : bed.back === 'w' ? { x: bed.x + bed.w * 0.35, y: bed.y - s, w: bed.w * 0.65 + s, d: bed.d + 2 * s }
          : { x: bed.x - s, y: bed.y - s, w: bed.w * 0.65 + s, d: bed.d + 2 * s };
    const c = clip(r); if (c) out.push(c);
  }
  const table = mine.find((i) => i.kind === 'dining-table');
  if (table) { const c = clip({ x: table.x - 0.25, y: table.y - 0.25, w: table.w + 0.5, d: table.d + 0.5 }); if (c) out.push(c); }
  return out;
}
