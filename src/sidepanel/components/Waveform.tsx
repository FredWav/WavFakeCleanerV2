/**
 * Waveform « signal » — clin d'œil à « Wav ». Barres pleines ambre = le signal
 * (tes vrais abonnés), barres courtes grises = le bruit (les faux qu'on nettoie).
 * Élément de marque décoratif : le chiffre réel vit dans la légende à côté.
 */
export default function Waveform({ className = "" }: { className?: string }) {
  const N = 40;
  const bars = Array.from({ length: N }, (_, i) => {
    const t = i / (N - 1);
    const base = 34 + Math.abs(Math.sin(t * Math.PI * 3.1)) * 58 + Math.sin(i * 1.9) * 7;
    const noise = i % 8 === 5 || i % 13 === 3;
    const h = noise ? 12 + (i % 3) * 5 : Math.max(14, Math.min(98, base));
    return { h, noise, i };
  });
  return (
    <div className={`flex items-end gap-[2px] h-11 ${className}`} aria-hidden="true">
      {bars.map((b) => (
        <span
          key={b.i}
          className={`flex-1 rounded-[2px] origin-bottom ${b.noise ? "bg-ink-faint/45" : "bg-accent"}`}
          style={{ height: `${b.h}%` }}
        />
      ))}
    </div>
  );
}
