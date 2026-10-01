/**
 * A short guided tour (design 2c): a card next to one thing at a time, with Skip / Next.
 * Shown once after the first film has been fitted, and again from the "Tour" link.
 */
export interface TourStep {
  target: () => Element | null;
  title: string;
  text: string;
}

const SEEN_KEY = "customdaw.tourSeen";

export function mountTour(steps: TourStep[]): { start(): void; startOnce(): void } {
  let card: HTMLElement | null = null;
  let current: Element | null = null;
  let index = 0;
  let onKey: ((e: KeyboardEvent) => void) | null = null;

  const close = (): void => {
    current?.classList.remove("tour-target");
    current = null;
    card?.remove();
    card = null;
    if (onKey) window.removeEventListener("keydown", onKey);
    onKey = null;
    window.removeEventListener("resize", place);
  };

  function place(): void {
    if (!card || !current) return;
    const r = current.getBoundingClientRect();
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const below = r.bottom + 12 + h < window.innerHeight;
    const top = below ? r.bottom + 12 : Math.max(8, r.top - h - 12);
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    card.style.top = `${top}px`;
    card.style.left = `${left}px`;
    card.classList.toggle("tour-card-above", !below);
  }

  function show(i: number): void {
    // Skip steps whose target isn't on screen (e.g. no logo line without a logo).
    while (i < steps.length) {
      const el = steps[i]!.target();
      if (el && (el as HTMLElement).offsetParent !== null) break;
      i++;
    }
    if (i >= steps.length) {
      close();
      return;
    }
    index = i;
    const step = steps[i]!;
    current?.classList.remove("tour-target");
    current = step.target();
    current?.classList.add("tour-target");
    current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    if (!card) {
      card = document.createElement("div");
      card.className = "tour-card";
      card.setAttribute("role", "dialog");
      card.innerHTML = `<div class="tour-count"></div><div class="tour-title"></div><p class="tour-text"></p>
        <div class="tour-actions"><button type="button" class="btn-link" data-skip>Skip</button><button type="button" class="btn btn-primary btn-small" data-next></button></div>`;
      card.querySelector("[data-skip]")!.addEventListener("click", close);
      card.querySelector("[data-next]")!.addEventListener("click", () => show(index + 1));
      document.body.appendChild(card);
      onKey = (e) => {
        if (e.key === "Escape") close();
      };
      window.addEventListener("keydown", onKey);
      window.addEventListener("resize", place);
    }
    const visible = steps.filter((s) => s.target());
    card.querySelector(".tour-count")!.textContent = `Tour · ${Math.min(visible.length, i + 1)} of ${visible.length}`;
    card.querySelector(".tour-title")!.textContent = step.title;
    card.querySelector(".tour-text")!.textContent = step.text;
    card.querySelector("[data-next]")!.textContent = i === steps.length - 1 ? "Done" : "Next";
    requestAnimationFrame(place);
    window.setTimeout(place, 350); // after the smooth scroll
  }

  const seen = (): boolean => {
    try {
      return localStorage.getItem(SEEN_KEY) === "1";
    } catch {
      return false;
    }
  };
  let shownThisSession = false;
  return {
    start() {
      shownThisSession = true;
      show(0);
    },
    startOnce() {
      if (shownThisSession || seen()) return;
      shownThisSession = true;
      try {
        localStorage.setItem(SEEN_KEY, "1");
      } catch {
        /* private mode: just this session */
      }
      show(0);
    },
  };
}
