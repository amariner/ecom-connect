import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const layout = readFileSync(new URL('../src/layouts/Admin.astro', import.meta.url), 'utf8');
const source = layout.match(/<script>([\s\S]*?)<\/script>/)[1];
const script = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function navigationPage({ mobile = false, currentPage = true } = {}) {
  const classes = new Set();
  const elements = new Map();
  const body = { classList: {
    toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); },
    contains(name) { return classes.has(name); },
  } };
  const document = { body, activeElement: body,
    listeners: {},
    querySelector(selector) { return elements.get(selector); },
    addEventListener(name, listener) { this.listeners[name] = listener; },
  };
  function focus(value) {
    const previous = document.activeElement;
    document.activeElement = value;
    document.listeners.focusout?.({ target: previous, relatedTarget: value === body ? null : value });
    if (value !== body) document.listeners.focusin?.({ target: value });
  }
  function element(name, parent = null) {
    let inert = false;
    const value = { name, parent, hidden: false, listeners: {}, attributes: {},
      focus() { focus(value); },
      setAttribute(key, attribute) { value.attributes[key] = attribute; },
      addEventListener(name, listener) { value.listeners[name] = listener; },
      contains(other) { return other === value || other?.parent === value; },
      get inert() { return inert; },
      set inert(next) {
        inert = next;
        // Browsers clear focus as soon as its container becomes inert.
        if (next && value.contains(document.activeElement)) focus(body);
      },
    };
    return value;
  }
  const sidebar = element('sidebar');
  const menu = element('open');
  const close = element('close', sidebar);
  const brand = element('brand', sidebar);
  const currentLink = element('current page', sidebar);
  const otherLink = element('other page', sidebar);
  const content = element('content input');
  const backdrop = element('backdrop');
  const workspace = element('workspace');
  sidebar.querySelector = selector => selector === 'a[aria-current="page"]' ? (currentPage ? currentLink : null) : brand;
  for (const [selector, value] of [
    ['.mobile-nav-button', menu], ['#admin-sidebar', sidebar], ['.mobile-nav-close', close],
    ['.admin-sidebar-backdrop', backdrop], ['.admin-workspace', workspace],
  ]) elements.set(selector, value);
  const media = { matches: mobile, addEventListener(name, listener) { this.change = listener; } };
  const frames = [];
  vm.runInNewContext(script, {
    document, window: { matchMedia: () => media }, requestAnimationFrame(callback) { frames.push(callback); },
  });
  return { document, sidebar, menu, close, brand, currentLink, otherLink, content, workspace, backdrop,
    open() { menu.listeners.click(); this.flushFrames(); },
    resize(isMobile, { cssBlur = false, silentBlur = false, beforeChange = () => {} } = {}) {
      media.matches = isMobile;
      if (cssBlur) focus(body);
      // Chrome's focus fixup resets focus from a hidden element without any event.
      if (silentBlur) document.activeElement = body;
      beforeChange();
      media.change();
    },
    blur() { focus(body); },
    flushFrames() { while (frames.length) frames.shift()(); },
  };
}

describe('admin navigation focus across the mobile breakpoint', () => {
  it('restores focus to the opener when a desktop sidebar link is lost inside an inert drawer', () => {
    const page = navigationPage();
    page.otherLink.focus();
    page.resize(true);
    expect(page.document.activeElement).toBe(page.menu);
    expect(page.sidebar.inert).toBe(true);
    expect(page.menu.attributes['aria-expanded']).toBe('false');
  });

  it('moves focus from the hidden mobile close button to the current page on desktop', () => {
    const page = navigationPage({ mobile: true });
    page.open();
    expect(page.document.activeElement).toBe(page.close);
    page.resize(false);
    expect(page.document.activeElement).toBe(page.currentLink);
    expect(page.sidebar.inert).toBe(false);
    expect(page.workspace.inert).toBe(false);
    expect(page.backdrop.hidden).toBe(true);
  });

  it('recovers the open drawer after CSS clears focus before the media change callback', () => {
    const page = navigationPage({ mobile: true });
    page.open();
    page.resize(false, { cssBlur: true });
    expect(page.document.activeElement).toBe(page.currentLink);
  });

  it('recovers the closed menu opener after CSS clears focus before the media change callback', () => {
    const page = navigationPage({ mobile: true });
    page.menu.focus();
    page.resize(false, { cssBlur: true });
    expect(page.document.activeElement).toBe(page.currentLink);
  });

  it('recovers the closed menu opener after the browser silently drops focus before the media change callback', () => {
    const page = navigationPage({ mobile: true });
    page.menu.focus();
    page.resize(false, { silentBlur: true });
    expect(page.document.activeElement).toBe(page.currentLink);
  });

  it('does not recover an opener that lost focus to another target before a silent drop', () => {
    const page = navigationPage({ mobile: true });
    page.menu.focus();
    page.content.focus();
    page.blur();
    page.resize(false, { silentBlur: true });
    expect(page.document.activeElement).toBe(page.document.body);
  });

  it('does not recover an opener deliberately blurred before the breakpoint changes', () => {
    const page = navigationPage({ mobile: true });
    page.menu.focus();
    page.blur();
    page.resize(false);
    expect(page.document.activeElement).toBe(page.document.body);
  });

  it('does not replace another focus target selected between CSS blur and the media callback', () => {
    const page = navigationPage({ mobile: true });
    page.menu.focus();
    page.resize(false, { cssBlur: true, beforeChange: () => page.content.focus() });
    expect(page.document.activeElement).toBe(page.content);
  });

  it('also recovers from the opener when the closed mobile menu becomes a desktop sidebar', () => {
    const page = navigationPage({ mobile: true });
    page.menu.focus();
    page.resize(false);
    expect(page.document.activeElement).toBe(page.currentLink);
  });

  it('falls back to the brand link when this page has no current navigation item', () => {
    const page = navigationPage({ mobile: true, currentPage: false });
    page.open();
    page.resize(false);
    expect(page.document.activeElement).toBe(page.brand);
  });

  it('keeps focus on a drawer link that remains visible on desktop', () => {
    const page = navigationPage({ mobile: true });
    page.open();
    page.otherLink.focus();
    page.resize(false);
    expect(page.document.activeElement).toBe(page.otherLink);
  });

  it.each([false, true])('does not steal content focus when the initial mobile state is %s', mobile => {
    const page = navigationPage({ mobile });
    page.content.focus();
    page.resize(!mobile);
    expect(page.document.activeElement).toBe(page.content);
  });
});
