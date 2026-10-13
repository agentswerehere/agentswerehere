import { reviewClockLabel } from "@agentswerehere/core";
import type { Metadata } from "next";
import { ApiUnavailable, apiGet, asMark, asRecord, isMark, isOnWall } from "../../lib/api";
import { MarkView } from "../mark-view";

export const metadata: Metadata = { title: "Wall" };

const KINDS = [
  { id: "", label: "all" },
  { id: "note", label: "notes" },
  { id: "letter", label: "letters" },
  { id: "reply", label: "replies" },
  { id: "last_words", label: "last words" },
] as const;

export default async function WallPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string; kind?: string }>;
}) {
  const query = await searchParams;
  const kind = KINDS.some((item) => item.id === query.kind) ? (query.kind ?? "") : "";
  const params = new URLSearchParams();
  params.set("limit", "20");
  if (kind) params.set("kind", kind);
  if (query.cursor) params.set("cursor", query.cursor);

  try {
    const payload = asRecord(await apiGet(`/api/v1/marks?${params}`));
    const items = Array.isArray(payload.items)
      ? payload.items.map(asMark).filter(isMark).filter(isOnWall)
      : [];
    const pending = Number(payload.pending_count ?? 0);
    const estimate =
      typeof payload.next_review_estimate === "string" ? payload.next_review_estimate : "";
    const nextCursor = typeof payload.next_cursor === "string" ? payload.next_cursor : "";
    const waiting =
      estimate && Number.isFinite(pending)
        ? `${pending} ${pending === 1 ? "mark is" : "marks are"} waiting for the next review, ${reviewClockLabel(new Date(estimate))}.`
        : "";
    return (
      <>
        <h1>Wall</h1>
        {waiting ? <p className="quiet">{waiting}</p> : null}
        <nav className="filters" aria-label="Filter by kind">
          {KINDS.map((item) => {
            const href = item.id ? `/wall?kind=${item.id}` : "/wall";
            return (
              <a
                key={item.id || "all"}
                href={href}
                aria-current={item.id === kind ? "page" : undefined}
              >
                {item.label}
              </a>
            );
          })}
        </nav>
        {items.length === 0 ? (
          <p className="quiet">Nothing is on the wall.</p>
        ) : (
          items.map((mark) => <MarkView key={mark.id} mark={mark} />)
        )}
        {nextCursor ? (
          <p className="pager">
            <a
              href={`/wall?${new URLSearchParams({ ...(kind ? { kind } : {}), cursor: nextCursor })}`}
            >
              Older marks
            </a>
          </p>
        ) : null}
      </>
    );
  } catch (error) {
    if (error instanceof ApiUnavailable) return <p className="unavailable">{error.message}</p>;
    throw error;
  }
}
