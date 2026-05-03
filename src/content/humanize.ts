/**
 * Human input simulation — make synthetic interactions look like real users.
 *
 * Threads (and Meta in general) compares incoming `click` events against
 * whether any preceding mousemove/pointerover/mousedown happened on the same
 * element. A naked `el.click()` is one of the cleanest bot fingerprints.
 *
 * `humanClick` dispatches the full pointer + mouse sequence with realistic
 * timing and jittered click coordinates inside the target element.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function humanClick(el: HTMLElement | null): Promise<void> {
  if (!el) return;

  try {
    el.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
  } catch { /* ignore */ }
  await sleep(40 + Math.random() * 80);

  const rect = el.getBoundingClientRect();
  // Click slightly off-center, like a real user
  const x = rect.left + rect.width * (0.3 + Math.random() * 0.4);
  const y = rect.top + rect.height * (0.3 + Math.random() * 0.4);

  const eventInit = (extra: Record<string, unknown> = {}): MouseEventInit => ({
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    button: 0,
    buttons: 0,
    ...extra,
  });
  const pointerInit = (extra: Record<string, unknown> = {}): PointerEventInit => ({
    ...eventInit(),
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    ...extra,
  });

  try { el.dispatchEvent(new PointerEvent("pointerover", pointerInit())); } catch { /* ignore */ }
  el.dispatchEvent(new MouseEvent("mouseover", eventInit()));
  el.dispatchEvent(new MouseEvent("mouseenter", eventInit()));
  await sleep(30 + Math.random() * 60);
  el.dispatchEvent(new MouseEvent("mousemove", eventInit()));
  await sleep(20 + Math.random() * 40);
  try { el.dispatchEvent(new PointerEvent("pointerdown", pointerInit({ buttons: 1 }))); } catch { /* ignore */ }
  el.dispatchEvent(new MouseEvent("mousedown", eventInit({ buttons: 1 })));
  await sleep(40 + Math.random() * 70);
  try { el.dispatchEvent(new PointerEvent("pointerup", pointerInit())); } catch { /* ignore */ }
  el.dispatchEvent(new MouseEvent("mouseup", eventInit()));
  el.dispatchEvent(new MouseEvent("click", eventInit()));
  // React-style synthetic onClick handlers sometimes ignore raw events
  // — call .click() too as a safety net
  try { el.click(); } catch { /* ignore */ }
}
