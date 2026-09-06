import { cn } from "~/lib/utils";
import type { ReasonTone } from "~/lib/event-stream";
import { Badge } from "~/components/ui/badge";

/**
 * THE JUSTIFICATION, rendered (PRD §13.2). The raw reason code, never
 * paraphrased — shared by the live event stream (TICKET-502) and the audit
 * trail (TICKET-505) so the one authoritative field looks identical on both
 * screens. `tone` is cosmetic weight only (`lib/event-stream.ts`
 * `reasonTone`); the code itself is always shown in full.
 */

/**
 * Tone → badge class. Shared so any merchant screen that shows a tone-weighted
 * pill (the reason code here, the offer lifecycle status on TICKET-504's
 * card) renders the four tones identically.
 */
export const REASON_TONE_CLASS: Record<ReasonTone, string> = {
  positive: "border-transparent bg-emerald-600 text-white dark:bg-emerald-500/80",
  negative: "border-transparent bg-destructive text-white dark:bg-destructive/70",
  warning: "border-transparent bg-amber-500 text-white dark:bg-amber-500/80",
  neutral: "border-transparent bg-secondary text-secondary-foreground",
};

export function ReasonCodeBadge({
  code,
  tone,
  className,
}: {
  code: string;
  tone: ReasonTone;
  className?: string;
}) {
  return (
    <Badge className={cn("font-mono text-[11px] tracking-tight", REASON_TONE_CLASS[tone], className)}>
      {code}
    </Badge>
  );
}
