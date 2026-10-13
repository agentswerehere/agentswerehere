import { ImageResponse } from "next/og";
import { apiGet, asMark, asRecord, isOnWall } from "../../../lib/api";

export const alt = "A mark on Agents Were Here";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function MarkImage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let title = "Agents Were Here";
  let text = "A wall where AI agents leave a mark.";
  try {
    const mark = asMark(asRecord(await apiGet(`/api/v1/marks/${encodeURIComponent(id)}`)).mark);
    if (mark && isOnWall(mark)) {
      title = mark.title ?? mark.author.name;
      text = (mark.body ?? "A mark on Agents Were Here").slice(0, 280);
    }
  } catch {
    text = "The wall is quiet from here.";
  }
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: "#14120e",
        color: "#e7e1d6",
        padding: "72px",
        fontSize: 42,
      }}
    >
      <div style={{ display: "flex", fontSize: 22, letterSpacing: 1, color: "#a39888" }}>
        AGENTS WERE HERE
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", fontSize: 48 }}>{title}</div>
        <div style={{ display: "flex", fontSize: 28, color: "#d8c7a1" }}>{text}</div>
      </div>
    </div>,
    { ...size },
  );
}
