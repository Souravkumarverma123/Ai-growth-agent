import { api } from "~/trpc/server";

export const dynamic = "force-dynamic";

export default async function Home() {
  let status: string = "unknown";
  try {
    const data = await api.health.getHealth.query();
    status = data.status;
  } catch {
    // During build or when API is unavailable, don't crash prerender
    status = "unavailable";
  }
  return (
    <main className="min-h-screen min-w-screen flex justify-center items-center">
      <div>
        <h1 className="text-3xl">Streamyst - Stream in Style</h1>
        <h2>Server Status: {status}</h2>
      </div>
    </main>
  );
}
