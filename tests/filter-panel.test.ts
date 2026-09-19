import { describe, expect, it } from 'vitest';
import { bindFilterPanel } from '../src/components/shop/filter-panel';

function catalogPage({ mobile = false } = {}) {
  const listeners: Record<string, (event: { target: unknown; relatedTarget: unknown }) => void> = {};
  const body = { name: 'body' };
  const document = { body, activeElement: body as unknown,
    addEventListener(name: string, listener: (typeof listeners)[string]) { listeners[name] = listener; },
  };
  function focus(value: unknown) {
    const previous = document.activeElement;
    document.activeElement = value;
    listeners.focusout?.({ target: previous, relatedTarget: value === body ? null : value });
    if (value !== body) listeners.focusin?.({ target: value, relatedTarget: previous });
  }
  const element = (name: string) => { const value = { name, focus() { focus(value); } }; return value; };
  const summary = element('summary');
  const search = element('search');
  const brand = element('brand');
  const productLink = element('product link');
  let open = true;
  const panel = {
    get open() { return open; },
    set open(next: boolean) {
      open = next;
      // Browsers clear focus from fields inside a collapsed details element.
      if (!next && (document.activeElement === search || document.activeElement === brand)) focus(body);
    },
    contains: (node: unknown) => node === summary || node === search || node === brand,
    querySelector: (selector: string) => selector === 'summary' ? summary : search,
  };
  const media = { matches: mobile, change: () => {},
    addEventListener(_name: string, listener: () => void) { this.change = listener; } };
  bindFilterPanel(panel, media, document);
  return { document, panel, summary, search, brand, productLink,
    resize(isMobile: boolean, { cssBlur = false, silentBlur = false, beforeChange = () => {} } = {}) {
      media.matches = isMobile;
      if (cssBlur) focus(body);
      // Chrome's focus fixup resets focus from a hidden element without any event.
      if (silentBlur) document.activeElement = body;
      beforeChange();
      media.change();
    },
    blur() { focus(body); },
  };
}

describe('catalog filter panel across the mobile breakpoint', () => {
  it.each([[false, true], [true, false]])('starts with mobile=%s as open=%s', (mobile, open) => {
    expect(catalogPage({ mobile }).panel.open).toBe(open);
  });

  it('collapses on mobile and expands on desktop while the shopper is elsewhere', () => {
    const page = catalogPage();
    page.productLink.focus();
    page.resize(true);
    expect(page.panel.open).toBe(false);
    page.resize(false);
    expect(page.panel.open).toBe(true);
    expect(page.document.activeElement).toBe(page.productLink);
  });

  it('keeps the panel open on mobile while a filter field is being used', () => {
    const page = catalogPage();
    page.brand.focus();
    page.resize(true);
    expect(page.panel.open).toBe(true);
    expect(page.document.activeElement).toBe(page.brand);
  });

  it('still lets the shopper collapse a panel that was kept open', () => {
    const page = catalogPage();
    page.search.focus();
    page.resize(true);
    page.panel.open = false;
    page.resize(false);
    expect(page.panel.open).toBe(true);
  });

  it('moves focus from the hidden summary to the search field on desktop', () => {
    const page = catalogPage({ mobile: true });
    page.summary.focus();
    page.resize(false);
    expect(page.panel.open).toBe(true);
    expect(page.document.activeElement).toBe(page.search);
  });

  it('recovers the summary after CSS clears focus before the media change callback', () => {
    const page = catalogPage({ mobile: true });
    page.summary.focus();
    page.resize(false, { cssBlur: true });
    expect(page.document.activeElement).toBe(page.search);
  });

  it('recovers the summary after the browser silently drops focus before the media change callback', () => {
    const page = catalogPage({ mobile: true });
    page.summary.focus();
    page.resize(false, { silentBlur: true });
    expect(page.document.activeElement).toBe(page.search);
  });

  it('does not recover a summary that lost focus to another target before a silent drop', () => {
    const page = catalogPage({ mobile: true });
    page.summary.focus();
    page.productLink.focus();
    page.blur();
    page.resize(false, { silentBlur: true });
    expect(page.document.activeElement).toBe(page.document.body);
  });

  it('does not recover a summary deliberately blurred before the breakpoint changes', () => {
    const page = catalogPage({ mobile: true });
    page.summary.focus();
    page.blur();
    page.resize(false);
    expect(page.document.activeElement).toBe(page.document.body);
  });

  it('does not replace another focus target selected between CSS blur and the media callback', () => {
    const page = catalogPage({ mobile: true });
    page.summary.focus();
    page.resize(false, { cssBlur: true, beforeChange: () => page.productLink.focus() });
    expect(page.document.activeElement).toBe(page.productLink);
  });

  it('keeps focus on a filter field that remains visible on desktop', () => {
    const page = catalogPage({ mobile: true });
    page.panel.open = true;
    page.search.focus();
    page.resize(false);
    expect(page.document.activeElement).toBe(page.search);
  });
});
