"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const COOKIE_CONSENT_KEY = "wiki-cookie-notice-dismissed";

export function CookieBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!localStorage.getItem(COOKIE_CONSENT_KEY)) {
      setVisible(true);
    }
  }, []);

  function dismiss() {
    localStorage.setItem(COOKIE_CONSENT_KEY, "1");
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div className="wiki-cookie-banner" role="region" aria-label="Cookie-Hinweis">
      <p className="wiki-cookie-text">
        Diese Website verwendet einen technisch notwendigen Sitzungs-Cookie zur Anmeldung sowie
        lokalen Browser-Speicher für Spracheinstellungen und den Suchverlauf. Es werden keine
        Daten an Dritte weitergegeben.{" "}
        <Link href="/datenschutz">Datenschutzerklärung</Link>
      </p>
      <button type="button" className="wiki-cookie-dismiss" onClick={dismiss} aria-label="Hinweis schließen">
        Verstanden
      </button>
    </div>
  );
}
