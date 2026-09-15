import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The Admin SDK and its gRPC transport must stay external to the server bundle.
  serverExternalPackages: ["firebase-admin", "@google-cloud/firestore", "@google-cloud/storage"],
  // Study content is private; never let a page be cached by a shared proxy.
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
