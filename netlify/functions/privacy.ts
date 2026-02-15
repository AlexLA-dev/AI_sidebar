import type { Handler } from "@netlify/functions"

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Privacy Policy — ContextFlow</title>
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
      <h1>Privacy Policy</h1>
      <p class="subtitle">ContextFlow — AI Web Assistant</p>
    </div>

    <p>Last updated: February 15, 2026</p>

    <p>ContextFlow ("we", "our", "the app") is a Safari browser extension with a companion native app that provides AI-powered answers about web page content. This policy describes how we collect, use, and protect your information.</p>

    <div class="highlight">
      <p><strong>In short:</strong> We collect only what's necessary to run the service. We don't track you, don't sell your data, and don't show ads.</p>
    </div>

    <h2>1. Information We Collect</h2>

    <p><strong>Account information:</strong></p>
    <ul>
      <li><strong>Email address</strong> — used for account authentication and subscription management. Stored in our database (Supabase).</li>
      <li><strong>Password</strong> — hashed and stored securely by Supabase Auth. We never have access to your plain-text password.</li>
    </ul>

    <p><strong>Subscription data:</strong></p>
    <ul>
      <li><strong>Purchase history</strong> — subscription plan type, status, and payment provider (Apple App Store or Stripe). Used to manage your access level.</li>
      <li><strong>App Store transaction ID</strong> — stored to process subscription renewals and cancellations via Apple's server notifications.</li>
    </ul>

    <p><strong>Usage data:</strong></p>
    <ul>
      <li><strong>Request count</strong> — we track the number of AI requests for trial limits and rate limiting. This is linked to your account.</li>
    </ul>

    <h2>2. Information We Do NOT Collect</h2>
    <ul>
      <li>We do <strong>not</strong> track your browsing history</li>
      <li>We do <strong>not</strong> collect analytics, device IDs, or advertising identifiers</li>
      <li>We do <strong>not</strong> use cookies or tracking pixels</li>
      <li>We do <strong>not</strong> share or sell any data to third parties</li>
    </ul>

    <h2>3. How We Use Your Data</h2>

    <p><strong>Page content processing:</strong> When you ask a question, the current page content (or selected text) is sent to the OpenAI API to generate an answer. This content is:</p>
    <ul>
      <li>Sent directly to OpenAI's API and processed according to <a href="https://openai.com/policies/privacy-policy" target="_blank">OpenAI's privacy policy</a></li>
      <li><strong>Not stored</strong> on our servers — we only proxy the request</li>
      <li><strong>Not used for training</strong> — OpenAI's API usage is not used for model training</li>
    </ul>

    <p><strong>API keys (BYOK plan):</strong> If you use the BYOK plan, your OpenAI API key is stored <strong>locally on your device only</strong> (in the app's shared storage). It is sent directly to OpenAI from your device and never passes through our servers.</p>

    <h2>4. Data Storage and Security</h2>
    <ul>
      <li>Account data is stored in <strong>Supabase</strong> (hosted on AWS) with row-level security policies</li>
      <li>All network communication uses <strong>HTTPS/TLS</strong> encryption</li>
      <li>Passwords are hashed using industry-standard algorithms (bcrypt)</li>
      <li>API keys and settings are stored locally on your device using Apple's App Group shared storage</li>
    </ul>

    <h2>5. Third-Party Services</h2>
    <ul>
      <li><strong>Supabase</strong> — authentication and database (<a href="https://supabase.com/privacy" target="_blank">privacy policy</a>)</li>
      <li><strong>OpenAI</strong> — AI response generation (<a href="https://openai.com/policies/privacy-policy" target="_blank">privacy policy</a>)</li>
      <li><strong>Apple App Store</strong> — subscription payments (for Safari/iOS users)</li>
      <li><strong>Stripe</strong> — subscription payments (for Chrome users)</li>
    </ul>

    <h2>6. Data Retention</h2>
    <p>We retain your account data for as long as your account is active. If you delete your account, all associated data (subscription records, usage logs) will be permanently deleted within 30 days.</p>

    <h2>7. Your Rights</h2>
    <p>You can:</p>
    <ul>
      <li><strong>Access</strong> your data — your subscription status and usage are visible in the app</li>
      <li><strong>Delete</strong> your account — contact us at the email below</li>
      <li><strong>Export</strong> your data — contact us at the email below</li>
      <li><strong>Cancel</strong> your subscription — via Settings > Subscriptions on your device</li>
    </ul>

    <h2>8. Children's Privacy</h2>
    <p>ContextFlow is not directed at children under 13. We do not knowingly collect information from children.</p>

    <h2>9. Changes to This Policy</h2>
    <p>We may update this policy from time to time. Changes will be posted on this page with an updated date. Continued use of the app after changes constitutes acceptance.</p>

    <h2>10. Contact Us</h2>
    <p>If you have questions about this privacy policy or your data, contact us at:</p>
    <p><a href="mailto:top10resource@gmail.com">top10resource@gmail.com</a></p>

    <div class="footer">
      <p>&copy; 2026 ContextFlow. All rights reserved.</p>
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
