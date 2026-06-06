import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Inline env vars into the Lambda bundle at build time.
  // Amplify's SSM injection is unreliable — this ensures values
  // are hardcoded server-side during `npm run build` so Lambda
  // has them without needing runtime env var infrastructure.
  env: {
    DATABASE_URL: process.env.DATABASE_URL ?? "",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
    LANGSMITH_API_KEY: process.env.LANGSMITH_API_KEY ?? "",
    LANGSMITH_TRACING: process.env.LANGSMITH_TRACING ?? "false",
    LANGSMITH_PROJECT: process.env.LANGSMITH_PROJECT ?? "",
    LANGSMITH_ENDPOINT: process.env.LANGSMITH_ENDPOINT ?? "",
  },
};

export default nextConfig;
