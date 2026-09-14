/**
 * The Fluidra mark: a ring with a gap in the inner ring, plus the FLUIDRA /
 * DATABASE wordmark. Pure SVG + text rather than a raster logo.png, so it
 * stays crisp at every size this app uses it at and recolors for free via
 * currentColor + the CSS custom properties in globals.css (.fluidra-lock).
 */
function FluidraMark({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth={size >= 40 ? 4 : size >= 24 ? 5 : 6}
      strokeLinecap="round"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Fluidra"
    >
      <circle cx="32" cy="32" r="28" />
      <circle cx="32" cy="32" r="17" strokeDasharray="76 31" strokeDashoffset="19" />
      <circle cx="32" cy="32" r="5.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

type LogoSize = "default" | "sm" | "xs";

export function FluidraLogo({ size = "default" }: { size?: LogoSize }) {
  const markSize = size === "default" ? 46 : size === "sm" ? 34 : 24;
  return (
    <div className={`fluidra-lock ${size}`}>
      <FluidraMark size={markSize} />
      <div className="words">
        <span className="name">Fluidra</span>
        <span className="under">
          <span>D</span><span>A</span><span>T</span><span>A</span>
          <span>B</span><span>A</span><span>S</span><span>E</span>
        </span>
      </div>
    </div>
  );
}
