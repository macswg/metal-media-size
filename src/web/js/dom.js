/** Minimal DOM helpers. No framework, no dependencies. */

/**
 * h('div.cls#id', {attrs}, ...children)
 * Attribute values that are functions become event listeners (onClick -> click).
 */
export function h(spec, attrs, ...children) {
  const [tagPart, ...rest] = String(spec).split(/(?=[.#])/);
  const el = document.createElement(tagPart || 'div');
  for (const token of rest) {
    if (token[0] === '.') el.classList.add(token.slice(1));
    else if (token[0] === '#') el.id = token.slice(1);
  }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k in el && k !== 'list' && k !== 'form' && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(4)) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function debounce(fn, ms) {
  let t = 0;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  wrapped.flush = (...args) => {
    clearTimeout(t);
    fn(...args);
  };
  return wrapped;
}

/** Wrap the parts of a path so the filename reads louder than its folders. */
export function pathCell(relPath) {
  const i = String(relPath).lastIndexOf('/');
  const frag = document.createDocumentFragment();
  if (i > -1) frag.appendChild(h('span.path-dir', { text: relPath.slice(0, i + 1) }));
  frag.appendChild(h('span.path-name', { text: i > -1 ? relPath.slice(i + 1) : relPath }));
  return frag;
}

/** A modal shell with a backdrop. Returns { root, close }. */
export function modal(titleText, bodyNodes, footerNodes, opts = {}) {
  const close = () => root.remove();
  const root = h(
    'div.modal-backdrop',
    {
      onClick: (e) => {
        if (e.target === root && opts.dismissable !== false) close();
      },
    },
    h(
      'div.modal',
      { style: opts.width ? { maxWidth: opts.width } : null, role: 'dialog', 'aria-modal': 'true' },
      h('header.modal-head', h('h2', { text: titleText }), h('button.icon-btn', { onClick: close, title: 'Close', text: '✕' })),
      h('div.modal-body', bodyNodes),
      footerNodes ? h('footer.modal-foot', footerNodes) : null,
    ),
  );
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', esc);
    }
  });
  document.body.appendChild(root);
  return { root, close };
}

let toastHost = null;
export function toast(message, kind = 'info') {
  if (!toastHost) {
    toastHost = h('div.toast-host');
    document.body.appendChild(toastHost);
  }
  const node = h(`div.toast.toast-${kind}`, { text: message });
  toastHost.appendChild(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 300);
  }, kind === 'error' ? 8000 : 4000);
}
