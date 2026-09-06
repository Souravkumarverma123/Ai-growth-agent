"use client";

import { useCallback, useRef, useState } from "react";
import { ArrowRight, Bot, CircleCheck, CircleX, ShieldCheck, User } from "lucide-react";
import { toast } from "sonner";

import { TRPCClientError, type RouterOutputs } from "@repo/trpc/client";

import { trpc } from "~/trpc/client";
import { env } from "~/env.js";
import { formatRupees } from "~/lib/money";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Separator } from "~/components/ui/separator";
import { Textarea } from "~/components/ui/textarea";

/**
 * The one screen a human buyer sees. It holds no negotiation state of its own
 * beyond the running transcript (there is no server-side transcript endpoint
 * on the minimal buyer surface) — every decision and every figure comes
 * straight from a `negotiation.*` response.
 */

type PublicOffer = NonNullable<RouterOutputs["negotiation"]["propose"]["offer"]>;
type PaymentHandle = NonNullable<RouterOutputs["negotiation"]["acceptOffer"]["paymentHandle"]>;

type TranscriptEntry = {
  key: string;
  role: "buyer" | "agent" | "system";
  text: string;
  reasonCode?: string;
};

type Phase = "loading" | "unopened" | "negotiating" | "offer" | "accepted" | "ended";

let entrySeq = 0;
function nextKey(): string {
  entrySeq += 1;
  return `t${entrySeq}`;
}

/**
 * The message to show a buyer for a failed call. A `TRPCClientError` carries
 * the procedure's own message — the deliberate buyer-facing ones
 * (`NOT_AT_RISK`, the round cap, autonomous-payment refused) and, for an
 * unexpected server fault, tRPC's redacted "Internal server error" in
 * production. Anything else (a non-Error rejection) falls back to `fallback`.
 */
function errorText(error: unknown, fallback: string): string {
  return error instanceof TRPCClientError && typeof error.message === "string"
    ? error.message
    : fallback;
}

/** Loads Razorpay's hosted checkout script once, on demand. */
interface RazorpayInstance {
  open: () => void;
}
interface RazorpayOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description?: string;
  handler?: (response: Record<string, unknown>) => void;
  modal?: { ondismiss?: () => void };
}
type RazorpayConstructor = new (options: RazorpayOptions) => RazorpayInstance;

let razorpayLoad: Promise<RazorpayConstructor> | undefined;

function loadRazorpayCheckout(): Promise<RazorpayConstructor> {
  const w = window as typeof window & { Razorpay?: RazorpayConstructor };
  if (w.Razorpay) return Promise.resolve(w.Razorpay);
  // Memoised: repeated activations before the script registers must not
  // append a second <script>.
  razorpayLoad ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    // Clear the memo on every failure path so a later attempt re-loads the
    // script instead of re-awaiting a permanently-rejected promise.
    script.onload = () => {
      if (w.Razorpay) {
        resolve(w.Razorpay);
      } else {
        razorpayLoad = undefined;
        reject(new Error("Razorpay checkout loaded but did not register"));
      }
    };
    script.onerror = () => {
      razorpayLoad = undefined;
      reject(new Error("Could not load Razorpay checkout"));
    };
    document.body.appendChild(script);
  });
  return razorpayLoad;
}

function RoleBadge({ role }: { role: TranscriptEntry["role"] }) {
  if (role === "buyer") {
    return (
      <span className="text-muted-foreground inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wide">
        <User className="size-3" /> You
      </span>
    );
  }
  if (role === "agent") {
    return (
      <span className="text-muted-foreground inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wide">
        <Bot className="size-3" /> Merchant agent
      </span>
    );
  }
  return (
    <span className="text-muted-foreground inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wide">
      System
    </span>
  );
}

export function BuyerNegotiationConsole({ sessionId }: { sessionId: string }) {
  // A stable, obviously-not-a-real-agent id for this browser session. The
  // buyer surface is operated by a human here; the id only has to be present
  // and stable for the audit ledger.
  const [buyerAgentId] = useState(() => `human-buyer-${Math.random().toString(36).slice(2, 10)}`);

  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [message, setMessage] = useState("");
  const [opened, setOpened] = useState(false);
  const [currentOffer, setCurrentOffer] = useState<PublicOffer | null>(null);
  const [paymentHandle, setPaymentHandle] = useState<PaymentHandle | null>(null);
  const [ended, setEnded] = useState<string | null>(null);
  // Set when a fresh page load hits a session that is already past OPEN (a
  // pending offer, awaiting payment, …). This screen keeps no server-side
  // transcript or offer, so such a session cannot be resumed here.
  const [stalledState, setStalledState] = useState<string | null>(null);
  const [authorizing, setAuthorizing] = useState(false);
  const authorizedRef = useRef(false);

  const contextQuery = trpc.negotiation.getSessionContext.useQuery({ sessionId });
  const openMutation = trpc.negotiation.openNegotiation.useMutation();
  const proposeMutation = trpc.negotiation.propose.useMutation();
  const respondMutation = trpc.negotiation.respondToOffer.useMutation();
  const acceptMutation = trpc.negotiation.acceptOffer.useMutation();

  const busy =
    openMutation.isPending ||
    proposeMutation.isPending ||
    respondMutation.isPending ||
    acceptMutation.isPending;

  const append = useCallback((entry: Omit<TranscriptEntry, "key">) => {
    setTranscript((prev) => [...prev, { ...entry, key: nextKey() }]);
  }, []);

  const phase: Phase = contextQuery.isLoading
    ? "loading"
    : paymentHandle
      ? "accepted"
      : ended
        ? "ended"
        : currentOffer
          ? "offer"
          : opened
            ? "negotiating"
            : "unopened";

  async function handleOpen() {
    try {
      const result = await openMutation.mutateAsync({ sessionId, buyerAgentId });
      if (result.opened) {
        setOpened(true);
        append({ role: "system", text: "Negotiation opened.", reasonCode: result.reasonCode });
      } else {
        append({ role: "system", text: result.message, reasonCode: result.reasonCode });
      }
    } catch (error) {
      const text = errorText(error, "Could not open the negotiation.");
      // A reload mid-negotiation lands here — the server names the state it
      // found. Only a still-OPEN session can carry on proposing; anything
      // further along has a pending offer / payment this screen can't restore.
      const foundState = /pre-negotiation state \(([A-Z_]+)\)/.exec(text)?.[1];
      if (foundState === "OPEN") {
        setOpened(true);
        append({ role: "system", text: "Negotiation already open — continuing." });
      } else if (foundState) {
        setStalledState(foundState);
      } else {
        append({ role: "system", text });
      }
    }
  }

  async function handlePropose() {
    const text = message.trim();
    if (!text) return;
    setMessage("");
    append({ role: "buyer", text });
    try {
      const result = await proposeMutation.mutateAsync({ negotiationId: sessionId, message: text });
      if (result.offer) {
        setCurrentOffer(result.offer);
        append({ role: "agent", text: result.offer.message, reasonCode: result.reasonCode });
      } else if (result.terminal) {
        setEnded(result.reasonCode);
        append({
          role: "agent",
          text: "The merchant agent ended the negotiation.",
          reasonCode: result.reasonCode,
        });
      } else {
        append({ role: "agent", text: "No offer this round.", reasonCode: result.reasonCode });
      }
    } catch (error) {
      append({
        role: "system",
        text: errorText(error, "The proposal failed."),
      });
    }
  }

  async function handleRespond(response: "DECLINE_AND_CONTINUE" | "WALK_AWAY") {
    if (!currentOffer) return;
    const offerId = currentOffer.offerId;
    append({
      role: "buyer",
      text: response === "WALK_AWAY" ? "Walk away." : "Decline — keep negotiating.",
    });
    try {
      const result = await respondMutation.mutateAsync({
        negotiationId: sessionId,
        offerId,
        response,
      });
      setCurrentOffer(null);
      if (result.terminal) {
        setEnded(result.reasonCode);
        append({ role: "system", text: "Negotiation ended.", reasonCode: result.reasonCode });
      } else {
        append({
          role: "system",
          text: "Offer declined — send another message to continue.",
          reasonCode: result.reasonCode,
        });
      }
    } catch (error) {
      append({
        role: "system",
        text: errorText(error, "The response failed."),
      });
    }
  }

  async function handleAccept() {
    if (!currentOffer) return;
    const offerId = currentOffer.offerId;
    append({ role: "buyer", text: "Accept this offer." });
    try {
      const result = await acceptMutation.mutateAsync({ negotiationId: sessionId, offerId });
      if (result.accepted && result.paymentHandle) {
        setCurrentOffer(null);
        setPaymentHandle(result.paymentHandle);
        append({
          role: "system",
          text: "Offer accepted. Authorize payment to complete.",
          reasonCode: result.reasonCode,
        });
      } else {
        setEnded(result.reasonCode);
        append({
          role: "system",
          text: "The offer could not be accepted.",
          reasonCode: result.reasonCode,
        });
      }
    } catch (error) {
      // Includes the autonomous-payment-not-authorized refusal (NOT_IMPLEMENTED)
      // — the buyer surface never charges autonomously.
      append({
        role: "system",
        text: errorText(error, "The offer could not be accepted."),
      });
    }
  }

  async function handleAuthorize() {
    if (!paymentHandle) return;
    const keyId = env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
    if (!keyId) {
      toast.error("Razorpay test key is not configured on this deployment.");
      return;
    }
    setAuthorizing(true);
    try {
      const Razorpay = await loadRazorpayCheckout();
      const checkout = new Razorpay({
        key: keyId,
        order_id: paymentHandle.railOrderId,
        amount: paymentHandle.amountMinor,
        currency: paymentHandle.currency,
        name: "Merchant Growth Agent",
        description: `Authorize payment for order ${paymentHandle.orderId}`,
        handler: () => {
          // Razorpay's client callback only says the buyer finished the
          // checkout step — it is not proof of a settled payment. The
          // merchant confirms that out of band (rail reconciliation); this
          // screen never persists or asserts settlement itself.
          authorizedRef.current = true;
          append({
            role: "system",
            text: "Checkout submitted to Razorpay. The merchant will confirm the payment separately.",
          });
          toast.success("Checkout submitted.");
        },
        modal: {
          ondismiss: () => {
            if (!authorizedRef.current) {
              toast("Checkout closed — you can authorize again.");
            }
          },
        },
      });
      checkout.open();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not open Razorpay checkout.");
    } finally {
      setAuthorizing(false);
    }
  }

  if (contextQuery.isError) {
    return (
      <Card className="border-destructive">
        <CardHeader>
          <CardTitle>Session not found</CardTitle>
          <CardDescription>
            No negotiation session for id <span className="font-mono">{sessionId}</span>:{" "}
            {contextQuery.error.message}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const context = contextQuery.data;

  return (
    <div className="flex flex-col gap-6">
      {/* What the agent is negotiating over. Read-only — no storefront. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your cart</CardTitle>
          <CardDescription>
            {context ? (
              context.negotiationAvailable ? (
                "The merchant flagged this checkout for negotiation."
              ) : (
                "This checkout has not been flagged for negotiation by the merchant."
              )
            ) : (
              "Loading…"
            )}
          </CardDescription>
        </CardHeader>
        {context && (
          <CardContent className="flex flex-col gap-2 text-sm">
            {context.lines.map((line, index) => (
              <div key={`${line.sku}-${index}`} className="flex items-baseline justify-between gap-4">
                <span>
                  {line.name} <span className="text-muted-foreground">×{line.quantity}</span>
                </span>
                <span className="font-mono">{formatRupees(line.unitPriceMinor * line.quantity)}</span>
              </div>
            ))}
          </CardContent>
        )}
      </Card>

      {/* Transcript. */}
      {transcript.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Transcript</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {transcript.map((entry) => (
              <div key={entry.key} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <RoleBadge role={entry.role} />
                  {entry.reasonCode && (
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {entry.reasonCode}
                    </Badge>
                  )}
                </div>
                <p className="text-sm">{entry.text}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Current offer — the thing to accept or decline. */}
      {currentOffer && phase === "offer" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Current offer</CardTitle>
            <CardDescription>
              Expires {new Date(currentOffer.expiresAt).toLocaleString()}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            {currentOffer.lines.map((line, index) => (
              <div key={`${line.sku}-${index}`} className="flex items-baseline justify-between gap-4">
                <span>
                  {line.name} <span className="text-muted-foreground">×{line.quantity}</span>
                </span>
                <span className="font-mono">{formatRupees(line.unitPriceMinor * line.quantity)}</span>
              </div>
            ))}
            {currentOffer.commitments.length > 0 && (
              <div className="text-muted-foreground flex flex-wrap gap-1 pt-1">
                {currentOffer.commitments.map((commitment) => (
                  <Badge key={commitment} variant="secondary" className="font-mono text-[10px]">
                    {commitment}
                  </Badge>
                ))}
              </div>
            )}
            <Separator className="my-1" />
            <div className="flex items-baseline justify-between gap-4 font-medium">
              <span>Total</span>
              <span className="font-mono">{formatRupees(currentOffer.totalMinor)}</span>
            </div>
          </CardContent>
          <CardFooter className="flex-wrap justify-end gap-3">
            <Button variant="ghost" disabled={busy} onClick={() => handleRespond("WALK_AWAY")}>
              Walk away
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => handleRespond("DECLINE_AND_CONTINUE")}
            >
              Decline &amp; continue
            </Button>
            <Button disabled={busy} onClick={handleAccept}>
              Accept offer
            </Button>
          </CardFooter>
        </Card>
      )}

      {/* A mid-negotiation session reached by a fresh page load — not resumable here. */}
      {stalledState && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Negotiation already in progress</CardTitle>
            <CardDescription>
              This negotiation is past the opening stage (
              <span className="font-mono">{stalledState}</span>) and can&apos;t be resumed from a
              fresh page load. Continue from the agent that opened it.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* Message composer — open the negotiation, then state your case. Only
          shown while there's something to do: an unflagged checkout has
          nothing to open (the cart card says so), and a stalled session
          can't be driven from here. */}
      {!stalledState &&
        context &&
        (phase === "negotiating" || (phase === "unopened" && context.negotiationAvailable)) && (
        <Card>
          <CardContent className="flex flex-col gap-3">
            {phase === "unopened" ? (
              <Button onClick={handleOpen} disabled={openMutation.isPending}>
                {openMutation.isPending ? "Opening…" : "Open negotiation"}
              </Button>
            ) : (
              <>
                <Textarea
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder="Tell the merchant agent what you're looking for…"
                  maxLength={2000}
                  rows={3}
                />
                <div className="flex justify-end">
                  <Button onClick={handlePropose} disabled={busy || !message.trim()}>
                    {proposeMutation.isPending ? "Sending…" : "Send"}
                    <ArrowRight className="size-4" />
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Payment authorization handoff. */}
      {phase === "accepted" && paymentHandle && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CircleCheck className="size-4" /> Offer accepted
            </CardTitle>
            <CardDescription className="flex items-center gap-1">
              <ShieldCheck className="size-3.5" />
              You authorize this payment. The agent cannot charge you.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-muted-foreground">Amount</span>
              <span className="font-mono">{formatRupees(paymentHandle.amountMinor)}</span>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-muted-foreground">Razorpay order</span>
              <span className="font-mono">{paymentHandle.railOrderId}</span>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-muted-foreground">Order ref</span>
              <span className="font-mono">{paymentHandle.orderId}</span>
            </div>
          </CardContent>
          <CardFooter className="flex-col items-stretch gap-2">
            <Button onClick={handleAuthorize} disabled={authorizing || !env.NEXT_PUBLIC_RAZORPAY_KEY_ID}>
              {authorizing ? "Opening Razorpay…" : "Authorize payment with Razorpay"}
            </Button>
            {!env.NEXT_PUBLIC_RAZORPAY_KEY_ID && (
              <p className="text-muted-foreground text-xs">
                Razorpay test checkout is not configured here. The handle above is everything a
                buyer needs to authorize the payment on the rail directly.
              </p>
            )}
          </CardFooter>
        </Card>
      )}

      {/* Terminal state. */}
      {phase === "ended" && ended && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CircleX className="size-4" /> Negotiation ended
            </CardTitle>
            <CardDescription>
              <Badge variant="outline" className="font-mono text-[10px]">
                {ended}
              </Badge>
            </CardDescription>
          </CardHeader>
        </Card>
      )}
    </div>
  );
}
