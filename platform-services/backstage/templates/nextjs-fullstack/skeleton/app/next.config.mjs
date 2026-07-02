/** @type {import('next').NextConfig} */
// output: 'standalone' makes `next build` emit .next/standalone (a self-contained
// server.js + the traced node_modules subset), which the Dockerfile copies into a
// minimal runtime image. The standalone server listens on $PORT / $HOSTNAME.
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
};

export default nextConfig;
