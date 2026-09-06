/** @type {import('next').NextConfig} */
const nextConfig = {
  // Next 16's `next dev` otherwise writes AGENTS.md / CLAUDE.md into this
  // package on every run. This repo's agent instructions live in the root
  // CLAUDE.md; keep the generated per-app copies out of the tree.
  agentRules: false,
};

export default nextConfig;
