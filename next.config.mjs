/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Recorded fallback frames are read from disk by the API route; make sure
  // they are bundled with the serverless function when deployed.
  outputFileTracingIncludes: {
    '/api/states': ['./data/recorded/**/*'],
  },
};

export default nextConfig;
