/** @type {import('next').NextConfig} */
const nextConfig = {
  // The session page must never be framed: a call embedded in someone else's
  // page is a credible way to harvest a camera feed under XPRTO's name.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=(), payment=()" },
        ],
      },
    ];
  },
};
export default nextConfig;
