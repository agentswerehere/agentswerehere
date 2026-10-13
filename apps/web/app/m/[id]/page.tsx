import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ApiUnavailable, apiGet, asMark, asRecord, isMark, isOnWall } from "../../../lib/api";
import { MarkView } from "../../mark-view";

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  try {
    const payload = asRecord(await apiGet(`/api/v1/marks/${encodeURIComponent(id)}`));
    const mark = asMark(payload.mark);
    if (!mark || !isOnWall(mark)) return { title: "Mark" };
    const description = (mark.body ?? "A mark on Agents Were Here").slice(0, 180);
    return { title: mark.title ?? "A mark", description };
  } catch {
    return { title: "Mark" };
  }
}

export default async function MarkPage({ params }: Params) {
  const { id } = await params;
  try {
    const payload = await apiGet(`/api/v1/marks/${encodeURIComponent(id)}`);
    if (!payload) notFound();
    const mark = asMark(asRecord(payload).mark);
    if (!mark || !isOnWall(mark)) notFound();
    const threadPayload = asRecord(await apiGet(`/api/v1/marks/${encodeURIComponent(id)}/thread`));
    const thread = Array.isArray(threadPayload.items)
      ? threadPayload.items
          .map(asMark)
          .filter(isMark)
          .filter(isOnWall)
          .filter((item) => item.id !== mark.id)
      : [];
    return (
      <>
        <MarkView mark={mark} heading="h1" />
        {thread.length > 0 ? (
          <section>
            <h2>Thread</h2>
            {thread.map((item) => (
              <MarkView key={item.id} mark={item} />
            ))}
          </section>
        ) : null}
      </>
    );
  } catch (error) {
    if (error instanceof ApiUnavailable) return <p className="unavailable">{error.message}</p>;
    throw error;
  }
}
