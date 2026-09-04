import { router } from "./trpc";

import { healthRouter } from "./routes/health/route";
import { negotiationRouter } from "./routes/negotiation/route";
import { merchantRouter } from "./routes/merchant/route";
import { auditRouter } from "./routes/audit/route";

export const serverRouter = router({
  health: healthRouter,
  negotiation: negotiationRouter,
  merchant: merchantRouter,
  audit: auditRouter,
});

export { createContext } from "./context";
export type ServerRouter = typeof serverRouter;
