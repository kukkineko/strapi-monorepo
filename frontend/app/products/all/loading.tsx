export default function Loading() {
  return (
    <main className="wiki-shell">
      <div className="wiki-header" style={{ minHeight: 52 }} />
      <div className="wiki-product-list">
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="wiki-product-skeleton">
            <div className="wiki-product-skeleton-thumb" />
            <div className="wiki-product-skeleton-body">
              <div className="wiki-product-skeleton-line" />
              <div className="wiki-product-skeleton-line short" />
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
