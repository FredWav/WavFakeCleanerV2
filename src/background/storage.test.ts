import { describe, it, expect } from "vitest";
import { chromeMock } from "../test/setup";
import { getDailyUsage, incrementDailyUsage } from "./storage";
import { FREE_LIMITS } from "@shared/types";

/**
 * Verrou du compteur de quota gratuit (TEST-d de l'audit). Le mode gratuit =
 * FREE_LIMITS.cyclesPerDay nettoyage(s)/jour ; ces fonctions (adossées à
 * chrome.storage.local, pas à IndexedDB) en sont la source. On vérifie le
 * comptage et la remise à zéro quotidienne — la garde qui empêche un free-user
 * de boucler à vide repose dessus.
 */
describe("dailyUsage — quota gratuit (TEST-d)", () => {
  const today = () => new Date().toISOString().slice(0, 10);

  it("démarre à 0 pour un jour neuf", async () => {
    const u = await getDailyUsage();
    expect(u.cycles).toBe(0);
    expect(u.dayKey).toBe(today());
  });

  it("incrémente et persiste le nombre de cycles", async () => {
    await incrementDailyUsage("cycles");
    expect((await getDailyUsage()).cycles).toBe(1);
    await incrementDailyUsage("cycles");
    expect((await getDailyUsage()).cycles).toBe(2);
  });

  it("atteindre la limite gratuite est observable (>= cyclesPerDay)", async () => {
    await incrementDailyUsage("cycles");
    expect((await getDailyUsage()).cycles).toBeGreaterThanOrEqual(FREE_LIMITS.cyclesPerDay);
  });

  it("remet le compteur à zéro quand le jour stocké n'est pas aujourd'hui", async () => {
    await chromeMock.chrome.storage.local.set({
      dailyUsage: { dayKey: "2000-01-01", cycles: 9 },
    });
    const u = await getDailyUsage();
    expect(u.cycles).toBe(0); // ancien jour → réinitialisé
    expect(u.dayKey).toBe(today());
  });
});
