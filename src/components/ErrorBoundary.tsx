import React from "react";

interface State {
  error: Error | null;
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
            The screen hit an unexpected error. Your data is safe — reloading usually
            fixes it.
          </p>
          <button
            onClick={() => window.location.reload()}
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
