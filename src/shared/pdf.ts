// Shared by the content script (PDFs on a page) and the background (a tab showing a PDF).

/** True when the address looks like a PDF file. */
export function isPdfUrl(href: string): boolean {
  try {
    const url = new URL(href)
    return /^https?:$/.test(url.protocol) && /\.pdf$/i.test(decodeURIComponent(url.pathname))
  } catch {
    return false
  }
}

// A PDF the page itself fetches (with the site's sign-in cookies) to hand to the app extension.
export const MAX_FORWARD_BYTES = 8 * 1024 * 1024

/** True when the bytes start like a PDF ("%PDF" within the first KB). */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).includes("%PDF")
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}
