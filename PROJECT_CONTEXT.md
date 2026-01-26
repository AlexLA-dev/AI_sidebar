# Project: ContextFlow (Browser Extension)

## Core Value Proposition
A sidebar extension that reduces context switching by integrating LLM capabilities directly into the browser's DOM. It features a "Hybrid Mode":
1. **Local Mode (Green):** Runs on-device (WebLLM/Phi-3) for privacy and speed (grammar, simple rewrite).
2. **Cloud Mode (Orange):** Uses external API (GPT-4o/Claude) for complex reasoning.

## Architecture
- **Frontend:** Plasmo Framework (React).
- **Communication:**
  - `Content Script`: Reads DOM, handles highlighting and simple UI injection (floating buttons).
  - `Sidepanel`: The main chat interface.
  - `Background Service Worker`: Handles API calls to avoid CORS issues and manages context state.
- **Storage:**
  - `chrome.storage.local` (via Plasmo Storage) for chat history and settings.
  - `IndexedDB` for caching Local LLM weights (handled by WebLLM).

## Key Features (MVP)
1. **Smart Sidebar:** Opens via Cmd+E. Shows Chat UI.
2. **DOM Awareness:**
   - "Chat with Page": Read `document.body.innerText`, clean via Readability.js.
   - "Selection Context": If text is selected, the chat focuses on that snippet.
3. **Model Routing:** A switch in UI to toggle between Local (Free) and Cloud (Paid/BYOK).

## Monetization Model (Context for coding)
- **BYOK (Bring Your Own Key):** User enters OpenAI Key in settings. We must store this securely (local storage only, never send to our servers).
