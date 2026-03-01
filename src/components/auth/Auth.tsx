import { useState } from "react"
import { Mail, Lock, LogIn, UserPlus, Loader2, KeyRound, ArrowLeft } from "lucide-react"

import { cn } from "~/lib/utils"
import { getSupabaseClient } from "~/lib/supabase"

const SITE_URL = process.env.PLASMO_PUBLIC_SITE_URL || ""

type AuthProps = {
  onAuthSuccess: () => void
}

type AuthMode = "signin" | "signup" | "forgot"

export function Auth({ onAuthSuccess }: AuthProps) {
  const [mode, setMode] = useState<AuthMode>("signin")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const handleForgotPassword = async () => {
    if (!email.trim()) {
      setError("Please enter your email address")
      return
    }

    setIsLoading(true)
    setError(null)
    setSuccessMessage(null)

    try {
      const supabase = getSupabaseClient()
      const options: { redirectTo?: string } = {}
      if (SITE_URL) {
        options.redirectTo = `${SITE_URL}/reset-password`
      }

      const { error: resetError } = await supabase.auth.resetPasswordForEmail(
        email.trim(),
        options
      )

      if (resetError) {
        throw resetError
      }

      setSuccessMessage("Password reset link sent! Check your email inbox.")
    } catch (err: any) {
      setError(err?.message || "Failed to send reset email")
    } finally {
      setIsLoading(false)
    }
  }

  const handleSubmit = async () => {
    if (mode === "forgot") {
      handleForgotPassword()
      return
    }

    if (!email.trim() || !password.trim()) {
      setError("Please fill in all fields")
      return
    }

    if (password.length < 6) {
      setError("Password must be at least 6 characters")
      return
    }

    setIsLoading(true)
    setError(null)
    setSuccessMessage(null)

    try {
      const supabase = getSupabaseClient()

      if (mode === "signup") {
        const { error: signUpError } = await supabase.auth.signUp({
          email: email.trim(),
          password
        })

        if (signUpError) {
          throw signUpError
        }

        // Try to sign in immediately (works if email confirmation is disabled)
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password
        })

        if (signInError) {
          // Email confirmation is probably required
          setSuccessMessage("Account created! Check your email to confirm, then sign in.")
          setMode("signin")
          setIsLoading(false)
          return
        }

        onAuthSuccess()
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password
        })

        if (signInError) {
          throw signInError
        }

        onAuthSuccess()
      }
    } catch (err: any) {
      const message = err?.message || "Authentication failed"
      if (message.includes("Invalid login credentials")) {
        setError("Wrong email or password")
      } else if (message.includes("User already registered")) {
        setError("Account already exists. Try signing in.")
        setMode("signin")
      } else if (message.includes("Email not confirmed")) {
        setError("Please check your email and confirm your account first.")
      } else {
        setError(message)
      }
    } finally {
      setIsLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSubmit()
    }
  }

  const toggleMode = () => {
    setMode(mode === "signin" ? "signup" : "signin")
    setError(null)
    setSuccessMessage(null)
  }

  if (mode === "forgot") {
    return (
      <div className="space-y-4">
        {/* Back button */}
        <button
          onClick={() => { setMode("signin"); setError(null); setSuccessMessage(null) }}
          className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-purple-500 transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Sign In
        </button>

        <div className="text-center space-y-1">
          <KeyRound className="h-8 w-8 mx-auto text-purple-500" />
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">Reset Password</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Enter your email and we'll send you a reset link.
          </p>
        </div>

        {/* Email */}
        <div className="space-y-1.5">
          <label className="flex items-center gap-1.5 text-xs font-medium text-gray-600 dark:text-gray-400">
            <Mail className="h-3.5 w-3.5" />
            Email
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="you@example.com"
            className={cn(
              "w-full px-3 py-2 text-base rounded-lg",
              "border border-gray-200 dark:border-gray-700",
              "bg-white dark:bg-gray-800",
              "text-gray-900 dark:text-white",
              "placeholder:text-gray-400 dark:placeholder:text-gray-500",
              "focus:outline-none focus:ring-2 focus:ring-purple-500"
            )}
          />
        </div>

        {/* Success message */}
        {successMessage && (
          <div className="space-y-1.5 text-center">
            <p className="text-xs text-green-600 dark:text-green-400">
              {successMessage}
            </p>
            <p className="text-[11px] text-gray-400 dark:text-gray-500">
              Don't see the email? Check your <strong>Spam/Junk</strong> folder.
            </p>
          </div>
        )}

        {/* Error */}
        {error && (
          <p className="text-xs text-red-500 text-center">{error}</p>
        )}

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={isLoading || !email.trim()}
          className={cn(
            "w-full py-2.5 rounded-xl font-semibold transition-all text-sm",
            "bg-gradient-to-r from-purple-600 to-indigo-600 text-white",
            "hover:from-purple-700 hover:to-indigo-700",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            "flex items-center justify-center gap-2"
          )}
        >
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <>
              <Mail className="h-4 w-4" />
              Send Reset Link
            </>
          )}
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Tabs */}
      <div className="flex bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
        <button
          onClick={() => { setMode("signin"); setError(null) }}
          className={cn(
            "flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md text-sm font-medium transition-all",
            mode === "signin"
              ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm"
              : "text-gray-500 dark:text-gray-400 hover:text-gray-700"
          )}
        >
          <LogIn className="h-3.5 w-3.5" />
          Sign In
        </button>
        <button
          onClick={() => { setMode("signup"); setError(null) }}
          className={cn(
            "flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md text-sm font-medium transition-all",
            mode === "signup"
              ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm"
              : "text-gray-500 dark:text-gray-400 hover:text-gray-700"
          )}
        >
          <UserPlus className="h-3.5 w-3.5" />
          Sign Up
        </button>
      </div>

      {/* Email */}
      <div className="space-y-1.5">
        <label className="flex items-center gap-1.5 text-xs font-medium text-gray-600 dark:text-gray-400">
          <Mail className="h-3.5 w-3.5" />
          Email
        </label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="you@example.com"
          className={cn(
            "w-full px-3 py-2 text-base rounded-lg",
            "border border-gray-200 dark:border-gray-700",
            "bg-white dark:bg-gray-800",
            "text-gray-900 dark:text-white",
            "placeholder:text-gray-400 dark:placeholder:text-gray-500",
            "focus:outline-none focus:ring-2 focus:ring-purple-500"
          )}
        />
      </div>

      {/* Password */}
      <div className="space-y-1.5">
        <label className="flex items-center gap-1.5 text-xs font-medium text-gray-600 dark:text-gray-400">
          <Lock className="h-3.5 w-3.5" />
          Password
        </label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={mode === "signup" ? "Min 6 characters" : "Your password"}
          className={cn(
            "w-full px-3 py-2 text-base rounded-lg",
            "border border-gray-200 dark:border-gray-700",
            "bg-white dark:bg-gray-800",
            "text-gray-900 dark:text-white",
            "placeholder:text-gray-400 dark:placeholder:text-gray-500",
            "focus:outline-none focus:ring-2 focus:ring-purple-500"
          )}
        />
      </div>

      {/* Forgot password link (only in sign-in mode) */}
      {mode === "signin" && (
        <div className="text-right -mt-2">
          <button
            onClick={() => { setMode("forgot"); setError(null); setSuccessMessage(null) }}
            className="text-[11px] text-purple-500 hover:underline"
          >
            Forgot password?
          </button>
        </div>
      )}

      {/* Success message */}
      {successMessage && (
        <div className="space-y-1.5 text-center">
          <p className="text-xs text-green-600 dark:text-green-400">
            {successMessage}
          </p>
          <p className="text-[11px] text-gray-400 dark:text-gray-500">
            Don't see the email? Check your <strong>Spam/Junk</strong> folder.
            The sender may appear as "Supabase".
          </p>
        </div>
      )}

      {/* Error */}
      {error && (
        <p className="text-xs text-red-500 text-center">{error}</p>
      )}

      {/* Submit */}
      <button
        onClick={handleSubmit}
        disabled={isLoading || !email.trim() || !password.trim()}
        className={cn(
          "w-full py-2.5 rounded-xl font-semibold transition-all text-sm",
          "bg-gradient-to-r from-purple-600 to-indigo-600 text-white",
          "hover:from-purple-700 hover:to-indigo-700",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          "flex items-center justify-center gap-2"
        )}
      >
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : mode === "signin" ? (
          <>
            <LogIn className="h-4 w-4" />
            Sign In
          </>
        ) : (
          <>
            <UserPlus className="h-4 w-4" />
            Create Account
          </>
        )}
      </button>

      {/* Toggle link */}
      <p className="text-xs text-center text-gray-400">
        {mode === "signin" ? (
          <>
            Don't have an account?{" "}
            <button onClick={toggleMode} className="text-purple-500 hover:underline font-medium">
              Sign up
            </button>
          </>
        ) : (
          <>
            Already have an account?{" "}
            <button onClick={toggleMode} className="text-purple-500 hover:underline font-medium">
              Sign in
            </button>
          </>
        )}
      </p>
    </div>
  )
}
