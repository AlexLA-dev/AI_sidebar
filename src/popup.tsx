// Safari-compatible popup — renders the same sidebar UI.
// Safari doesn't support Chrome's sidePanel API, so it needs a popup entry point.
// On Chrome, clicking the icon will open this popup instead of the side panel;
// users can still open the side panel via the keyboard shortcut.
import "./style.css"

export { default } from "./sidepanel"
