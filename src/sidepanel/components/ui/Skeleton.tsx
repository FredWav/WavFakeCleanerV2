/**
 * Pulse placeholder shown while real data is on its way.
 */
export default function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse bg-line rounded ${className}`} aria-hidden="true" />;
}
