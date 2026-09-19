interface Focusable { focus(): void }
interface FilterPanel {
  open: boolean;
  contains(node: unknown): boolean;
  querySelector(selector: string): unknown;
}
interface Breakpoint {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: () => void): void;
}
interface FocusEventLike { target: unknown; relatedTarget: unknown }
interface FocusDocument {
  readonly body: unknown;
  readonly activeElement: unknown;
  addEventListener(type: 'focusin' | 'focusout', listener: (event: FocusEventLike) => void): void;
}

// The panel is collapsed on mobile and always expanded, without a summary, on desktop.
export function bindFilterPanel(panel: FilterPanel, mobile: Breakpoint, doc: FocusDocument) {
  const summary = panel.querySelector('summary');
  let previousMobile = mobile.matches;
  let summaryFocused = false;
  panel.open = !mobile.matches;
  // Browsers can drop focus from the disappearing summary before the media change
  // event, with or without a focusout. Only a blur on the mobile layout is deliberate.
  doc.addEventListener('focusin', event => { summaryFocused = event.target === summary; });
  doc.addEventListener('focusout', event => {
    if (!(previousMobile && !mobile.matches && !event.relatedTarget)) summaryFocused = false;
  });
  mobile.addEventListener('change', () => {
    const focused = doc.activeElement;
    const summaryHadFocus = focused === summary || (focused === doc.body && summaryFocused);
    summaryFocused = false;
    // Collapsing under a shopper who is using a filter would drop their focus.
    panel.open = !mobile.matches || panel.contains(focused);
    if (!mobile.matches && summaryHadFocus) (panel.querySelector('input[type="search"]') as Focusable | null)?.focus();
    previousMobile = mobile.matches;
  });
}
