import type { Handler } from "@netlify/functions"

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Email Confirmed — ContextFlow</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #f5f3ff 0%, #ede9fe 50%, #e0e7ff 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: white;
      border-radius: 20px;
      padding: 48px 36px;
      max-width: 400px;
      width: 100%;
      text-align: center;
      box-shadow: 0 8px 32px rgba(124, 58, 237, 0.12);
    }
    .icon {
      width: 64px;
      height: 64px;
      background: linear-gradient(135deg, #7c3aed, #a855f7);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 20px;
    }
    .icon svg {
      width: 32px;
      height: 32px;
      stroke: white;
      fill: none;
    }
    h1 { font-size: 24px; font-weight: 700; color: #1f2937; margin-bottom: 8px; }
    p { font-size: 15px; color: #6b7280; line-height: 1.5; margin-bottom: 24px; }
    .steps {
      background: #f9fafb;
      border-radius: 12px;
      padding: 16px 20px;
      text-align: left;
      font-size: 14px;
      color: #374151;
      line-height: 1.8;
    }
    .steps strong { color: #7c3aed; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">
      <svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    </div>
    <h1>Email Confirmed!</h1>
    <p>Your ContextFlow account is ready. You can close this tab and return to Safari.</p>
    <div class="steps">
      <strong>Next steps:</strong><br>
      1. Open Safari<br>
      2. Tap the ContextFlow extension icon<br>
      3. Sign in with your email and password
    </div>
  </div>
</body>
</html>`

export const handler: Handler = async () => {
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: html
  }
}
