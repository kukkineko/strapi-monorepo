import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Impressum – SSA Fluidra Österreich GmbH",
};

export default function ImpressumPage() {
  return (
    <main className="wiki-shell wiki-legal-page">
      <nav className="wiki-legal-back">
        <Link href="/">← Zurück zur Startseite</Link>
      </nav>

      <h1>Impressum</h1>

      <p className="wiki-legal-source">
        Informationspflicht laut §5 E-Commerce Gesetz, §14 Unternehmensgesetzbuch,
        §63 Gewerbeordnung und Offenlegungspflicht laut §25 Mediengesetz.
      </p>

      <section>
        <h2>Unternehmensangaben</h2>
        <address>
          <strong>SSA Fluidra Österreich GmbH</strong><br />
          Sirona Straße 1<br />
          5071 Wals-Himmelreich<br />
          Österreich
        </address>
        <p><strong>Unternehmensgegenstand:</strong> Großhandel für Schwimmbad und Saunazubehör</p>
        <p><strong>Telefon:</strong> <a href="tel:+43662855001">+43 662 855 001</a></p>
        <p><strong>E-Mail:</strong> <a href="mailto:office_ssa@fluidra.com">office_ssa@fluidra.com</a></p>
        <p><strong>Geschäftsführer:</strong> Marc Dominic Cirkel, David Mendez und Jean Pierre Pelliccia</p>
        <p><strong>UID-Nummer:</strong> ATU61154235</p>
      </section>

      <section>
        <h2>Urheberrechtshinweis</h2>
        <p>
          Alle Inhalte dieser Webseite (Bilder, Fotos, Texte, Videos) unterliegen dem Urheberrecht.
          Falls notwendig, werden wir die unerlaubte Nutzung von Teilen der Inhalte unserer Seite
          rechtlich verfolgen.
        </p>
      </section>

      <section>
        <h2>EU-Streitschlichtung</h2>
        <p>
          Gemäß Verordnung über Online-Streitbeilegung in Verbraucherangelegenheiten
          (ODR-Verordnung) möchten wir Sie über die Online-Streitbeilegungsplattform (OS-Plattform)
          informieren. Verbraucher haben die Möglichkeit, Beschwerden an die Online
          Streitbeilegungsplattform der Europäischen Kommission unter{" "}
          <a
            href="http://ec.europa.eu/odr"
            target="_blank"
            rel="noopener noreferrer"
          >
            http://ec.europa.eu/odr
          </a>{" "}
          zu richten. Die dafür notwendigen Kontaktdaten finden Sie oberhalb in unserem Impressum.
        </p>
        <p>
          Wir möchten Sie jedoch darauf hinweisen, dass wir nicht bereit oder verpflichtet sind,
          an Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen.
        </p>
      </section>

      <section>
        <h2>Haftung für Inhalte dieser Website</h2>
        <p>
          Wir entwickeln die Inhalte dieser Website ständig weiter und bemühen uns korrekte und
          aktuelle Informationen bereitzustellen. Leider können wir keine Haftung für die
          Korrektheit aller Inhalte auf dieser Website übernehmen, speziell für jene, die seitens
          Dritter bereitgestellt wurden. Als Diensteanbieter sind wir nicht verpflichtet, die von
          ihnen übermittelten oder gespeicherten Informationen zu überwachen oder nach Umständen
          zu forschen, die auf eine rechtswidrige Tätigkeit hinweisen.
        </p>
        <p>
          Unsere Verpflichtungen zur Entfernung von Informationen oder zur Sperrung der Nutzung
          von Informationen nach den allgemeinen Gesetzen aufgrund von gerichtlichen oder
          behördlichen Anordnungen bleiben auch im Falle unserer Nichtverantwortlichkeit davon
          unberührt.
        </p>
        <p>
          Sollten Ihnen problematische oder rechtswidrige Inhalte auffallen, bitten wir Sie uns
          umgehend zu kontaktieren, damit wir die rechtswidrigen Inhalte entfernen können. Sie
          finden die Kontaktdaten im Impressum.
        </p>
      </section>

      <section>
        <h2>Haftung für Links auf dieser Website</h2>
        <p>
          Unsere Website enthält Links zu anderen Websites, für deren Inhalt wir nicht
          verantwortlich sind. Haftung für verlinkte Websites besteht für uns nicht, da wir keine
          Kenntnis rechtswidriger Tätigkeiten hatten und haben, uns solche Rechtswidrigkeiten auch
          bisher nicht aufgefallen sind und wir Links sofort entfernen würden, wenn uns
          Rechtswidrigkeiten bekannt werden.
        </p>
        <p>
          Wenn Ihnen rechtswidrige Links auf unserer Website auffallen, bitten wir Sie uns zu
          kontaktieren. Sie finden die Kontaktdaten im Impressum.
        </p>
      </section>

      <section>
        <h2>Bildernachweis</h2>
        <p>
          Die Bilder, Fotos und Grafiken auf dieser Webseite sind urheberrechtlich geschützt.
          Bildquellen: Freepik, Pexels, Pixabay, Flaticon.
        </p>
      </section>

      <p className="wiki-legal-source">
        Quelle: Erstellt mit dem Impressum Generator von{" "}
        <a href="https://www.firmenwebseiten.at" target="_blank" rel="noopener noreferrer">
          firmenwebseiten.at
        </a>
      </p>
    </main>
  );
}
