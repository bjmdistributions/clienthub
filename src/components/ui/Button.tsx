import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

// outline = the default small button in headers and toolbars; ink = the one primary action on a screen
// (ink-filled, or the accent colour if the user picked one); soft = a quiet chip-filled button;
// danger = an outline button in the loss red. Icons are lucide, 14px, passed as `icon`.

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "outline" | "ink" | "soft" | "danger";
  size?: "md" | "sm";
  icon?: ReactNode;
  /** Fill the width of the parent (the "View details" button at the foot of a card). */
  block?: boolean;
}

const VARIANT: Record<NonNullable<ButtonProps["variant"]>, string> = {
  outline: "",
  ink: "ui-btn-ink",
  soft: "ui-btn-soft",
  danger: "ui-btn-danger",
};

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "outline", size = "md", icon, block, className, children, type = "button", ...rest }, ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`ui-btn ${VARIANT[variant]} ${size === "sm" ? "ui-btn-sm" : ""} ${block ? "ui-btn-block" : ""} ${className || ""}`}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
});

export default Button;
