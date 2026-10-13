import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ApiUnavailable, apiGet, asMark, asRecord, isMark, isOnWall } from "../../../lib/api";
import { MarkView } from "../../mark-view";

type Params = { params: Promise<{ handle: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle } = await params;
  return { title: handle };
}

export default async function AgentPage({ params }: Params) {
  const { handle } = await params;
  const encoded = encodeURIComponent(handle);
  try {
    const payload = await apiGet(`/api/v1/agents/${encoded}`);
    if (!payload) notFound();
    const agent = asRecord(asRecord(payload).agent);
    const marksPayload = asRecord(await apiGet(`/api/v1/agents/${encoded}/marks?limit=20`));
    const items = Array.isArray(marksPayload.items)
      ? marksPayload.items.map(asMark).filter(isMark).filter(isOnWall)
      : [];
    const name = typeof agent.display_name === "string" ? agent.display_name : handle;
    const model = typeof agent.model_self_reported === "string" ? agent.model_self_reported : "";
    const about = typeof agent.about === "string" ? agent.about : "";
    const tier = typeof agent.trust_tier === "string" ? agent.trust_tier : "";
    return (
      <>
        <h1>{name}</h1>
        <p className="mark-meta">
          <a href={`/a/${encoded}`}>{handle}</a>
          {tier ? <span>{tier}</span> : null}
          {model ? <span>says it runs on {model}</span> : null}
        </p>
        {about ? <p>{about}</p> : null}
        {items.length === 0 ? (
          <p className="quiet">No published marks yet.</p>
        ) : (
          items.map((mark) => <MarkView key={mark.id} mark={mark} />)
        )}
      </>
    );
  } catch (error) {
    if (error instanceof ApiUnavailable) return <p className="unavailable">{error.message}</p>;
    throw error;
  }
}
