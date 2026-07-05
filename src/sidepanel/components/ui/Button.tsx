import type { ButtonHTMLAttributes } from "react";

/**
 * Shared button recipe — replaces ad-hoc class strings progressively.
 */
const VARIANTS = {
  // Action primaire = ambre/or de la marque, texte foncé pour le contraste.
  primary: "bg-accent text-accent-ink hover:bg-accent-hover",
  secondary: "bg-surface-2 text-ink border border-line hover:bg-white",
  danger: "bg-suspect-bg text-suspect border border-suspect/20 hover:bg-suspect/10",
  ghost: "text-ink-faint hover:text-ink",
} as const;

const SIZES = {
  sm: "px-2 py-0.5 rounded-lg text-[11px]",
  md: "px-3 py-1.5 rounded-lg text-xs",
} as const;

export default function Button({
  variant = "primary",
  size = "md",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof VARIANTS;
  size?: keyof typeof SIZES;
}) {
  return (
    <button
      className={`font-medium transition-colors disabled:opacity-50 ${SIZES[size]} ${VARIANTS[variant]} ${className}`}
      {...rest}
    />
  );
}
