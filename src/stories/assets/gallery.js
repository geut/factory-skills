// Factory TUI gallery client. Renders scenarios through /api/render, keeps
// the theme, widths, and edited state in localStorage, and reloads when the
// server restarts with new code.

const data = JSON.parse(document.querySelector('#gallery-data')?.textContent ?? '{}');

const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Storage is optional.
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Storage is optional.
    }
  },
};

const themeSelect = document.querySelector('#theme');
let theme = store.get('gallery:theme') === 'light' ? 'light' : 'dark';
document.documentElement.dataset.theme = theme;
if (themeSelect !== null) {
  themeSelect.value = theme;
}

const renderers = [];

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

themeSelect?.addEventListener('change', () => {
  theme = themeSelect.value === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  store.set('gallery:theme', theme);
  for (const render of renderers) {
    render();
  }
});

// A restarted server has a new boot id: reload to pick up the new code.
// Edited state lives in localStorage, so it survives the reload.
const events = new EventSource('/api/events');
events.addEventListener('boot', (event) => {
  if (event.data !== data.boot) {
    location.reload();
  }
});

if (data.page === 'component') {
  setupComponent(data.component);
}

function setupComponent(component) {
  const widthKey = `gallery:widths:${component.id}`;
  const boxes = [...document.querySelectorAll('input[name="width"]')];
  const saved = (() => {
    try {
      const value = JSON.parse(store.get(widthKey) ?? '[]');
      return Array.isArray(value) ? value.map(Number) : [];
    } catch {
      return [];
    }
  })();
  const initial = saved.length > 0 ? saved : [80];
  for (const box of boxes) {
    box.checked = initial.includes(Number(box.value));
  }
  const widths = () => boxes.filter((box) => box.checked).map((box) => Number(box.value));

  for (const box of boxes) {
    box.addEventListener('change', () => {
      // Keep at least one width selected.
      if (widths().length === 0) {
        box.checked = true;
        return;
      }
      store.set(widthKey, JSON.stringify(widths()));
      for (const render of renderers) {
        render();
      }
    });
  }

  for (const article of document.querySelectorAll('.scenario')) {
    const story = component.stories.find((item) => item.id === article.dataset.story);
    if (story !== undefined) {
      setupScenario(component, story, article, widths);
    }
  }
}

function setupScenario(component, story, article, widths) {
  const stateKey = `gallery:state:${component.id}/${story.id}`;
  const frames = article.querySelector('.frames');
  const editor = article.querySelector('.editor');
  const textarea = article.querySelector('textarea');
  const error = article.querySelector('.error');
  const toggle = article.querySelector('.toggle-editor');
  const reset = article.querySelector('.reset');
  const badge = article.querySelector('.edited');

  let args = story.args;
  let edited = false;
  const savedState = store.get(stateKey);
  if (savedState !== null) {
    try {
      args = JSON.parse(savedState);
      edited = true;
    } catch {
      store.remove(stateKey);
    }
  }
  textarea.value = pretty(args);

  const showEdited = () => {
    badge.hidden = !edited;
    reset.hidden = !edited;
  };
  const showError = (message) => {
    error.hidden = message === null;
    error.textContent = message ?? '';
  };

  let sequence = 0;
  const render = async () => {
    const mine = ++sequence;
    let result;
    try {
      const response = await fetch('/api/render', {
        body: JSON.stringify({
          args,
          component: component.id,
          story: story.id,
          theme,
          widths: widths(),
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      result = await response.json();
    } catch (error) {
      result = { error: `The gallery server is not reachable: ${error.message}` };
    }
    if (mine !== sequence) {
      return;
    }
    if (result.error !== undefined) {
      showError(`Render failed: ${result.error}`);
      return;
    }
    showError(null);
    const palette = data.palette[theme];
    frames.replaceChildren(
      ...result.renders.map(({ html, width }) => {
        const figure = document.createElement('figure');
        figure.className = 'frame';
        const caption = document.createElement('figcaption');
        caption.textContent = `${width} cols · Pi ${theme}`;
        const pre = document.createElement('pre');
        pre.className = html.length === 0 ? 'terminal empty' : 'terminal';
        pre.style.width = `${width}ch`;
        pre.style.background = palette.page;
        pre.style.color = palette.text;
        // The server escapes text and only emits styled spans.
        pre.innerHTML = html;
        figure.append(caption, pre);
        return figure;
      }),
    );
  };
  renderers.push(render);

  let timer = null;
  textarea.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        args = JSON.parse(textarea.value);
      } catch (error) {
        showError(`Invalid JSON: ${error.message}`);
        return;
      }
      edited = true;
      store.set(stateKey, JSON.stringify(args));
      showEdited();
      render();
    }, 200);
  });

  toggle.addEventListener('click', () => {
    const open = editor.hidden;
    editor.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? 'Hide state' : 'Edit state';
  });

  reset.addEventListener('click', () => {
    args = story.args;
    edited = false;
    store.remove(stateKey);
    textarea.value = pretty(args);
    showEdited();
    showError(null);
    render();
  });

  showEdited();
  render();
}
