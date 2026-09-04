CREATE TYPE "public"."commitment_type" AS ENUM('PREPAID', 'NON_RETURNABLE', 'EXTENDED_DELIVERY_WINDOW');--> statement-breakpoint
CREATE TYPE "public"."candidate_move_type" AS ENUM('PRICE_CONCESSION', 'ADD_SKU', 'ADD_SLOW_MOVING_SKU', 'INCREASE_QUANTITY', 'COMMITMENT_SWAP');--> statement-breakpoint
CREATE TYPE "public"."negotiation_state" AS ENUM('IDLE', 'AT_RISK', 'OPEN', 'OFFER_PENDING', 'ACCEPTED', 'AWAITING_PAYMENT', 'SETTLED', 'PAYMENT_FAILED', 'EXPIRED', 'WALKED_AWAY', 'DECLINED', 'HALTED');--> statement-breakpoint
CREATE TYPE "public"."reason_code" AS ENUM('SESSION_FLAGGED_AT_RISK', 'NOT_AT_RISK', 'NEGOTIATION_DISABLED', 'SKU_NOT_NEGOTIABLE', 'NEGOTIATION_OPENED', 'CANDIDATES_EVALUATED', 'NO_FEASIBLE_BASKET', 'FLOOR_BREACH', 'TIER1_OFFERED', 'TIER1_REFUSED_BY_BUYER', 'DILUTION_WITHIN_CAPS', 'DILUTION_EXCEEDS_PER_DEAL_CAP', 'CAMPAIGN_BUDGET_EXHAUSTED', 'ROUND_LIMIT_REACHED', 'OFFER_ACCEPTED', 'OFFER_EXPIRED', 'OFFER_ALREADY_CONSUMED', 'BASKET_MISMATCH', 'BUYER_DECLINED', 'WALK_AWAY', 'HOLD_RESERVED', 'HOLD_RELEASED', 'HOLD_COMMITTED', 'AUTONOMOUS_PAYMENT_NOT_AUTHORIZED', 'ORDER_CREATED', 'PAYMENT_CAPTURED', 'PAYMENT_FAILED', 'RAIL_STATE_DIVERGENCE');--> statement-breakpoint
CREATE TYPE "public"."campaign_hold_state" AS ENUM('RESERVED', 'RELEASED', 'COMMITTED');--> statement-breakpoint
CREATE TYPE "public"."offer_status" AS ENUM('PENDING', 'ACCEPTED', 'EXPIRED', 'DECLINED', 'CONSUMED');--> statement-breakpoint
CREATE TYPE "public"."rail_state" AS ENUM('CREATED', 'AUTHORIZED', 'CAPTURED', 'FAILED');--> statement-breakpoint
CREATE TABLE "commitment_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"commitment_type" "commitment_type" NOT NULL,
	"value_minor" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"negotiation_enabled" boolean DEFAULT true NOT NULL,
	"campaign_budget_total_minor" integer NOT NULL,
	"per_deal_cap_minor" integer NOT NULL,
	"max_rounds" integer DEFAULT 3 NOT NULL,
	"concession_curve" jsonb NOT NULL,
	"offer_ttl_seconds" integer DEFAULT 600 NOT NULL,
	"slow_moving_tolerance" real DEFAULT 0.03 NOT NULL,
	"autonomous_payment_execution" boolean DEFAULT false NOT NULL,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(160) NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "sku_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"sku" varchar(64) NOT NULL,
	"name" varchar(160) NOT NULL,
	"list_price_minor" integer NOT NULL,
	"floor_price_minor" integer NOT NULL,
	"negotiable" boolean DEFAULT true NOT NULL,
	"slow_moving" boolean DEFAULT false NOT NULL,
	"affinity_group" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_ref" varchar(64) NOT NULL,
	"session_id" uuid NOT NULL,
	"round_index" integer NOT NULL,
	"move_type" "candidate_move_type" NOT NULL,
	"basket" jsonb NOT NULL,
	"total_minor" integer NOT NULL,
	"contribution_minor" integer NOT NULL,
	"contribution_delta_minor" integer NOT NULL,
	"tier" integer NOT NULL,
	"required_campaign_spend_minor" integer DEFAULT 0 NOT NULL,
	"clears_slow_moving" boolean DEFAULT false NOT NULL,
	"feasible" boolean NOT NULL,
	"infeasible_reason" "reason_code",
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "negotiation_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"buyer_agent_id" varchar(128) NOT NULL,
	"state" "negotiation_state" DEFAULT 'IDLE' NOT NULL,
	"round_index" integer DEFAULT 0 NOT NULL,
	"tier1_refused" boolean DEFAULT false NOT NULL,
	"policy_version" integer NOT NULL,
	"original_basket" jsonb NOT NULL,
	"counterfactual_contribution_minor" integer NOT NULL,
	"eligibility_signals" jsonb,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "campaign_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"amount_minor" integer NOT NULL,
	"state" "campaign_hold_state" DEFAULT 'RESERVED' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "campaign_holds_offer_id_unique" UNIQUE("offer_id")
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"candidate_ref" varchar(64) NOT NULL,
	"round_index" integer NOT NULL,
	"basket" jsonb NOT NULL,
	"total_minor" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'INR' NOT NULL,
	"tier" integer NOT NULL,
	"campaign_spend_minor" integer DEFAULT 0 NOT NULL,
	"policy_version" integer NOT NULL,
	"status" "offer_status" DEFAULT 'PENDING' NOT NULL,
	"reason_code" "reason_code" NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"engine_signature" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_id" uuid NOT NULL,
	"rail_order_id" varchar(64),
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'INR' NOT NULL,
	"local_state" "rail_state" DEFAULT 'CREATED' NOT NULL,
	"rail_state" "rail_state",
	"last_polled_at" timestamp,
	"rail_payload" jsonb,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp,
	CONSTRAINT "orders_offer_id_unique" UNIQUE("offer_id"),
	CONSTRAINT "orders_rail_order_id_unique" UNIQUE("rail_order_id")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" integer NOT NULL,
	"session_id" uuid NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"event_type" text NOT NULL,
	"from_state" "negotiation_state",
	"to_state" "negotiation_state" NOT NULL,
	"reason_code" "reason_code" NOT NULL,
	"payload" jsonb NOT NULL,
	"policy_version" integer,
	"offer_id" uuid,
	"campaign_hold_id" uuid,
	"campaign_spend_minor" integer,
	"model_explanation" text,
	"prev_hash" text,
	"event_hash" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commitment_values" ADD CONSTRAINT "commitment_values_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_policies" ADD CONSTRAINT "merchant_policies_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_policies" ADD CONSTRAINT "sku_policies_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_session_id_negotiation_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."negotiation_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "negotiation_sessions" ADD CONSTRAINT "negotiation_sessions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_holds" ADD CONSTRAINT "campaign_holds_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_holds" ADD CONSTRAINT "campaign_holds_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_session_id_negotiation_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."negotiation_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_session_id_negotiation_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."negotiation_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commitment_values_merchant_type_idx" ON "commitment_values" USING btree ("merchant_id","commitment_type");--> statement-breakpoint
CREATE UNIQUE INDEX "sku_policies_merchant_sku_idx" ON "sku_policies" USING btree ("merchant_id","sku");--> statement-breakpoint
CREATE UNIQUE INDEX "candidates_session_round_ref_idx" ON "candidates" USING btree ("session_id","round_index","candidate_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_session_sequence_idx" ON "audit_events" USING btree ("session_id","sequence");