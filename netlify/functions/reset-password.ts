import type { Handler } from "@netlify/functions"

const SUPABASE_URL = process.env.SUPABASE_URL || ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || ""

const html = (supabaseUrl: string, supabaseKey: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Password — ContextFlow</title>
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
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
      width: 64px; height: 64px;
      background: linear-gradient(135deg, #7c3aed, #a855f7);
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 20px;
    }
    .icon svg { width: 32px; height: 32px; stroke: white; fill: none; }
    h1 { font-size: 24px; font-weight: 700; color: #1f2937; margin-bottom: 8px; }
    .subtitle { font-size: 14px; color: #6b7280; margin-bottom: 24px; }
    .form-group { margin-bottom: 16px; text-align: left; }
    .form-group label {
      display: block; font-size: 13px; font-weight: 500;
      color: #374151; margin-bottom: 6px;
    }
    .form-group input {
      width: 100%; padding: 10px 14px; font-size: 15px;
      border: 1px solid #d1d5db; border-radius: 10px;
      outline: none; transition: border-color 0.2s;
    }
    .form-group input:focus { border-color: #7c3aed; box-shadow: 0 0 0 3px rgba(124, 58, 237, 0.1); }
    .btn {
      width: 100%; padding: 12px; font-size: 15px; font-weight: 600;
      color: white; border: none; border-radius: 12px; cursor: pointer;
      background: linear-gradient(135deg, #7c3aed, #6366f1);
      transition: opacity 0.2s;
    }
    .btn:hover { opacity: 0.9; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .error { color: #ef4444; font-size: 13px; margin-bottom: 16px; }
    .success { color: #059669; font-size: 14px; line-height: 1.5; }
    .hint { font-size: 13px; color: #9ca3af; margin-top: 8px; }
    .steps {
      background: #f9fafb; border-radius: 12px;
      padding: 16px 20px; text-align: left;
      font-size: 14px; color: #374151; line-height: 1.8;
      margin-top: 16px;
    }
    .steps strong { color: #7c3aed; }
    .hidden { display: none; }
    .spinner {
      display: inline-block; width: 18px; height: 18px;
      border: 2px solid rgba(255,255,255,0.3);
      border-top-color: white; border-radius: 50%;
      animation: spin 0.6s linear infinite;
      vertical-align: middle; margin-right: 6px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">
      <svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
      </svg>
    </div>

    <!-- Loading state -->
    <div id="loading">
      <h1>Setting up...</h1>
      <p class="subtitle">Please wait while we verify your reset link.</p>
    </div>

    <!-- Invalid link state -->
    <div id="invalid" class="hidden">
      <h1>Invalid Link</h1>
      <p class="subtitle">This password reset link is invalid or has expired. Please request a new one from the extension.</p>
    </div>

    <!-- Form state -->
    <div id="form" class="hidden">
      <h1>Set New Password</h1>
      <p class="subtitle">Enter your new password below.</p>
      <div id="error" class="error hidden"></div>
      <div class="form-group">
        <label for="password">New Password</label>
        <input type="password" id="password" placeholder="Min 6 characters" />
      </div>
      <div class="form-group">
        <label for="confirm">Confirm Password</label>
        <input type="password" id="confirm" placeholder="Repeat password" />
      </div>
      <button class="btn" id="submit" onclick="resetPassword()">Update Password</button>
      <p class="hint">Password must be at least 6 characters.</p>
    </div>

    <!-- Success state -->
    <div id="success" class="hidden">
      <h1>Password Updated!</h1>
      <p class="success">Your password has been changed successfully.</p>
      <div class="steps">
        <strong>Next steps:</strong><br>
        1. Open the ContextFlow extension<br>
        2. Sign in with your new password
      </div>
    </div>
  </div>

  <script>
    const SUPABASE_URL = "${supabaseUrl}";
    const SUPABASE_KEY = "${supabaseKey}";
    let supabaseClient = null;

    function show(id) {
      ["loading", "invalid", "form", "success"].forEach(function(s) {
        document.getElementById(s).classList.add("hidden");
      });
      document.getElementById(id).classList.remove("hidden");
    }

    function showError(msg) {
      var el = document.getElementById("error");
      el.textContent = msg;
      el.classList.remove("hidden");
    }

    async function init() {
      if (!SUPABASE_URL || !SUPABASE_KEY) {
        show("invalid");
        return;
      }

      supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

      // Supabase sends tokens in the URL hash after redirect
      var hash = window.location.hash;
      if (!hash || !hash.includes("access_token")) {
        show("invalid");
        return;
      }

      // Parse hash parameters
      var params = {};
      hash.substring(1).split("&").forEach(function(part) {
        var kv = part.split("=");
        params[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || "");
      });

      if (params.type !== "recovery" || !params.access_token) {
        show("invalid");
        return;
      }

      // Set the session from the recovery token
      var result = await supabaseClient.auth.setSession({
        access_token: params.access_token,
        refresh_token: params.refresh_token || ""
      });

      if (result.error) {
        show("invalid");
        return;
      }

      show("form");
      document.getElementById("password").focus();
    }

    // Allow Enter key to submit
    document.addEventListener("keydown", function(e) {
      if (e.key === "Enter" && !document.getElementById("form").classList.contains("hidden")) {
        resetPassword();
      }
    });

    async function resetPassword() {
      var pw = document.getElementById("password").value;
      var confirm = document.getElementById("confirm").value;
      var btn = document.getElementById("submit");

      document.getElementById("error").classList.add("hidden");

      if (!pw || pw.length < 6) {
        showError("Password must be at least 6 characters.");
        return;
      }
      if (pw !== confirm) {
        showError("Passwords do not match.");
        return;
      }

      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>Updating...';

      var result = await supabaseClient.auth.updateUser({ password: pw });

      if (result.error) {
        showError(result.error.message || "Failed to update password. Please try again.");
        btn.disabled = false;
        btn.textContent = "Update Password";
        return;
      }

      // Sign out so the session is not lingering in the browser
      await supabaseClient.auth.signOut();
      show("success");
    }

    init();
  </script>
</body>
</html>`

export const handler: Handler = async () => {
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: html(SUPABASE_URL, SUPABASE_ANON_KEY)
  }
}
