import React from "react";

interface State {
  error: Error | null;
}

/** The two keys App.tsx reopens on launch (the main screen and the split pane's). */
const STORED_SCREEN_KEYS = ["clienthub_last_tab", "clienthub_split_tab"];

/** Reload for the root fallback. The app reopens its last screen on launch, so reloading with the
 *  stored screen left in place reopens the screen that just crashed, forever. Forget both screens
 *  first (layout settings stay) and open on the Dashboard. A blocked store must not stop the reload. */
function reloadFromDashboard() {
  try {
    for (const key of STORED_SCREEN_KEYS) localStorage.removeItem(key);
  } catch {
    // Nothing stored that we can reach; reloading is still the way out.
  }
  window.location.reload();
}

/** Catches render-time exceptions so one bad component shows a recoverable message
 *  instead of unmounting the whole tree to a blank white screen (the only recovery
 *  used to be killing and relaunching the app). Inline styles so the fallback still
 *  renders even if the failure is CSS/theme related. */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Surface it in the console/devtools rather than swallowing it.
    console.error("Unhandled UI error:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0D0A09",
          color: "#F3EEE8",
          fontFamily:
            "'Satoshi',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
          padding: "24px",
        }}
      >
        <div style={{ maxWidth: 440, textAlign: "center" }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              margin: "0 auto 18px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(255,101,32,0.14)",
              border: "1px solid rgba(255,101,32,0.3)",
              color: "#FF6520",
              fontSize: 22,
              fontWeight: 800,
            }}
          >
            !
          </div>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 8px", letterSpacing: "-0.01em" }}>
            Something went wrong
          </h1>
          <p style={{ fontSize: 14, lineHeight: 1.5, color: "#B9AEA3", margin: "0 0 20px" }}>
            The screen hit an unexpected error. Your data is safe, and reloading usually
            fixes it.
          </p>
          <button
            onClick={reloadFromDashboard}
            style={{
              background: "#FF6520",
              color: "#fff",
              border: "none",
              borderRadius: 11,
              height: 44,
              padding: "0 22px",
              fontSize: 14.5,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Reload
          </button>
          {this.state.error?.message && (
            <pre
              style={{
                marginTop: 22,
                fontSize: 11.5,
                color: "#8A7F74",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                textAlign: "left",
                maxHeight: 120,
                overflow: "auto",
              }}
            >
              {this.state.error.message}
            </pre>
          )}
        </div>
      </div>
    );
  }
}

/** One boundary per screen (R-511 DG-01). A render error in a screen stops at its pane: the sidebar,
 *  the bell and every other screen keep working, and the person can go somewhere else. App.tsx keys it
 *  on the screen id, so opening another screen mounts a fresh boundary and clears the error. It draws
 *  nothing around its children while healthy, so the layout is the same with or without it. */
export class PaneBoundary extends React.Component<{ children: React.ReactNode; onBack: () => void }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Screen error:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="h-full min-h-[320px] flex items-center justify-center p-7">
        <div className="max-w-[420px] text-center">
          <h2 className="text-[18px] font-semibold tracking-tight text-ink">This screen hit an error</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-muted">
            Your data is safe, and the rest of Ecliptr still works. Go back to the Dashboard, or try this screen again.
          </p>
          <div className="mt-5 flex items-center justify-center gap-2">
            <button
              onClick={this.props.onBack}
              className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium"
            >
              Back to Dashboard
            </button>
            <button
              onClick={() => this.setState({ error: null })}
              className="border border-line text-ink-2 hover:bg-surface-3 px-4 h-9 rounded-lg text-[13px] font-medium"
            >
              Try again
            </button>
          </div>
          {error.message && (
            <p className="mt-5 max-h-[96px] overflow-auto whitespace-pre-wrap break-words text-[11.5px] text-faint">
              {error.message}
            </p>
          )}
        </div>
      </div>
    );
  }
}
