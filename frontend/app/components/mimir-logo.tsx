/**
 * The Mimir mark: a well-ring with a gap in the inner ring (Odin's eye, given
 * up at Mímir's well for a drink of wisdom) plus the MIMIR / DATABASE
 * wordmark. Pure SVG + text rather than a raster logo.png, so it stays crisp
 * at every size this app uses it at and recolors for free via currentColor +
 * the CSS custom properties in globals.css (.mimir-lock).
 */
function MimirMark({ size }: { size: number }) {
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
      aria-label="Mimir"
    >
      <circle cx="32" cy="32" r="28" />
      <circle cx="32" cy="32" r="17" strokeDasharray="76 31" strokeDashoffset="19" />
      <circle cx="32" cy="32" r="5.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

type LogoSize = "default" | "sm" | "xs";

export function MimirLogo({ size = "default" }: { size?: LogoSize }) {
  const markSize = size === "default" ? 46 : size === "sm" ? 34 : 24;
  return (
    <div className={`mimir-lock ${size}`}>
      <MimirMark size={markSize} />
      <div className="words">
        <span className="name">Mimir</span>
        <span className="under">
          <span>D</span><span>A</span><span>T</span><span>A</span>
          <span>B</span><span>A</span><span>S</span><span>E</span>
        </span>
      </div>
    </div>
  );
}
