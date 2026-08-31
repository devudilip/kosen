/** @type {import('next').NextConfig} */
const nextConfig = {
  // better-sqlite3 (behind @kosen/ai's ScoreStore) is a native addon loaded
  // via require() — let Node load it directly at runtime instead of having
  // webpack try to statically bundle it (harmless warning otherwise, since
  // every page importing @kosen/ai is server-rendered on demand anyway).
  serverExternalPackages: ["better-sqlite3", "@kosen/ai"],
};

export default nextConfig;
