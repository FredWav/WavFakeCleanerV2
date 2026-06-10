/**
 * Vitest global setup — installs the chrome mock and resets it between tests.
 * Test files import { chromeMock } from "../test/setup" to seed storage or
 * trigger failure modes.
 */
import { beforeEach, vi } from "vitest";
import { createChromeMock, type ChromeMockHandle } from "./chrome-mock";

export const chromeMock: ChromeMockHandle = createChromeMock();

vi.stubGlobal("chrome", chromeMock.chrome);

beforeEach(() => {
  chromeMock.reset();
});
