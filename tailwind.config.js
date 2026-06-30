/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'system-ui', 'sans-serif'],
      },
      colors: {
        // Semantic brand palette — adapts to html.dark via CSS variables.
        surface:     'rgb(var(--c-surface) / <alpha-value>)',
        'surface-2': 'rgb(var(--c-surface-2) / <alpha-value>)',
        'surface-3': 'rgb(var(--c-surface-3) / <alpha-value>)',
        ink:         'rgb(var(--c-ink) / <alpha-value>)',
        'ink-2':     'rgb(var(--c-ink-2) / <alpha-value>)',
        muted:       'rgb(var(--c-muted) / <alpha-value>)',
        faint:       'rgb(var(--c-faint) / <alpha-value>)',
        line:        'rgb(var(--c-line) / <alpha-value>)',
        'line-2':    'rgb(var(--c-line-2) / <alpha-value>)',
        'line-3':    'rgb(var(--c-line-3) / <alpha-value>)',
        accent: {
          DEFAULT: 'rgb(var(--c-accent) / <alpha-value>)',
          hover:   'rgb(var(--c-accent-hover) / <alpha-value>)',
        },
        // Foreground paired with the accent background — guaranteed legible per theme.
        'on-accent': 'rgb(var(--c-on-accent) / <alpha-value>)',
        success: {
          DEFAULT: 'rgb(var(--c-success) / <alpha-value>)',
          bg:      'rgb(var(--c-success-bg) / <alpha-value>)',
          ink:     'rgb(var(--c-success-ink) / <alpha-value>)',
        },
        warning: {
          DEFAULT: 'rgb(var(--c-warning) / <alpha-value>)',
          bg:      'rgb(var(--c-warning-bg) / <alpha-value>)',
          ink:     'rgb(var(--c-warning-ink) / <alpha-value>)',
        },
        danger: {
          DEFAULT: 'rgb(var(--c-danger) / <alpha-value>)',
          bg:      'rgb(var(--c-danger-bg) / <alpha-value>)',
          ink:     'rgb(var(--c-danger-ink) / <alpha-value>)',
        },
        info: {
          DEFAULT: 'rgb(var(--c-info) / <alpha-value>)',
          bg:      'rgb(var(--c-info-bg) / <alpha-value>)',
          ink:     'rgb(var(--c-info-ink) / <alpha-value>)',
        },
      },
      letterSpacing: {
        tighter: '-0.02em',
        tight:   '-0.01em',
      },
      keyframes: {
        "fade-up": {
          "0%":   { opacity: "0", transform: "translateY(10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in": {
          "0%":   { opacity: "0" },
          "100%": { opacity: "1" },
        },
        "slide-in-right": {
          "0%":   { opacity: "0", transform: "translateX(20px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        "scale-in": {
          "0%":   { opacity: "0", transform: "scale(0.95) translateY(6px)" },
          "100%": { opacity: "1", transform: "scale(1) translateY(0)" },
        },
        "shimmer": {
          "0%":   { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        "count-pulse": {
          "0%, 100%": { opacity: "1" },
          "50%":      { opacity: "0.7" },
        },
        "pulse-expand": {
          "0%":   { transform: "scale(1)", opacity: "0.5" },
          "100%": { transform: "scale(2.4)", opacity: "0" },
        },
        "page-slide-in": {
          "0%":   { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "number-pop": {
          "0%":   { transform: "scale(0.88)", opacity: "0" },
          "60%":  { transform: "scale(1.04)" },
          "100%": { transform: "scale(1)",    opacity: "1" },
        },
        "glow-pulse": {
          "0%, 100%": { boxShadow: "0 0 12px rgba(99,102,241,0.4)" },
          "50%":      { boxShadow: "0 0 24px rgba(99,102,241,0.7)" },
        },
        "spin-slow": {
          "0%":   { transform: "rotate(0deg)" },
          "100%": { transform: "rotate(360deg)" },
        },
      },
      animation: {
        "fade-up":        "fade-up 0.26s cubic-bezier(0.16,1,0.3,1)",
        "fade-in":        "fade-in 0.2s ease-out",
        "slide-in-right": "slide-in-right 0.28s cubic-bezier(0.16,1,0.3,1)",
        "scale-in":       "scale-in 0.22s cubic-bezier(0.16, 1, 0.3, 1)",
        "shimmer":        "shimmer 1.8s linear infinite",
        "count-pulse":    "count-pulse 0.6s ease-in-out",
        "pulse-expand":   "pulse-expand 2s ease-out infinite",
        "page-slide-in":  "page-slide-in 0.24s cubic-bezier(0.16,1,0.3,1) both",
        "number-pop":     "number-pop 0.4s cubic-bezier(0.16,1,0.3,1) both",
        "glow-pulse":     "glow-pulse 2.5s ease-in-out infinite",
        "spin-slow":      "spin-slow 3s linear infinite",
      },
    },
  },
  plugins: [],
};
