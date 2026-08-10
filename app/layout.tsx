import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
    title: "XPRTO Session",
    // Never indexed. A session URL in a search result would defeat the whole
    // design, and crawlers follow links that get pasted into public places.
    robots: { index: false, follow: false },
    referrer: "no-referrer",
};

export const viewport: Viewport = {
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
    // Both, so the page follows the phone rather than fighting it. The call
    // view is dark either way — that part is not a preference.
    themeColor: [
        { media: "(prefers-color-scheme: light)", color: "#f6f7f9" },
        { media: "(prefers-color-scheme: dark)", color: "#0d1014" },
    ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en">
            <body>{children}</body>
        </html>
    );
}
