/**
 * Original, decorative vector illustrations for the storefront (authored for this project;
 * provenance in docs/storefront-assets.md). They are flat-style ILLUSTRATIONS — never
 * photographs and never used as the picture of a real product. Every one is `aria-hidden`:
 * the surrounding text carries the meaning.
 */
import type { SVGProps } from "react";

type ArtProps = SVGProps<SVGSVGElement>;

const INK = "#1d1d1f";
const RED = "#c8102e";
const CLOTH = "#fbf8f2";
const CLOTH_SHADE = "#e4ddd0";

/** Small brand mark for the header/footer: a red tile with a stylised belt knot. */
export function BrandMark(props: ArtProps) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" {...props}>
      <rect width="32" height="32" rx="8" fill={RED} />
      <path d="M5 13.5h22v5H5z" fill="#fff" />
      <path d="M16 18.5 11 27M16 18.5 21 27" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
      <rect x="12.5" y="11" width="7" height="10" rx="2" fill={INK} />
    </svg>
  );
}

export function CartIcon(props: ArtProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d="M3 4h2.4l2 10.2a1.5 1.5 0 0 0 1.5 1.2h8.2a1.5 1.5 0 0 0 1.5-1.1L20.5 8H6.2" />
      <circle cx="9.5" cy="19.5" r="1.4" />
      <circle cx="17" cy="19.5" r="1.4" />
    </svg>
  );
}

/** The hero scene: a uniform (dobok) with a belt on a charcoal panel, plus rolled belts. */
export function HeroArt(props: ArtProps) {
  return (
    <svg viewBox="0 0 560 600" aria-hidden="true" focusable="false" {...props}>
      <defs>
        <linearGradient id="hero-panel" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#323236" />
          <stop offset="1" stopColor="#161618" />
        </linearGradient>
        <linearGradient id="hero-cloth" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor={CLOTH_SHADE} />
        </linearGradient>
        <clipPath id="hero-clip">
          <rect width="560" height="600" rx="36" />
        </clipPath>
      </defs>

      <g clipPath="url(#hero-clip)">
        <rect width="560" height="600" fill="url(#hero-panel)" />
        {/* sun disc + rings */}
        <circle cx="402" cy="176" r="196" fill={RED} />
        <circle cx="402" cy="176" r="150" fill="none" stroke="#fff" strokeOpacity="0.12" strokeWidth="2" />
        <circle cx="402" cy="176" r="104" fill="none" stroke="#fff" strokeOpacity="0.1" strokeWidth="2" />
        {/* diagonal stripes, lower left */}
        <g stroke="#fff" strokeOpacity="0.07" strokeWidth="10">
          <path d="M-40 520 L120 360" />
          <path d="M-10 580 L190 380" />
          <path d="M40 620 L250 410" />
        </g>
        {/* floor shadow */}
        <ellipse cx="280" cy="566" rx="190" ry="17" fill="#000" opacity="0.38" />

        {/* trousers */}
        <path d="M208 432 H284 L270 556 H198 Z" fill="url(#hero-cloth)" stroke={INK} strokeOpacity="0.25" strokeWidth="2" />
        <path d="M276 432 H352 L362 556 H290 Z" fill="url(#hero-cloth)" stroke={INK} strokeOpacity="0.25" strokeWidth="2" />
        <path d="M236 446 L232 548M322 446 L326 548" stroke={INK} strokeOpacity="0.12" strokeWidth="2" />

        {/* sleeves */}
        <path d="M196 212 L66 322 L104 390 L208 298 Z" fill="url(#hero-cloth)" stroke={INK} strokeOpacity="0.25" strokeWidth="2" strokeLinejoin="round" />
        <path d="M364 212 L494 322 L456 390 L352 298 Z" fill="url(#hero-cloth)" stroke={INK} strokeOpacity="0.25" strokeWidth="2" strokeLinejoin="round" />
        <path d="M70 330 L108 396M490 330 L452 396" stroke={INK} strokeOpacity="0.45" strokeWidth="9" strokeLinecap="round" />

        {/* jacket body */}
        <path d="M196 212 Q280 188 364 212 L380 452 Q280 474 180 452 Z" fill="url(#hero-cloth)" stroke={INK} strokeOpacity="0.25" strokeWidth="2" strokeLinejoin="round" />
        {/* V-neck lapels */}
        <path d="M234 202 L286 394 L330 202" fill="none" stroke={INK} strokeWidth="15" strokeLinejoin="round" strokeLinecap="round" />
        <path d="M262 204 L304 388" fill="none" stroke={INK} strokeWidth="6" strokeLinecap="round" opacity="0.75" />
        {/* stitching */}
        <path d="M196 438 Q280 458 366 438" fill="none" stroke={INK} strokeOpacity="0.2" strokeDasharray="5 6" strokeWidth="2" />

        {/* belt */}
        <path d="M178 398 H382 V430 H178 Z" fill={INK} />
        <path d="M178 411 H382" stroke={RED} strokeWidth="5" />
        <path d="M274 424 L238 528 L268 536 L292 430 Z" fill={INK} />
        <path d="M290 424 L330 524 L300 534 L276 430 Z" fill="#2b2b2e" />
        <path d="M244 526 L270 534M300 532 L328 522" stroke={RED} strokeWidth="5" strokeLinecap="round" />
        <rect x="258" y="388" width="46" height="52" rx="12" fill="#2b2b2e" stroke="#000" strokeOpacity="0.4" strokeWidth="2" />
        <path d="M268 402 H294" stroke={RED} strokeWidth="5" strokeLinecap="round" />

        {/* rolled belts, bottom right */}
        <g transform="translate(404 470) rotate(-8)">
          <rect x="0" y="0" width="120" height="26" rx="13" fill="#fff" />
          <rect x="0" y="34" width="120" height="26" rx="13" fill={RED} />
          <rect x="0" y="68" width="120" height="26" rx="13" fill="#0e0e0f" stroke="#fff" strokeOpacity="0.35" strokeWidth="2" />
          <path d="M92 2V24M92 36V58M92 70V92" stroke={INK} strokeOpacity="0.28" strokeWidth="3" />
        </g>
      </g>
    </svg>
  );
}

/** Uniforms tile: a front-view jacket with belt, outlined for a light background. */
export function UniformArt(props: ArtProps) {
  return (
    <svg viewBox="0 0 200 150" aria-hidden="true" focusable="false" {...props}>
      <g stroke={INK} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
        <path d="M70 34 L22 78 L38 100 L74 66 Z" fill={CLOTH} />
        <path d="M130 34 L178 78 L162 100 L126 66 Z" fill={CLOTH} />
        <path d="M70 34 Q100 24 130 34 L136 118 Q100 128 64 118 Z" fill={CLOTH} />
        <path d="M82 30 L100 100 L118 30" fill="none" strokeWidth="6" />
        <path d="M64 100 H136 V112 H64 Z" fill={INK} />
        <path d="M96 112 L84 140 M104 112 L118 138" fill="none" strokeWidth="5" />
        <path d="M64 106 H136" stroke={RED} strokeWidth="3" />
      </g>
    </svg>
  );
}

/** Footwear tile: a low training shoe in side view. */
export function FootwearArt(props: ArtProps) {
  return (
    <svg viewBox="0 0 200 150" aria-hidden="true" focusable="false" {...props}>
      <g stroke={INK} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
        <path d="M24 98 Q24 62 54 56 L78 52 Q96 76 130 80 Q176 84 178 112 L178 112 H24 Z" fill={CLOTH} />
        <path d="M78 52 Q84 40 96 38 L104 52" fill="none" />
        <path d="M92 66 L100 58M104 72 L112 64M116 76 L124 68" fill="none" strokeWidth="3" />
        <path d="M24 112 H178 V122 Q178 128 172 128 H30 Q24 128 24 122 Z" fill={RED} />
        <path d="M32 92 H62" stroke={RED} strokeWidth="5" />
      </g>
    </svg>
  );
}

/** Belts tile: a belt tied with a square knot. */
export function BeltsArt(props: ArtProps) {
  return (
    <svg viewBox="0 0 200 150" aria-hidden="true" focusable="false" {...props}>
      <g stroke={INK} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
        <path d="M10 56 H92 V82 H10 Z" fill={INK} />
        <path d="M108 56 H190 V82 H108 Z" fill={INK} />
        <path d="M10 69 H92M108 69 H190" stroke={RED} strokeWidth="4" />
        <path d="M94 82 L66 134 L88 142 L108 88 Z" fill="#2b2b2e" />
        <path d="M106 82 L136 130 L114 140 L94 88 Z" fill="#2b2b2e" />
        <rect x="84" y="46" width="32" height="46" rx="10" fill="#2b2b2e" />
        <path d="M92 62 H108" stroke={RED} strokeWidth="4" />
      </g>
    </svg>
  );
}

/** Protective Gear tile: a chest protector (hogu). */
export function ProtectiveArt(props: ArtProps) {
  return (
    <svg viewBox="0 0 200 150" aria-hidden="true" focusable="false" {...props}>
      <g stroke={INK} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
        <path d="M58 22 Q84 38 100 38 Q116 38 142 22 L170 44 L152 64 L152 124 Q100 140 48 124 L48 64 L30 44 Z" fill={RED} />
        <path d="M70 52 Q100 66 130 52" fill="none" stroke="#fff" strokeOpacity="0.9" strokeWidth="3" />
        <path d="M100 66 V128M72 84 H128M72 106 H128" fill="none" stroke="#fff" strokeOpacity="0.55" strokeWidth="2.5" />
        <path d="M48 64 L38 74M152 64 L162 74" fill="none" />
      </g>
    </svg>
  );
}
