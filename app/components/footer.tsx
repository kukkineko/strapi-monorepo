import Link from "next/link";

export function Footer() {
  return (
    <footer className="wiki-footer">
      <nav aria-label="Rechtliche Links">
        <Link href="/impressum">Impressum</Link>
        <span aria-hidden="true">·</span>
        <Link href="/datenschutz">Datenschutz</Link>
      </nav>
      <p>© 2026 SSA Fluidra Österreich GmbH</p>
    </footer>
  );
}
