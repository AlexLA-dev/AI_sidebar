import type { VNode } from "preact"

import type { Side } from "./snap"

/** The glow on the edge the dragged circle or panel will land on (2.7, plan section 9). */
export function EdgeGlow({ side }: { side: Side | null }): VNode | null {
  return side ? <div class={`cf-edge-glow ${side}`} aria-hidden="true" /> : null
}
