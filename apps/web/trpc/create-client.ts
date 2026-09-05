import { httpLink, httpBatchStreamLink } from "@repo/trpc/client";
import { env } from "~/env.js";

interface CreateTRPCHttpBatchClientClientOpts {
  enableStreaming?: boolean;
}

function getUrl() {
  // If explicit API URL is set, use it
  if (env.NEXT_PUBLIC_API_URL) return env.NEXT_PUBLIC_API_URL;
  // On client, relative URL works (same origin)
  if (typeof window !== "undefined") return "/trpc";
  // On server, need absolute URL for fetch
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}/trpc`;
  // Fallback for local dev / build - if server not running during prerender, fetch will fail
  // but page should handle that gracefully with dynamic rendering
  const port = process.env.PORT ?? 3000;
  return `http://localhost:${port}/trpc`;
}

export const createTRPCHttpBatchClientClient = (opts?: CreateTRPCHttpBatchClientClientOpts) => {
  const c = opts?.enableStreaming ? httpBatchStreamLink : httpLink;
  return c({
    url: getUrl(),
    fetch(url, options) {
      return fetch(url, {
        ...options,
        credentials: "include",
      });
    },
  });
};
