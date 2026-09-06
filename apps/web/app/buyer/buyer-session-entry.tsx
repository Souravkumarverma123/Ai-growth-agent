"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Input } from "~/components/ui/input";

export function BuyerSessionEntry() {
  const router = useRouter();
  const [sessionId, setSessionId] = useState("");

  const trimmed = sessionId.trim();

  return (
    <Card>
      <CardContent>
        <form
          className="flex flex-col gap-3 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed) router.push(`/buyer/${encodeURIComponent(trimmed)}`);
          }}
        >
          <Input
            value={sessionId}
            onChange={(event) => setSessionId(event.target.value)}
            placeholder="negotiation session id"
            aria-label="Negotiation session id"
            className="font-mono"
          />
          <Button type="submit" disabled={!trimmed}>
            Open console
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
