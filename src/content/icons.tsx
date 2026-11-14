import type { VNode } from "preact"

const base = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" } as const

export const Sparkle = ({ size = 22 }: { size?: number }): VNode => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2.5c.4 3.9 1.3 5.9 2.7 7.2 1.4 1.4 3.4 2.2 6.8 2.6-3.4.4-5.4 1.3-6.8 2.6-1.4 1.4-2.3 3.4-2.7 7.1-.4-3.7-1.3-5.7-2.7-7.1-1.4-1.3-3.4-2.2-6.8-2.6 3.4-.4 5.4-1.2 6.8-2.6 1.4-1.3 2.3-3.3 2.7-7.2z" />
    <path d="M19 2c.15 1.3.45 2 .95 2.45.5.5 1.2.8 2.35.95-1.15.15-1.85.45-2.35.95-.5.45-.8 1.15-.95 2.45-.15-1.3-.45-2-.95-2.45-.5-.5-1.2-.8-2.35-.95 1.15-.15 1.85-.45 2.35-.95.5-.45.8-1.15.95-2.45z" opacity=".75" />
  </svg>
)
export const Close = (): VNode => <svg {...base}><path d="M18 6 6 18M6 6l12 12" /></svg>
export const Star = ({ size = 16 }: { size?: number }): VNode => (
  <svg {...base} width={size} height={size}><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" /></svg>
)
export const Gear = (): VNode => (
  <svg {...base}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
)
export const Plus = (): VNode => <svg {...base}><path d="M12 5v14M5 12h14" /></svg>
export const List = (): VNode => <svg {...base}><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" /></svg>
export const Clock = (): VNode => <svg {...base}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
// "Watching" (2.5 (77)): the eye is watching's everywhere, the bell reminders' (ux/MessageUx Bell).
export const Eye = ({ size = 18 }: { size?: number }): VNode => (
  <svg {...base} width={size} height={size}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>
)
export const ArrowUp = (): VNode => <svg {...base} stroke-width={2.4}><path d="M12 19V5M5 12l7-7 7 7" /></svg>
export const Stop = (): VNode => <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="3" /></svg>
export const Copy = (): VNode => <svg {...base} width={15} height={15}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
export const Share = (): VNode => <svg {...base} width={15} height={15}><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13" /></svg>
export const Retry = (): VNode => <svg {...base} width={15} height={15}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
export const Check = (): VNode => <svg {...base} width={15} height={15}><path d="M20 6 9 17l-5-5" /></svg>
// Points to the start side: mirrored right to left (.cf-flip).
export const Back = (): VNode => <svg {...base} class="cf-flip"><path d="M15 18l-6-6 6-6" /></svg>
// Two speech bubbles (2.5, the owner's pick "A"), like the app's bubble.left.and.text.bubble.right.
export const Chats = (): VNode => (
  <svg {...base}><path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z" /><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" /></svg>
)
export const Trash = (): VNode => (
  <svg {...base} width={16} height={16}><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" /></svg>
)
export const Pencil = (): VNode => (
  <svg {...base} width={16} height={16}><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z" /><path d="M14.5 5.5l3 3" /></svg>
)
export const Pin = ({ filled = false }: { filled?: boolean }): VNode => (
  <svg {...base} width={16} height={16} fill={filled ? "currentColor" : "none"}><path d="M9 3h6l-1 6 4 4v2H6v-2l4-4z" /><path d="M12 15v6" /></svg>
)
export const Grip = (): VNode => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
  </svg>
)
export const Doc = (): VNode => <svg {...base} width={14} height={14}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
export const Cursor = (): VNode => <svg {...base} width={14} height={14}><path d="M4 7V4h16v3M9 20h6M12 4v16" /></svg>
export const Lock = (): VNode => <svg {...base} width={14} height={14}><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
export const Search = ({ size = 15 }: { size?: number }): VNode => (
  <svg {...base} width={size} height={size}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" /></svg>
)
export const Play = ({ size = 14 }: { size?: number }): VNode => (
  <svg {...base} width={size} height={size}><rect x="2" y="4" width="20" height="16" rx="4" /><path d="m10 9 5 3-5 3z" fill="currentColor" /></svg>
)
export const Alert = (): VNode => <svg {...base} width={13} height={13}><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.5v.01" /></svg>
export const Tag = (): VNode => (
  <svg {...base} width={16} height={16}><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" /><circle cx="7.5" cy="7.5" r="1.5" fill="currentColor" /></svg>
)
export const Folder = (): VNode => (
  <svg {...base} width={13} height={13}><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
)
/** «Переместить в…» (2.7): a chat into another space. */
export const MoveTo = (): VNode => (
  <svg {...base} width={16} height={16}><rect x="3" y="4" width="13" height="13" rx="3" /><path d="M8 21h10a3 3 0 0 0 3-3V8" /><path d="M7 10.5h5.5M10.5 8l2.5 2.5-2.5 2.5" /></svg>
)
