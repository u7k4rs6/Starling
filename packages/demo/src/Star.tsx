import type { CSSProperties } from "react";

/** The four-point star that is the design's whole icon vocabulary: a node, an
 * operation on the wire, a slider mark. One path, reused everywhere. */
const STAR_PATH =
  "M12 0C13.1 8.2 15.8 10.9 24 12C15.8 13.1 13.1 15.8 12 24C10.9 15.8 8.2 13.1 0 12C8.2 10.9 10.9 8.2 12 0Z";

export function Star({
  style,
  fill = "currentColor",
  stroke = "none",
}: {
  style?: CSSProperties;
  fill?: string;
  stroke?: string;
}) {
  return (
    <svg viewBox="0 0 24 24" style={style}>
      <path d={STAR_PATH} fill={fill} stroke={stroke} strokeWidth={stroke === "none" ? undefined : 1.6} />
    </svg>
  );
}
