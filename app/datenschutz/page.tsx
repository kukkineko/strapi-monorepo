import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Datenschutzerklärung – SSA Fluidra Österreich GmbH",
};

export default function DatenschutzPage() {
  return (
    <main className="wiki-shell wiki-legal-page">
      <nav className="wiki-legal-back">
        <Link href="/">← Zurück zur Startseite</Link>
      </nav>

      <h1>Datenschutzerklärung</h1>

      <p>
        Der Schutz Ihrer persönlichen Daten ist uns ein besonderes Anliegen. Wir verarbeiten Ihre
        Daten daher ausschließlich auf Grundlage der gesetzlichen Bestimmungen (DSGVO, TKG 2003).
        In dieser Datenschutzerklärung informieren wir Sie über die wichtigsten Aspekte der
        Datenverarbeitung im Rahmen dieser internen Wissensplattform.
      </p>

      <section>
        <h2>1. Verantwortlicher</h2>
        <address>
          <strong>SSA Fluidra Österreich GmbH</strong><br />
          Sirona Straße 1, 5071 Wals-Himmelreich<br />
          E-Mail: <a href="mailto:office_ssa@fluidra.com">office_ssa@fluidra.com</a><br />
          Telefon: <a href="tel:+43662855001">+43 662 855 001</a>
        </address>
      </section>

      <section>
        <h2>2. Welche Daten wir verarbeiten</h2>
        <p>Diese Website verarbeitet ausschließlich Daten, die für den Betrieb der internen
        Produktwissensdatenbank erforderlich sind:</p>

        <h3>Kontodaten</h3>
        <p>
          Bei der Registrierung werden Name, Benutzername, E-Mail-Adresse und Passwort
          (verschlüsselt gespeichert) erhoben. Diese Daten sind notwendig, um Ihnen Zugang zur
          Plattform zu gewähren.
        </p>

        <h3>Nutzungsdaten / Auditprotokoll</h3>
        <p>
          Bestimmte Aktionen (z. B. Anlegen oder Bearbeiten von Produktseiten) werden in einem
          internen Auditprotokoll mit Zeitstempel und Benutzerkennung festgehalten. Zweck ist die
          Nachvollziehbarkeit von Änderungen an den Produktdaten.
        </p>

        <h3>Technische Speicherung im Browser</h3>
        <p>Ihr Browser speichert folgende Daten lokal auf Ihrem Gerät:</p>
        <ul>
          <li>
            <strong>Sitzungs-Cookie <code>wiki_auth_jwt</code></strong> – enthält ein
            verschlüsseltes Anmeldetoken zur Aufrechterhaltung Ihrer Sitzung. Gültig für 7 Tage.
            Dieser Cookie ist technisch zwingend erforderlich und kann nicht deaktiviert werden,
            ohne die Anmeldefunktion zu deaktivieren.
          </li>
          <li>
            <strong>Lokale Spracheinstellung (<code>wiki-language</code>)</strong> – speichert
            Ihre gewählte Sprache (Deutsch / Englisch). Bleibt bis zur manuellen Löschung
            gespeichert.
          </li>
          <li>
            <strong>Suchverlauf (<code>wiki-search-history</code>)</strong> – Ihre zuletzt
            eingegebenen Suchbegriffe, um die Suchfunktion zu erleichtern. Nur lokal in Ihrem
            Browser gespeichert; wird nicht an den Server übertragen.
          </li>
          <li>
            <strong>Bild-Cache (<code>item-images-*</code>)</strong> – URLs von
            Produktbildern werden lokal zwischengespeichert, um Ladezeiten zu verkürzen.
          </li>
          <li>
            <strong>Sitzungs-Scrollposition</strong> – vorübergehender Speicher für die aktuelle
            Scrollposition auf Listenansichten, der beim Schließen des Tabs automatisch gelöscht
            wird (sessionStorage).
          </li>
        </ul>
        <p>
          Alle oben genannten Browser-Daten verbleiben ausschließlich auf Ihrem Gerät und werden
          nicht an Dritte weitergegeben.
        </p>
      </section>

      <section>
        <h2>3. Rechtsgrundlage</h2>
        <p>
          Die Verarbeitung Ihrer Daten erfolgt auf Basis von Art. 6 Abs. 1 lit. b DSGVO
          (Vertragserfüllung bzw. vorvertragliche Maßnahmen) sowie Art. 6 Abs. 1 lit. f DSGVO
          (berechtigtes Interesse an einem sicheren und nachvollziehbaren Betrieb der internen
          Wissensdatenbank).
        </p>
      </section>

      <section>
        <h2>4. Datenweitergabe an Dritte</h2>
        <p>
          <strong>Wir geben Ihre Daten nicht an Dritte weiter.</strong> Diese Plattform ist ein
          internes Werkzeug; es werden keine Daten an externe Dienstleister, Werbepartner oder
          sonstige Dritte übermittelt. Es werden keine Analyse-, Tracking- oder
          Werbedienste eingesetzt.
        </p>
      </section>

      <section>
        <h2>5. Speicherdauer</h2>
        <p>
          Kontodaten werden für die Dauer Ihres Beschäftigungsverhältnisses gespeichert und nach
          Beendigung gelöscht oder anonymisiert, soweit keine gesetzlichen Aufbewahrungspflichten
          bestehen. Der Sitzungs-Cookie läuft nach 7 Tagen automatisch ab. Lokale
          Browser-Daten verbleiben bis zur manuellen Löschung in Ihrem Browser.
        </p>
      </section>

      <section>
        <h2>6. Ihre Rechte</h2>
        <p>Ihnen stehen grundsätzlich folgende Rechte zu:</p>
        <ul>
          <li>Auskunftsrecht (Art. 15 DSGVO)</li>
          <li>Recht auf Berichtigung (Art. 16 DSGVO)</li>
          <li>Recht auf Löschung (Art. 17 DSGVO)</li>
          <li>Recht auf Einschränkung der Verarbeitung (Art. 18 DSGVO)</li>
          <li>Recht auf Datenübertragbarkeit (Art. 20 DSGVO)</li>
          <li>Widerspruchsrecht (Art. 21 DSGVO)</li>
        </ul>
        <p>
          Zur Ausübung dieser Rechte wenden Sie sich bitte an:{" "}
          <a href="mailto:office_ssa@fluidra.com">office_ssa@fluidra.com</a>
        </p>
      </section>

      <section>
        <h2>7. Beschwerderecht bei der Aufsichtsbehörde</h2>
        <p>
          Sie haben das Recht, sich bei der österreichischen Datenschutzbehörde zu beschweren:
        </p>
        <address>
          Österreichische Datenschutzbehörde<br />
          Barichgasse 40–42, 1030 Wien<br />
          E-Mail: <a href="mailto:dsb@dsb.gv.at">dsb@dsb.gv.at</a><br />
          Web:{" "}
          <a href="https://www.dsb.gv.at" target="_blank" rel="noopener noreferrer">
            www.dsb.gv.at
          </a>
        </address>
      </section>

      <section>
        <h2>8. Aktualität dieser Datenschutzerklärung</h2>
        <p>
          Diese Datenschutzerklärung ist aktuell gültig und hat den Stand Juni 2025. Durch die
          Weiterentwicklung unserer Website können Anpassungen erforderlich werden. Die jeweils
          aktuelle Version ist stets unter dieser URL abrufbar.
        </p>
      </section>
    </main>
  );
}
