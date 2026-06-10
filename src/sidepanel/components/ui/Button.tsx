import type { ButtonHTMLAttributes } from "react";

/**
 * Shared button recipe — replaces ad-hoc class strings progressively.
 */
const VARIANTS = {
  primary: "bg-purple-600 text-white hover:bg-purple-500",
  secondary: "bg-gray-700 text-white hover:bg-gray-600",
  danger: "bg-red-600/25 text-red-400 border border-red-900/40 hover:bg-red-600/40",
  ghost: "text-gray-500 hover:text-gray-300",
} as const;

const SIZES = {
  sm: "px-2 py-0.5 rounded-lg text-[10px]",
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
