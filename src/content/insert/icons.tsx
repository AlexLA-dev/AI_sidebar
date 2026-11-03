import type { VNode } from "preact"

const base = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" } as const

/** Quick insert: a line of text with the sparkle ("put text here"). */
export const Insert = ({ size = 17 }: { size?: number }): VNode => (
  <svg {...base} width={size} height={size} stroke-width={2.2}>
    <path d="M4 18h10M4 13h7" />
    <path fill="currentColor" stroke="none" d="M17.5 3c.3 2.6.9 3.9 1.8 4.8.9.9 2.2 1.5 4.5 1.7-2.3.3-3.6.9-4.5 1.8-.9.9-1.5 2.2-1.8 4.7-.3-2.5-.9-3.8-1.8-4.7-.9-.9-2.2-1.5-4.5-1.8 2.3-.2 3.6-.8 4.5-1.7.9-.9 1.5-2.2 1.8-4.8z" />
  </svg>
)

/** A template: a page with lines and a blank. */
export const Template = ({ size = 16 }: { size?: number }): VNode => (
  <svg {...base} width={size} height={size}>
    <rect x="4" y="3" width="16" height="18" rx="2" />
    <path d="M8 8h8M8 12h3M13 12h3M8 16h5" />
  </svg>
)

/** "Insert into the field": a text cursor. */
export const Cursor = ({ size = 15 }: { size?: number }): VNode => (
  <svg {...base} width={size} height={size}>
    <path d="M4 7V4h16v3M9 20h6M12 4v16" />
  </svg>
)

export const Pin = ({ size = 16 }: { size?: number }): VNode => (
  <svg {...base} width={size} height={size}>
    <path d="M9 3h6l-1 6 4 4v2H6v-2l4-4z" />
    <path d="M12 15v6" />
  </svg>
)
