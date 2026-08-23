import React, { useState } from 'react';
import { ArrowRight, Eye, EyeOff, LoaderCircle, LockKeyhole, UserRound } from 'lucide-react';

type AdminLoginProps = {
  checking?: boolean;
  onAuthenticated: (user: string) => void;
};

export function AdminLogin({ checking = false, onAuthenticated }: AdminLoginProps) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Sign in failed');
      onAuthenticated(body.user || username);
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : String(loginError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="vc-login-shell">
      <div className="vc-login-image" aria-hidden="true" />
      <section className="vc-login-dialog" role="dialog" aria-modal="true" aria-labelledby="vc-login-title">
        <div className="vc-login-brand">
          <div className="vc-sq">M</div>
          <div className="vc-wm">MWU <span>Pipeline</span></div>
        </div>
        {checking ? (
          <div className="vc-login-checking" aria-live="polite">
            <LoaderCircle size={22} />
            <span>Checking secure session</span>
          </div>
        ) : (
          <>
            <div className="vc-login-heading">
              <span className="vc-section-k">Research workspace</span>
              <h1 id="vc-login-title">Sign in to continue</h1>
              <p>Access the multilogue processing workspace and its reviewable research artifacts.</p>
            </div>
            <form onSubmit={submit} className="vc-login-form">
              <label htmlFor="mwu-username">Username</label>
              <div className="vc-login-field">
                <UserRound size={17} />
                <input
                  id="mwu-username"
                  name="username"
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  required
                />
              </div>
              <label htmlFor="mwu-password">Password</label>
              <div className="vc-login-field">
                <LockKeyhole size={17} />
                <input
                  id="mwu-password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoFocus
                  required
                />
                <button type="button" className="vc-login-reveal" onClick={() => setShowPassword((value) => !value)} title={showPassword ? 'Hide password' : 'Show password'} aria-label={showPassword ? 'Hide password' : 'Show password'}>
                  {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
              {error && <p className="vc-login-error" role="alert">{error}</p>}
              <button type="submit" className="vc-login-submit" disabled={submitting || !username || !password}>
                {submitting ? <LoaderCircle className="vc-login-spinner" size={17} /> : <LockKeyhole size={17} />}
                {submitting ? 'Signing in' : 'Sign in'}
                {!submitting && <ArrowRight size={17} />}
              </button>
            </form>
            <p className="vc-login-footnote">Automatic outputs remain drafts until researcher review.</p>
          </>
        )}
      </section>
    </main>
  );
}
