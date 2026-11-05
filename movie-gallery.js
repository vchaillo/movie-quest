export function buildMovieGallery(movie, selectedPath) {
  const items = [];
  const add = (path, label) => {
    if (typeof path === 'string' && /^\/[a-zA-Z0-9._-]+$/.test(path) && !items.some(item => item.path === path)) {
      items.push({path, label});
    }
  };
  add(selectedPath, 'Couverture');
  add(movie.poster_path, 'Affiche');
  for (const item of movie.images?.posters || []) add(item.file_path, 'Affiche');
  add(movie.backdrop_path, 'Image du film');
  for (const item of movie.images?.backdrops || []) add(item.file_path, 'Image du film');
  return items;
}

const icon = path => '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+path+'"/></svg>';

export function openMovieGallery({movie, selectedPath, loadImages, saveCover, onClose}) {
  let gallery = buildMovieGallery(movie, selectedPath);
  let index = 0, version = 0, saving = false, currentCover = selectedPath, displayedPath = null;
  const opener = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'mq-poster-lightbox';
  dialog.setAttribute('aria-label', 'Galerie de '+movie.title);
  const content = document.createElement('div');
  content.className = 'mq-lightbox-content';
  const stage = document.createElement('div');
  stage.className = 'mq-lightbox-stage';
  content.append(stage);
  const makeButton = (className, label, svg) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.setAttribute('aria-label', label);
    button.innerHTML = icon(svg);
    return button;
  };
  const close = makeButton('mq-lightbox-close', 'Fermer', 'm6 6 12 12M18 6 6 18');
  const previous = makeButton('mq-lightbox-previous', 'Image précédente', 'm14 6-6 6 6 6');
  const next = makeButton('mq-lightbox-next', 'Image suivante', 'm10 6 6 6-6 6');
  const toolbar = document.createElement('div');
  toolbar.className = 'mq-lightbox-toolbar';
  const counter = document.createElement('span');
  counter.className = 'mq-lightbox-counter';
  counter.setAttribute('aria-live', 'polite');
  const choose = document.createElement('button');
  choose.type = 'button';
  choose.className = 'mq-lightbox-cover';
  const status = document.createElement('span');
  status.className = 'mq-lightbox-status';
  status.setAttribute('role', 'status');
  toolbar.append(counter, choose, status);
  const updateControls = () => {
    previous.hidden = next.hidden = gallery.length < 2;
    counter.textContent = gallery.length ? (index+1)+' / '+gallery.length : '';
    choose.hidden = !gallery.length;
    choose.disabled = saving || gallery[index]?.path !== displayedPath || gallery[index]?.path === currentCover;
    choose.textContent = saving ? 'Enregistrement…' : gallery[index]?.path === currentCover ? 'Couverture actuelle' : 'Choisir comme couverture';
  };
  const show = async (direction = 0) => {
    const item = gallery[index];
    const requestVersion = ++version;
    displayedPath = null;
    updateControls();
    if (!item) return;
    const incoming = new Image();
    incoming.alt = item.label+' de '+movie.title;
    incoming.src = 'https://image.tmdb.org/t/p/original'+item.path;
    try { await incoming.decode(); } catch {
      if (requestVersion === version && dialog.open) status.textContent = 'Cette image ne peut pas être chargée. Tu peux passer à la suivante.';
      return;
    }
    if (requestVersion !== version || !dialog.open) return;
    const outgoing = stage.lastElementChild;
    // Cancel obsolete transitions before keeping just the currently displayed image.
    for (const element of stage.children) for (const animation of element.getAnimations()) animation.cancel();
    if (outgoing) stage.replaceChildren(outgoing);
    stage.append(incoming);
    const animate = direction && outgoing && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (animate) {
      const options = {duration: 280, easing: 'cubic-bezier(.22,.61,.36,1)'};
      outgoing.animate([{transform: 'translateX(0)', opacity: 1}, {transform: 'translateX('+(-direction*100)+'%)', opacity: 0}], options);
      const animation = incoming.animate([{transform: 'translateX('+(direction*100)+'%)', opacity: 0}, {transform: 'translateX(0)', opacity: 1}], options);
      await animation.finished.catch(() => {});
    }
    if (requestVersion === version && dialog.open) {
      stage.replaceChildren(incoming);
      displayedPath = item.path;
      updateControls();
    }
    // Only preload adjacent images rather than downloading the entire gallery.
    for (const offset of [-1, 1]) {
      const adjacent = gallery[(index+offset+gallery.length)%gallery.length];
      if (adjacent && gallery.length > 1) new Image().src = 'https://image.tmdb.org/t/p/original'+adjacent.path;
    }
  };
  const move = direction => {
    if (gallery.length < 2) return;
    index = (index+direction+gallery.length)%gallery.length;
    status.textContent = '';
    show(direction);
  };
  previous.addEventListener('click', () => move(-1));
  next.addEventListener('click', () => move(1));
  close.addEventListener('click', () => dialog.close());
  choose.addEventListener('click', async () => {
    if (saving || !gallery[index] || gallery[index].path !== displayedPath) return;
    const chosenPath = gallery[index].path;
    saving = true;
    status.textContent = '';
    updateControls();
    try {
      await saveCover(chosenPath);
      currentCover = chosenPath;
      status.textContent = 'Couverture enregistrée pour ton profil.';
    } catch {
      status.textContent = 'Impossible d’enregistrer la couverture. Réessaie.';
    } finally {
      saving = false;
      updateControls();
    }
  });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      move(event.key === 'ArrowLeft' ? -1 : 1);
    }
  });
  let touchX = null;
  stage.addEventListener('touchstart', event => {touchX = event.changedTouches[0].clientX;}, {passive: true});
  stage.addEventListener('touchend', event => {
    if (touchX !== null && Math.abs(event.changedTouches[0].clientX-touchX) > 45) move(event.changedTouches[0].clientX < touchX ? 1 : -1);
    touchX = null;
  }, {passive: true});
  dialog.addEventListener('click', event => {if (event.target === dialog || event.target === stage || event.target === content) dialog.close();});
  dialog.addEventListener('close', () => {
    ++version;
    dialog.remove();
    onClose?.();
    if (opener?.isConnected) opener.focus();
    else document.querySelector('[data-zoom-poster]')?.focus();
  }, {once: true});
  dialog.append(content, close, previous, next, toolbar);
  document.body.append(dialog);
  dialog.showModal();
  show();
  status.textContent = 'Chargement des images…';
  loadImages().then(images => {
    if (!dialog.open) return;
    const activePath = gallery[index]?.path;
    gallery = buildMovieGallery({...movie, images}, selectedPath);
    index = Math.max(0, gallery.findIndex(item => item.path === activePath));
    status.textContent = gallery.length ? '' : 'Aucune image disponible.';
    if (!activePath) show();
    else updateControls();
  }).catch(() => {
    if (dialog.open) status.textContent = 'Les images supplémentaires sont indisponibles pour le moment.';
  });
  return dialog;
}
