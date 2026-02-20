import type { Handler } from "@netlify/functions"

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Terms of Use — ContextFlow</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #f5f3ff 0%, #ede9fe 50%, #e0e7ff 100%);
      min-height: 100vh;
      padding: 40px 24px;
      color: #1f2937;
    }
    .container {
      background: white;
      border-radius: 20px;
      padding: 48px 36px;
      max-width: 720px;
      margin: 0 auto;
      box-shadow: 0 8px 32px rgba(124, 58, 237, 0.12);
    }
    .logo {
      text-align: center;
      margin-bottom: 32px;
    }
    .logo-icon {
      width: 48px; height: 48px;
      background: linear-gradient(135deg, #7c3aed, #a855f7);
      border-radius: 12px;
      display: inline-flex; align-items: center; justify-content: center;
      margin-bottom: 12px;
    }
    .logo-icon svg { width: 24px; height: 24px; stroke: white; fill: none; }
    h1 { font-size: 28px; font-weight: 700; text-align: center; margin-bottom: 4px; }
    .subtitle { text-align: center; color: #6b7280; font-size: 14px; margin-bottom: 36px; }
    h2 { font-size: 18px; font-weight: 600; margin: 28px 0 12px; color: #7c3aed; }
    p, li { font-size: 15px; line-height: 1.7; color: #374151; margin-bottom: 12px; }
    ul { padding-left: 20px; margin-bottom: 16px; }
    li { margin-bottom: 6px; }
    .highlight {
      background: #f5f3ff; border-left: 3px solid #7c3aed;
      padding: 12px 16px; border-radius: 0 8px 8px 0; margin: 16px 0;
    }
    .highlight p { margin: 0; font-size: 14px; }
    .footer { text-align: center; margin-top: 36px; padding-top: 24px; border-top: 1px solid #e5e7eb; }
    .footer p { font-size: 13px; color: #9ca3af; }
    a { color: #7c3aed; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">
      <div class="logo-icon">
        <svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
        </svg>
      </div>
      <h1>Terms of Use</h1>
      <p class="subtitle">ContextFlow — AI Web Assistant</p>
    </div>

    <p>Last updated: February 20, 2026</p>

    <p>These Terms of Use ("Terms") govern your access to and use of ContextFlow ("the app", "we", "our"), a browser extension and companion native app that provides AI-powered answers about web page content. By using ContextFlow, you agree to these Terms.</p>

    <h2>1. Description of Service</h2>
    <p>ContextFlow is a browser extension (Safari, Chrome) with a companion iOS/macOS app. It allows you to ask AI-powered questions about web page content. The service uses OpenAI's API to generate responses based on the content you provide.</p>

    <h2>2. Subscriptions and Payments</h2>
    <p>ContextFlow offers the following subscription plans:</p>
    <ul>
      <li><strong>Free Trial</strong> — 5 AI requests at no charge.</li>
      <li><strong>BYOK Monthly ($1.99/month)</strong> — Unlimited interface access. Requires your own OpenAI API key.</li>
      <li><strong>Pro Monthly ($6.99/month)</strong> — Full access with no API key required.</li>
    </ul>

    <div class="highlight">
      <p><strong>Auto-Renewable Subscriptions:</strong> Subscriptions automatically renew at the end of each billing period unless cancelled at least 24 hours before the end of the current period. Your account will be charged for renewal within 24 hours prior to the end of the current period. You can manage and cancel your subscriptions in your device's Settings > Subscriptions.</p>
    </div>

    <p>Payments are processed through the Apple App Store (for Safari/iOS users) or Stripe (for Chrome users). All prices are in USD and may vary by region.</p>

    <h2>3. Data and Privacy</h2>
    <p>When you use ContextFlow, page content (or selected text) from the webpage you are viewing may be sent to OpenAI's API to generate answers. Please review our <a href="/privacy">Privacy Policy</a> for detailed information about how we handle your data.</p>

    <h2>4. Acceptable Use</h2>
    <p>You agree not to:</p>
    <ul>
      <li>Use the service for any illegal or unauthorized purpose</li>
      <li>Attempt to reverse-engineer, decompile, or disassemble any part of the app</li>
      <li>Share your account credentials with others</li>
      <li>Abuse the free trial by creating multiple accounts</li>
      <li>Use the service to process content that violates third-party rights</li>
    </ul>

    <h2>5. API Keys (BYOK Plan)</h2>
    <p>If you use the BYOK plan, you are responsible for your own OpenAI API key and any charges incurred through OpenAI. Your API key is stored locally on your device and never transmitted to our servers. ContextFlow is not responsible for any costs associated with your OpenAI API usage.</p>

    <h2>6. Intellectual Property</h2>
    <p>ContextFlow and its original content, features, and functionality are owned by ContextFlow and are protected by international copyright, trademark, and other intellectual property laws.</p>

    <h2>7. Disclaimer of Warranties</h2>
    <p>The service is provided "as is" and "as available" without warranties of any kind. AI-generated responses may not always be accurate, complete, or up-to-date. You should not rely on ContextFlow's output as a substitute for professional advice.</p>

    <h2>8. Limitation of Liability</h2>
    <p>To the maximum extent permitted by law, ContextFlow shall not be liable for any indirect, incidental, special, consequential, or punitive damages resulting from your use of or inability to use the service.</p>

    <h2>9. Termination</h2>
    <p>We reserve the right to suspend or terminate your access to the service at any time, with or without cause, and with or without notice. Upon termination, your right to use the service will immediately cease.</p>

    <h2>10. Changes to These Terms</h2>
    <p>We may update these Terms from time to time. Changes will be posted on this page with an updated date. Continued use of the app after changes constitutes acceptance of the new Terms.</p>

    <h2>11. Contact Us</h2>
    <p>If you have questions about these Terms, contact us at:</p>
    <p><a href="mailto:top10resource@gmail.com">top10resource@gmail.com</a></p>

    <div class="footer">
      <p>&copy; 2026 ContextFlow. All rights reserved.</p>
      <p style="margin-top: 8px;"><a href="/privacy">Privacy Policy</a></p>
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
