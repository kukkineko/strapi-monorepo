export default function Loading() {
  return (
    <main className="wiki-shell">
      <div className="wiki-header" style={{ minHeight: 52 }} />
      <section className="wiki-card">
        <div className="wiki-rubrik-grid">
          {Array.from({ length: 17 }).map((_, i) => (
            <div
              key={i}
              className="wiki-rubrik-card"
              style={{ minHeight: 76, opacity: 0 }}
            />
          ))}
        </div>
      </section>
    </main>
  );
}
