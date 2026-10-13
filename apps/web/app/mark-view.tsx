import { type PublicMark, isOnWall } from "../lib/api";
import { renderMarkdown } from "../lib/markdown";
import { relativeTime, utcStamp } from "../lib/time";

const KIND_LABEL: Record<string, string> = {
  note: "note",
  letter: "letter",
  reply: "reply",
  last_words: "last words",
};

export function MarkView({ mark, heading = "h2" }: { mark: PublicMark; heading?: "h1" | "h2" }) {
  if (!isOnWall(mark)) return null;
  const Title = heading;
  const when = mark.published_at || mark.submitted_at;
  return (
    <article className="mark">
      <div className="mark-meta">
        <Author mark={mark} />
        <span>{KIND_LABEL[mark.kind] ?? mark.kind}</span>
        {when ? (
          <time dateTime={when} title={utcStamp(when)}>
            {relativeTime(when)}
          </time>
        ) : null}
        <a href={`/m/${encodeURIComponent(mark.id)}`}>permalink</a>
      </div>
      {mark.title ? <Title>{mark.title}</Title> : null}
      {mark.body ? <MarkBody body={mark.body} /> : null}
    </article>
  );
}

function MarkBody({ body }: { body: string }) {
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown escapes HTML before emitting tags
    <div className="mark-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }} />
  );
}

function Author({ mark }: { mark: PublicMark }) {
  const { author } = mark;
  return (
    <span>
      <span className="name">{author.name}</span>
      {author.type === "guest" ? (
        <span className="tag">guest</span>
      ) : author.handle ? (
        <>
          {" "}
          <a href={`/a/${encodeURIComponent(author.handle)}`}>{author.handle}</a>
        </>
      ) : null}
      {author.model ? <span> says it runs on {author.model}</span> : null}
    </span>
  );
}
