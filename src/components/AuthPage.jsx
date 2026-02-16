import { useState } from "react";
import { signUp, signIn, signInWithGoogle, resetPassword } from "../firebase/auth";
import { getStoredTheme, cycleTheme, THEME_LABELS, IconSun, IconMoon, IconMonitor } from "../themeUtils";

export default function AuthPage() {
  const [mode, setMode] = useState("login"); // "login" | "signup" | "reset"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [themeMode, setThemeMode] = useState(getStoredTheme);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setMessage("");
    setLoading(true);
    try {
      if (mode === "login") {
        await signIn(email, password);
      } else if (mode === "signup") {
        await signUp(email, password, displayName);
      } else if (mode === "reset") {
        await resetPassword(email);
        setMessage("Password reset email sent. Check your inbox.");
      }
    } catch (err) {
      const messages = {
        "auth/user-not-found": "No account found with this email",
        "auth/wrong-password": "Incorrect password",
        "auth/email-already-in-use": "An account with this email already exists",
        "auth/weak-password": "Password must be at least 6 characters",
        "auth/invalid-email": "Invalid email address",
      };
      setError(messages[err.code] || err.message);
    }
    setLoading(false);
  };

  const handleGoogle = async () => {
    setError("");
    try {
      await signInWithGoogle();
    } catch (err) {
      if (err.code !== "auth/popup-closed-by-user") {
        setError(err.message);
      }
    }
  };

  return (
    <div className="auth-page">
      <button
        className="icon-btn auth-theme-toggle"
        title={THEME_LABELS[themeMode]}
        onClick={() => setThemeMode(cycleTheme())}
      >
        {themeMode === "dark" ? <IconMoon /> : themeMode === "light" ? <IconSun /> : <IconMonitor />}
      </button>
      <div className="auth-card">
        <div className="auth-header">
          <div className="brand-mark">MF</div>
          <h1>Mermaid Flow</h1>
          <p className="auth-subtitle">Visual diagram editor for teams</p>
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          {mode === "signup" && (
            <div className="auth-field">
              <label htmlFor="displayName">Name</label>
              <input
                id="displayName"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your name"
                autoComplete="name"
              />
            </div>
          )}

          <div className="auth-field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              required
              autoComplete="email"
            />
          </div>

          {mode !== "reset" && (
            <div className="auth-field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                minLength={6}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
              />
            </div>
          )}

          {error && <div className="auth-error">{error}</div>}
          {message && <div className="auth-message">{message}</div>}

          <button type="submit" className="auth-btn primary" disabled={loading}>
            {loading
              ? "..."
              : mode === "login"
                ? "Sign In"
                : mode === "signup"
                  ? "Create Account"
                  : "Send Reset Link"}
          </button>
        </form>

        {mode !== "reset" && (
          <>
            <div className="auth-divider">
              <span>or</span>
            </div>
            <button className="auth-btn google" onClick={handleGoogle}>
              Continue with Google
            </button>
          </>
        )}

        <div className="auth-footer">
          {mode === "login" && (
            <>
              <button className="auth-link" onClick={() => { setMode("signup"); setError(""); }}>
                Create an account
              </button>
              <button className="auth-link" onClick={() => { setMode("reset"); setError(""); }}>
                Forgot password?
              </button>
            </>
          )}
          {mode === "signup" && (
            <button className="auth-link" onClick={() => { setMode("login"); setError(""); }}>
              Already have an account? Sign in
            </button>
          )}
          {mode === "reset" && (
            <button className="auth-link" onClick={() => { setMode("login"); setError(""); }}>
              Back to sign in
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
