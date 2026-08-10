/**
 * Tokens, not hex codes.
 *
 * Every colour is an HSL channel triplet in globals.css, referenced here as
 * `hsl(var(--x) / <alpha-value>)`. That last part is what lets `bg-surface/60`
 * work — with a full `hsl(...)` string Tailwind cannot compose opacity, and the
 * whole palette becomes opaque-only.
 *
 * Matches the approach in the gym dashboard, so the two read as one product.
 */
const token = name => `hsl(var(${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: token("--canvas"),
        surface: token("--surface"),
        "surface-raised": token("--surface-raised"),
        line: token("--line"),
        ink: token("--ink"),
        "ink-muted": token("--ink-muted"),
        "ink-subtle": token("--ink-subtle"),
        accent: token("--accent"),
        "accent-ink": token("--accent-ink"),
        danger: token("--danger"),
        "danger-ink": token("--danger-ink"),
        warning: token("--warning"),
        "warning-ink": token("--warning-ink"),
        success: token("--success"),
        // The call stage is deliberately dark in both themes — video reads
        // against black, and a light stage makes every camera look washed out.
        stage: token("--stage"),
      },
      borderRadius: { xl2: "14px" },
      boxShadow: {
        tile: "0 8px 24px rgb(0 0 0 / 0.45)",
        bar: "0 4px 24px rgb(0 0 0 / 0.35)",
      },
    },
  },
  plugins: [],
};
