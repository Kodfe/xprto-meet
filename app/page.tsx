/**
 * The root. Nothing lives here — sessions are only ever reached at /s/<slug>,
 * and there is no directory of rooms to land on by design.
 */
export default function Home() {
  return (
    <main id="app">
      <header className="bar">
        <span className="brand">XPRTO</span>
      </header>
      <section className="view">
        <div className="card">
          <h1>This is not a session link</h1>
          <p className="muted">Open the link from your XPRTO booking.</p>
        </div>
      </section>
    </main>
  );
}
