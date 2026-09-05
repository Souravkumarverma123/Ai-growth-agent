"use client";

import { useMemo } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, type Control } from "react-hook-form";
import { z } from "zod";
import { toast } from "sonner";
import { AlertTriangle, ShieldAlert } from "lucide-react";

import { trpc } from "~/trpc/client";
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
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "~/components/ui/form";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";

/**
 * TICKET-501 — the demo ships with exactly one merchant
 * (`packages/database/seed.ts`'s `SEED_MERCHANT_ID`). Hardcoded here rather
 * than imported from `@repo/database` — this ticket's affected packages are
 * `apps/web` and `packages/trpc` only, and this is a fixed, well-known id,
 * not something that needs a live database read from the web app.
 */
const DEMO_MERCHANT_ID = "212eda77-06c0-46ef-ae17-24b6d4088188";

type CommitmentType = "PREPAID" | "NON_RETURNABLE" | "EXTENDED_DELIVERY_WINDOW";

const COMMITMENT_LABELS: Record<CommitmentType, string> = {
  PREPAID: "Prepaid",
  NON_RETURNABLE: "Non-returnable",
  EXTENDED_DELIVERY_WINDOW: "Extended delivery window",
};

const policyFormSchema = z.object({
  campaignBudgetRupees: z.coerce.number().nonnegative("Must be zero or more"),
  perDealCapRupees: z.coerce.number().nonnegative("Must be zero or more"),
  maxRounds: z.coerce.number().int().positive("Must be at least 1"),
  offerTtlSeconds: z.coerce.number().int().positive("Must be at least 1 second"),
  // The "three pre-computed proposed bounds" the ticket refers to: one value
  // per entry in the closed COMMITMENT_TYPES set. Generating what these
  // *should* be is out of scope (TICKET-501's own scope note) — this form
  // only lets the merchant review and edit whatever numbers arrived
  // pre-filled, then approve.
  prepaidValueRupees: z.coerce.number().nonnegative("Must be zero or more"),
  nonReturnableValueRupees: z.coerce.number().nonnegative("Must be zero or more"),
  extendedDeliveryValueRupees: z.coerce.number().nonnegative("Must be zero or more"),
});

// z.coerce.number() makes the schema's *input* type `unknown` (it accepts
// anything and coerces it) while its *output* type is `number` — react-hook-
// form's resolver needs both ends named explicitly, or TS can't line up
// `useForm`'s default-values type with the post-validation submit type.
type PolicyFormInput = z.input<typeof policyFormSchema>;
type PolicyFormValues = z.output<typeof policyFormSchema>;

function minorToRupees(minor: number): number {
  return minor / 100;
}

function rupeesToMinor(rupees: number): number {
  return Math.round(rupees * 100);
}

/**
 * A single numeric policy field, bound through `FormField`. Centralizes the
 * one cast this file needs: `z.coerce.number()` makes each field's *input*
 * type `unknown` (see the comment above `PolicyFormInput`), so `field.value`
 * arrives typed `unknown` and has to be told it's really a number before it
 * can be handed to a controlled `<input value=... />`.
 */
function PolicyNumberField({
  control,
  name,
  label,
  description,
  min = 0,
}: {
  control: Control<PolicyFormInput>;
  name: keyof PolicyFormInput;
  label: string;
  description?: string;
  min?: number;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              type="number"
              min={min}
              step="1"
              name={field.name}
              onBlur={field.onBlur}
              onChange={field.onChange}
              ref={field.ref}
              value={field.value as number}
            />
          </FormControl>
          {description ? <FormDescription>{description}</FormDescription> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

// Sensible pre-filled example values, used only if a merchant somehow has no
// policy row and no commitment values yet — generation of real bounds is out
// of scope for this ticket.
const FALLBACK_DEFAULTS = {
  campaignBudgetMinor: 50_000_00,
  perDealCapMinor: 200_00,
  maxRounds: 3,
  offerTtlSeconds: 600,
  prepaidValueMinor: 120_00,
  nonReturnableValueMinor: 90_00,
  extendedDeliveryValueMinor: 60_00,
};

export function MerchantPolicyConsole() {
  const merchantId = DEMO_MERCHANT_ID;
  const utils = trpc.useUtils();

  const policyQuery = trpc.merchant.getPolicy.useQuery({ merchantId });

  const approveMutation = trpc.merchant.approvePolicy.useMutation({
    onSuccess: async (result) => {
      toast.success(`Policy approved — now version ${result.policyVersion}`);
      await utils.merchant.getPolicy.invalidate({ merchantId });
    },
    onError: (error) => {
      toast.error(`Approval failed: ${error.message}`);
    },
  });

  const killSwitchMutation = trpc.merchant.setNegotiationEnabled.useMutation({
    onSuccess: async (result) => {
      toast.success(
        result.negotiationEnabled
          ? "Negotiation re-enabled — the agent may open new sessions again."
          : "Negotiation halted — the agent will not open or continue any session.",
      );
      await utils.merchant.getPolicy.invalidate({ merchantId });
    },
    onError: (error) => {
      toast.error(`Kill switch failed: ${error.message}`);
    },
  });

  const defaultValues = useMemo<PolicyFormValues>(() => {
    const policy = policyQuery.data;
    const commitmentValueFor = (type: CommitmentType) =>
      policy?.allowedCommitments.find((c) => c.commitmentType === type)?.valueMinor;

    return {
      campaignBudgetRupees: minorToRupees(
        policy?.campaignBudgetTotalMinor ?? FALLBACK_DEFAULTS.campaignBudgetMinor,
      ),
      perDealCapRupees: minorToRupees(policy?.perDealCapMinor ?? FALLBACK_DEFAULTS.perDealCapMinor),
      maxRounds: policy?.maxRounds ?? FALLBACK_DEFAULTS.maxRounds,
      offerTtlSeconds: policy?.offerTtlSeconds ?? FALLBACK_DEFAULTS.offerTtlSeconds,
      prepaidValueRupees: minorToRupees(
        commitmentValueFor("PREPAID") ?? FALLBACK_DEFAULTS.prepaidValueMinor,
      ),
      nonReturnableValueRupees: minorToRupees(
        commitmentValueFor("NON_RETURNABLE") ?? FALLBACK_DEFAULTS.nonReturnableValueMinor,
      ),
      extendedDeliveryValueRupees: minorToRupees(
        commitmentValueFor("EXTENDED_DELIVERY_WINDOW") ?? FALLBACK_DEFAULTS.extendedDeliveryValueMinor,
      ),
    };
  }, [policyQuery.data]);

  const form = useForm<PolicyFormInput, unknown, PolicyFormValues>({
    resolver: zodResolver(policyFormSchema),
    values: defaultValues,
  });

  function onSubmit(values: PolicyFormValues) {
    approveMutation.mutate({
      merchantId,
      campaignBudgetTotalMinor: rupeesToMinor(values.campaignBudgetRupees),
      perDealCapMinor: rupeesToMinor(values.perDealCapRupees),
      maxRounds: values.maxRounds,
      offerTtlSeconds: values.offerTtlSeconds,
      allowedCommitments: [
        { commitmentType: "PREPAID", valueMinor: rupeesToMinor(values.prepaidValueRupees) },
        {
          commitmentType: "NON_RETURNABLE",
          valueMinor: rupeesToMinor(values.nonReturnableValueRupees),
        },
        {
          commitmentType: "EXTENDED_DELIVERY_WINDOW",
          valueMinor: rupeesToMinor(values.extendedDeliveryValueRupees),
        },
      ],
    });
  }

  // The kill switch must be reachable in one click and must work even when
  // the rest of the policy hasn't loaded (RA-1: it's independent of
  // everything else). It only needs to know the current state to render a
  // sensible toggle position, so it degrades to "enabled" while loading.
  const negotiationEnabled = policyQuery.data?.negotiationEnabled ?? true;

  return (
    <div className="flex flex-col gap-6">
      {/* Independent, one-click, and never gated behind the approve form
          below: this is the only field writable at any time, including
          mid-negotiation (RA-1). */}
      <Card className={negotiationEnabled ? undefined : "border-destructive"}>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                <ShieldAlert className="size-4" />
                Negotiation kill switch
              </CardTitle>
              <CardDescription>
                Stops the agent from opening or continuing any negotiation. Safe to flip at any
                time, even mid-negotiation — it halts sessions, it never re-prices one in flight.
              </CardDescription>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span className="text-sm font-medium">{negotiationEnabled ? "Enabled" : "Halted"}</span>
              <Switch
                checked={negotiationEnabled}
                disabled={killSwitchMutation.isPending || policyQuery.isLoading}
                onCheckedChange={(checked) => killSwitchMutation.mutate({ merchantId, enabled: checked })}
                aria-label="Negotiation kill switch"
              />
            </div>
          </div>
        </CardHeader>
      </Card>

      {policyQuery.isLoading && (
        <p className="text-muted-foreground text-sm">Loading merchant policy…</p>
      )}

      {policyQuery.isError && (
        <p className="text-destructive text-sm">
          Could not load policy for merchant {merchantId}: {policyQuery.error.message}
        </p>
      )}

      {policyQuery.data && (
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Delegate authority</CardTitle>
                <CardDescription>
                  Every field below is pinned to whatever a negotiation session opened with —
                  editing and approving here only takes effect for sessions opened afterward.
                  Currently approved as{" "}
                  <Badge variant="secondary">v{policyQuery.data.policyVersion}</Badge>.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-6 sm:grid-cols-2">
                <PolicyNumberField
                  control={form.control}
                  name="campaignBudgetRupees"
                  label="Campaign budget, total (₹)"
                  description="Ceiling on lifetime dilutive (tier 2) spend."
                />

                <PolicyNumberField
                  control={form.control}
                  name="perDealCapRupees"
                  label="Per-deal cap (₹)"
                  description="Maximum dilution any single deal may consume."
                />

                <PolicyNumberField
                  control={form.control}
                  name="maxRounds"
                  label="Max negotiation rounds"
                  min={1}
                />

                <PolicyNumberField
                  control={form.control}
                  name="offerTtlSeconds"
                  label="Offer TTL (seconds)"
                  description="Also the campaign-hold TTL."
                  min={1}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Commitment values — the three proposed bounds</CardTitle>
                <CardDescription>
                  What each buyer commitment is worth to you, in rupees. Pre-filled with the
                  currently approved figures — review and edit, then approve; generating what
                  these should be isn&apos;t this screen&apos;s job.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-6 sm:grid-cols-3">
                <PolicyNumberField
                  control={form.control}
                  name="prepaidValueRupees"
                  label={COMMITMENT_LABELS.PREPAID}
                />
                <PolicyNumberField
                  control={form.control}
                  name="nonReturnableValueRupees"
                  label={COMMITMENT_LABELS.NON_RETURNABLE}
                />
                <PolicyNumberField
                  control={form.control}
                  name="extendedDeliveryValueRupees"
                  label={COMMITMENT_LABELS.EXTENDED_DELIVERY_WINDOW}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <AlertTriangle className="size-4" />
                  The slow-moving rule
                </CardTitle>
              </CardHeader>
              <CardContent className="text-muted-foreground space-y-2 text-sm">
                <p>
                  When a slow-moving item can stand in for the best candidate at nearly the same
                  contribution, the agent prefers it instead — &ldquo;nearly the same&rdquo; means
                  within{" "}
                  <span className="text-foreground font-medium">
                    {(policyQuery.data.slowMovingTolerance * 100).toFixed(0)}%
                  </span>{" "}
                  of the best contribution.
                </p>
                <p>
                  This is a fixed rule, not a merchant-configurable slider — there is deliberately
                  no input for it on this screen. Negotiable-SKU and slow-moving flags are set in
                  the catalogue, not here; this screen only carries the policy fields above.
                </p>
              </CardContent>
            </Card>

            <CardFooter className="justify-end gap-3 px-0">
              <Button type="submit" disabled={approveMutation.isPending}>
                {approveMutation.isPending ? "Approving…" : "Approve policy"}
              </Button>
            </CardFooter>
          </form>
        </Form>
      )}
    </div>
  );
}
