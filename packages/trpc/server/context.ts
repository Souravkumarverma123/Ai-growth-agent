import { db } from "@repo/database";

export async function createContext() {
  return { db };
}
export type Context = Awaited<ReturnType<typeof createContext>>;
