(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };
  const setMessage = (node, text, kind) => {
    if (!node) return;
    node.textContent = text || '';
    node.className = `sp-message${text ? ` show ${kind || 'error'}` : ''}`;
  };
  let spotlightTexts = {};
  let spotlightSettings = {};
  const t = (key) => String(spotlightTexts[key] ?? '');
  const copyText = (key, values = {}) => t(key).replace(/\{([a-z_]+)\}/gi, (whole, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole);
  const spotlightUI = window.createSpotlightUI({ t, copyText });
  const applyStaticCopy = () => {
    document.querySelectorAll('[data-sp-text]').forEach((node) => {
      if (Object.prototype.hasOwnProperty.call(spotlightTexts, node.dataset.spText)) node.textContent = t(node.dataset.spText);
    });
    document.querySelectorAll('[data-sp-placeholder]').forEach((node) => {
      if (Object.prototype.hasOwnProperty.call(spotlightTexts, node.dataset.spPlaceholder)) node.setAttribute('placeholder', t(node.dataset.spPlaceholder));
    });
    document.querySelectorAll('[data-sp-aria]').forEach((node) => {
      if (Object.prototype.hasOwnProperty.call(spotlightTexts, node.dataset.spAria)) node.setAttribute('aria-label', t(node.dataset.spAria));
    });
    document.querySelectorAll('[data-sp-href]').forEach((node) => {
      const raw = t(node.dataset.spHref).trim();
      let href = '#';
      if (raw === '#') href = '#';
      else if (raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\') && !/[\u0000-\u001f]/.test(raw)) href = raw;
      else if (/^(https?:\/\/|mailto:)/i.test(raw)) {
        try {
          const parsed = new URL(raw);
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') href = raw;
        } catch { href = '#'; }
      }
      node.setAttribute('href', href);
    });
    document.querySelectorAll('[data-sp-template]').forEach((node) => {
      node.textContent = copyText(node.dataset.spTemplate, { count: node.dataset.spCount || 0 });
    });
  };
  const showToast = (text) => {
    const node = $('toast');
    if (!node) return;
    node.textContent = text;
    node.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => node.classList.remove('show'), 2200);
  };
  const initials = (name) => String(name || '?').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?';
  const campusLine = (student) => [student.course, student.section || null, student.year].filter(Boolean).join(' · ');
  const getJSON = async (url, options = {}) => {
    const response = await fetch(url, { credentials: 'same-origin', ...options });
    let data = {};
    try { data = await response.json(); } catch { /* Empty or non-JSON response. */ }
    if (!response.ok) {
      const error = new Error(data.message || (response.status === 429 ? t('rate_limit') : copyText('request_failed_status', { status: response.status })));
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  };
  const svgIcon = (kind) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const paths = {
      heart: 'M20.8 8.8c0 4.1-8.8 10-8.8 10s-8.8-5.9-8.8-10A4.6 4.6 0 0 1 12 6.1a4.6 4.6 0 0 1 8.8 2.7Z',
      laugh: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM8.5 14s1.2 2 3.5 2 3.5-2 3.5-2M9 9h.01M15 9h.01',
      fire: 'M12 22c4.1 0 7-2.8 7-6.7 0-2.9-1.7-5.1-4.5-7.7.2 2.3-.6 3.5-1.4 4.1C12.6 7.5 10.5 4.5 8 2 8.5 6.7 5 9.3 5 15.2 5 19.2 7.9 22 12 22Z',
      share: 'M12 15V3m0 0L7.5 7.5M12 3l4.5 4.5M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7',
      copy: 'M8 8V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3M5 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z',
      report: 'M5 21V4m0 0c5-4 9 4 14 0v10c-5 4-9-4-14 0',
    };
    path.setAttribute('d', paths[kind] || paths.heart);
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.8');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    if (kind === 'heart' || kind === 'fire') path.setAttribute('fill', 'none');
    svg.append(path);
    return svg;
  };
  const makeAvatar = (student, large = false) => {
    const avatar = make('span', `sp-avatar${large ? ' sp-avatar-large' : ''}`, initials(student.name));
    const rollHash = String(student.roll_number || '').split('').reduce((sum, char) => ((sum * 31) + char.charCodeAt(0)) >>> 0, 7);
    avatar.style.setProperty('--avatar-gradient', [
      'linear-gradient(145deg,#ff3d7f,#a23cff)',
      'linear-gradient(145deg,#ff8b4a,#ee408d)',
      'linear-gradient(145deg,#20cbb0,#3d7bff)',
      'linear-gradient(145deg,#a23cff,#3d7bff)',
      'linear-gradient(145deg,#e8ad3b,#ed5d76)',
      'linear-gradient(145deg,#27bca0,#a23cff)',
    ][rollHash % 6]);
    const image = document.createElement('img');
    image.alt = student.name || t('student_fallback');
    image.width = large ? 112 : 180;
    image.height = large ? 112 : 180;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.src = `/api/spotlight/photo/${encodeURIComponent(student.roll_number)}`;
    image.addEventListener('error', () => image.remove(), { once: true });
    avatar.append(image);
    return avatar;
  };
  const profileLink = (roll) => `/spotlight/${encodeURIComponent(String(roll || '').toUpperCase())}`;
  const formatDate = (value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  };

  let turnstileKey = null;
  let turnstileVerified = false;
  let turnstileWidget = null;
  let turnstileToken = null;
  let turnstileWaiters = [];
  let turnstileScriptPromise = null;
  let configPromise = null;
  const ensureConfig = () => {
    if (!configPromise) configPromise = getJSON('/api/spotlight/config').then((config) => {
      turnstileKey = config.turnstileSiteKey || null;
      turnstileVerified = Boolean(config.turnstileVerified);
      if (turnstileKey) loadTurnstile();
      return config;
    }).catch(() => {
      configPromise = null;
      throw new Error(t('security_settings_error'));
    });
    return configPromise;
  };
  const loadTurnstile = () => {
    if (turnstileScriptPromise) return turnstileScriptPromise;
    turnstileScriptPromise = new Promise((resolve) => {
      if (window.turnstile) { resolve(true); return; }
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      document.head.append(script);
    });
    return turnstileScriptPromise;
  };
  const installTurnstile = async (container) => {
    await ensureConfig();
    if (!turnstileKey || turnstileVerified || !container || turnstileWidget !== null) return;
    const loaded = await loadTurnstile();
    if (!loaded || !window.turnstile) return;
    container.hidden = false;
    container.setAttribute('aria-label', t('security_aria'));
    turnstileWidget = window.turnstile.render(container, {
      sitekey: turnstileKey,
      theme: 'light',
      execution: 'execute',
      appearance: 'interaction-only',
      callback: (token) => {
        turnstileToken = token;
        turnstileWaiters.splice(0).forEach((resolve) => resolve(token));
      },
      'expired-callback': () => { turnstileToken = null; },
      'error-callback': () => {
        turnstileToken = null;
        turnstileWaiters.splice(0).forEach((resolve) => resolve(null));
      },
    });
  };
  const acquireTurnstile = async () => {
    await ensureConfig();
    if (turnstileVerified) return undefined;
    if (!turnstileKey) return undefined;
    // A separate top-layer dialog keeps managed challenges usable from either
    // the sticky Like button or the otherwise closed note composer.
    const dialog = $('spotlightSecurityDialog');
    const cancelButton = dialog?.querySelector('[data-security-cancel]');
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      turnstileWaiters.splice(0).forEach(resolve => resolve(null));
      if (dialog?.open) dialog.close();
    };
    dialog?.addEventListener('cancel', cancel);
    cancelButton?.addEventListener('click', cancel);
    if (dialog && !dialog.open) dialog.showModal();
    try {
      if (turnstileWidget === null) await installTurnstile($('turnstileNote'));
      if (cancelled) throw new Error(t('security_try_again'));
      if (!(await loadTurnstile()) || turnstileWidget === null) {
        throw new Error(t('security_load_error'));
      }
      if (turnstileToken) {
        const token = turnstileToken;
        turnstileToken = null;
        return token;
      }
      const token = await new Promise((resolve) => {
        turnstileWaiters.push(resolve);
        try { window.turnstile.execute(turnstileWidget); }
        catch { turnstileWaiters.splice(turnstileWaiters.indexOf(resolve), 1); resolve(null); }
        window.setTimeout(() => {
          const index = turnstileWaiters.indexOf(resolve);
          if (index !== -1) { turnstileWaiters.splice(index, 1); resolve(null); }
        }, 120000);
      });
      if (!token) throw new Error(t('security_try_again'));
      turnstileToken = null;
      return token;
    } finally {
      dialog?.removeEventListener('cancel', cancel);
      cancelButton?.removeEventListener('click', cancel);
      if (dialog?.open) dialog.close();
    }
  };
  const resetTurnstile = () => {
    turnstileToken = null;
    if (turnstileWidget !== null && window.turnstile) {
      try { window.turnstile.reset(turnstileWidget); } catch { /* Widget may have been removed. */ }
    }
  };
  const getDeviceHash = async () => {
    if (!window.crypto?.subtle || !window.TextEncoder) throw new Error(t('device_hash_error'));
    const fingerprint = [
      navigator.userAgent || '',
      screen.width,
      screen.height,
      window.devicePixelRatio || 1,
      Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      navigator.language || '',
      navigator.platform || '',
      navigator.hardwareConcurrency || 0,
    ];
    const bytes = new TextEncoder().encode(JSON.stringify(fingerprint));
    const digest = await window.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  };
  const markLocallyVerified = () => {
    if (turnstileKey) turnstileVerified = true;
  };

  async function startDirectory() {
    const grid = $('studentGrid');
    const more = $('loadMore');
    const filtersBox = $('filterSteps');
    const search = $('studentSearch');
    const leaderBox = $('leaderboard');
    const state = { years: [], courses: [], sections: [], year: '', course: '', section: '', query: '', page: 1, hasMore: false, loading: false, leader: 'trending' };
    let searchTimer;
    let listRequestId = 0;
    let leaderRequestId = 0;
    let listObserver = null;
    let autoLoadBlocked = false;
    const renderChipGroup = (label, items, value, onPick) => {
      const group = make('div', 'sp-filter-group');
      group.append(make('span', 'sp-filter-label', label));
      const chips = make('div', 'sp-chips');
      const options = [{ value: '', label: t('filter_all') }, ...items];
      options.forEach((item) => {
        const button = make('button', 'sp-chip', item.label);
        button.type = 'button';
        button.setAttribute('aria-pressed', String(item.value === value));
        button.addEventListener('click', () => onPick(item.value));
        chips.append(button);
      });
      group.append(chips);
      return group;
    };
    const renderFilters = () => {
      filtersBox.replaceChildren();
      filtersBox.append(renderChipGroup(t('filter_year'), state.years.map((year) => ({ value: year, label: year })), state.year, (year) => {
        state.year = year; state.course = ''; state.section = ''; state.page = 1; renderFilters(); loadStudents();
      }));
      if (state.year) {
        const courses = state.courses.filter((item) => item.year === state.year);
        filtersBox.append(renderChipGroup(t('filter_course'), courses.map((item) => ({ value: item.course, label: item.course })), state.course, (course) => {
          state.course = course; state.section = ''; state.page = 1; renderFilters(); loadStudents();
        }));
      }
      if (state.year && state.course) {
        const sections = state.sections.filter((item) => item.year === state.year && item.course === state.course).map((item) => item.section);
        if (sections.length) filtersBox.append(renderChipGroup(t('filter_section'), [...new Set(sections)].map((section) => ({ value: section, label: section })), state.section, (section) => {
          state.section = section; state.page = 1; renderFilters(); loadStudents();
        }));
      }
    };
    const studentCard = (student) => {
      const link = make('a', 'sp-student');
      link.href = profileLink(student.roll_number);
      link.append(makeAvatar(student));
      const copy = make('span', 'sp-student-copy');
      copy.append(make('span', 'sp-student-name', student.name || t('student_fallback')));
      copy.append(make('span', 'sp-student-meta', campusLine(student)));
      const counts = make('span', 'sp-card-counts');
      counts.append(make('span', '', `${t('like_emoji')} ${Number(student.like_count) || 0}`), make('span', '', `${t('notes_label')} ${Number(student.note_count) || 0}`));
      copy.append(counts);
      link.append(copy);
      return link;
    };
    const renderSkeletons = () => {
      grid.replaceChildren();
      for (let i = 0; i < 6; i += 1) grid.append(make('div', 'sp-skeleton'));
    };
    async function loadStudents(append = false) {
      if (state.loading && append) return;
      const requestId = ++listRequestId;
      state.loading = true;
      autoLoadBlocked = false;
      if (!append) {
        renderSkeletons();
        more.hidden = true;
      } else {
        grid.querySelector('[data-list-error]')?.remove();
        more.disabled = true;
        more.textContent = t('loading_students');
        const skeletons = make('div', 'sp-append-skeletons');
        skeletons.dataset.appendSkeletons = 'true';
        skeletons.append(make('div', 'sp-skeleton'), make('div', 'sp-skeleton'));
        grid.append(skeletons);
      }
      const params = new URLSearchParams({ page: String(state.page) });
      if (state.year) params.set('year', state.year);
      if (state.course) params.set('course', state.course);
      if (state.section) params.set('section', state.section);
      if (state.query) params.set('q', state.query);
      try {
        const data = await getJSON(`/api/spotlight/students?${params}`);
        if (requestId !== listRequestId) return;
        grid.querySelector('[data-append-skeletons]')?.remove();
        const students = Array.isArray(data.students) ? data.students : [];
        if (!append) grid.replaceChildren();
        students.forEach((student) => grid.append(studentCard(student)));
        state.hasMore = Boolean(data.hasMore);
        more.hidden = !state.hasMore;
        more.disabled = false;
        more.textContent = t('load_more_students');
        $('directoryCaption').textContent = students.length
          ? (state.query ? copyText('directory_matches', { query: state.query }) : copyText('directory_count', { count: students.length }))
          : t('directory_no_match_hint');
        if (!students.length && !append) {
          const empty = make('div', 'sp-state');
          empty.append(make('strong', '', state.query ? t('directory_matches_empty_title') : t('directory_empty_title')), make('span', '', t('directory_empty_hint')));
          grid.append(empty);
        }
      } catch (error) {
        if (requestId !== listRequestId) return;
        autoLoadBlocked = true;
        grid.querySelector('[data-append-skeletons]')?.remove();
        if (!append) {
          state.hasMore = false;
          grid.replaceChildren();
          const failed = make('div', 'sp-state');
          failed.append(make('strong', '', t('directory_load_error')), make('span', '', error.message || t('try_again')));
          const retry = make('button', 'sp-btn sp-btn-secondary', t('try_again'));
          retry.type = 'button'; retry.style.marginTop = '12px'; retry.addEventListener('click', () => loadStudents(false));
          failed.append(retry); grid.append(failed);
        } else {
          const failed = make('div', 'sp-state');
          failed.dataset.listError = 'true';
          failed.append(make('strong', '', t('directory_retry_error')), make('span', '', error.message || t('directory_retry_hint')));
          const retry = make('button', 'sp-btn sp-btn-secondary', t('retry'));
          retry.type = 'button'; retry.style.marginTop = '12px'; retry.addEventListener('click', () => loadStudents(true));
          failed.append(retry); grid.append(failed);
        }
        more.textContent = t('retry');
        more.hidden = !state.hasMore;
      } finally {
        if (requestId === listRequestId) {
          state.loading = false;
          more.disabled = false;
          if (listObserver && state.hasMore && !autoLoadBlocked) {
            listObserver.unobserve(more);
            listObserver.observe(more);
          }
        }
      }
    }
    const renderLeaderState = (text, error = false) => {
      leaderBox.replaceChildren();
      const message = make('div', 'sp-state');
      message.append(make('strong', '', error ? t('leader_load_error') : text));
      if (error) {
        message.append(make('span', '', text));
        const retry = make('button', 'sp-btn sp-btn-secondary', t('try_again'));
        retry.type = 'button'; retry.style.marginTop = '12px'; retry.addEventListener('click', loadLeaderboard); message.append(retry);
      }
      leaderBox.append(message);
    };
    async function loadLeaderboard() {
      const requestId = ++leaderRequestId;
      leaderBox.replaceChildren(...Array.from({ length: 4 }, () => make('div', 'sp-skeleton')));
      try {
        const data = await getJSON(`/api/spotlight/leaderboard?tab=${encodeURIComponent(state.leader)}`);
        if (requestId !== leaderRequestId) return;
        const students = (Array.isArray(data.students) ? data.students : []).slice(0, Number(spotlightSettings.leaderboard_size));
        leaderBox.replaceChildren();
        if (!students.length) { renderLeaderState(t('leader_empty')); return; }
        const itemValue = (student) => Number(state.leader === 'trending' ? student.score : (state.leader === 'liked' ? student.like_count : student.note_count)) || 0;
        const podium = make('div', 'sp-podium');
        students.slice(0, 3).forEach((student, index) => {
          const card = make('a', 'sp-podium-card');
          card.href = profileLink(student.roll_number);
          card.style.setProperty('--rank-color', ['var(--gold)', 'var(--silver)', 'var(--bronze)'][index]);
          card.append(make('span', 'sp-podium-rank', copyText('leader_rank', { rank: index + 1 })), makeAvatar(student));
          card.append(make('span', 'sp-student-name', student.name || t('student_fallback')));
          card.append(make('span', 'sp-student-meta', campusLine(student)));
          const podiumCount = make('span', 'sp-leader-count', String(itemValue(student)));
          podiumCount.append(make('small', '', state.leader === 'trending' ? t('leader_unit_trending') : state.leader === 'liked' ? t('leader_unit_liked') : t('leader_unit_noted')));
          card.append(podiumCount);
          podium.append(card);
        });
        leaderBox.append(podium);
        students.slice(3).forEach((student, index) => {
          const link = make('a', 'sp-leader');
          link.href = profileLink(student.roll_number);
          link.append(make('span', 'sp-leader-rank', String(index + 4)));
          link.append(makeAvatar(student));
          const copy = make('span', 'sp-leader-copy');
          copy.append(make('span', 'sp-student-name', student.name || t('student_fallback')));
          copy.append(make('span', 'sp-student-meta', campusLine(student)));
          link.append(copy);
          const value = itemValue(student);
          const count = make('span', 'sp-leader-count', String(value));
          count.append(make('small', '', state.leader === 'trending' ? t('leader_unit_trending') : state.leader === 'liked' ? t('leader_unit_liked') : t('leader_unit_noted')));
          link.append(count);
          leaderBox.append(link);
        });
      } catch (error) { if (requestId === leaderRequestId) renderLeaderState(error.message || t('please_try_again'), true); }
    }
    try {
      const filters = await getJSON('/api/spotlight/filters');
      state.years = Array.isArray(filters.years) ? filters.years : [];
      state.courses = Array.isArray(filters.courses) ? filters.courses : [];
      state.sections = Array.isArray(filters.sections) ? filters.sections : [];
      renderFilters();
    } catch (error) {
      filtersBox.replaceChildren();
      const warning = make('div', 'sp-state');
      warning.append(make('strong', '', t('filters_unavailable')), make('span', '', error.message || t('filters_fallback')));
      filtersBox.append(warning);
    }
    await loadStudents();
    loadLeaderboard();
    const clearSearch = $('clearStudentSearch');
    const syncClear = () => { clearSearch.hidden = !search.value; };
    clearSearch.addEventListener('click', () => {
      search.value = '';
      syncClear();
      state.query = '';
      state.page = 1;
      loadStudents();
      search.focus();
    });
    search.addEventListener('input', () => {
      syncClear();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.query = search.value.trim(); state.page = 1; loadStudents(); }, 280);
    });
    more.addEventListener('click', () => {
      if (!state.hasMore || state.loading) return;
      if (!autoLoadBlocked) state.page += 1;
      loadStudents(true);
    });
    const randomAction = async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const data = await getJSON('/api/spotlight/random');
        if (!data.roll_number) throw new Error(t('random_missing'));
        window.location.assign(profileLink(data.roll_number));
      } catch (error) { showToast(error.message || t('random_error')); }
      finally { button.disabled = false; }
    };
    $('randomProfile').addEventListener('click', randomAction);
    $('randomProfileBottom').addEventListener('click', () => $('randomProfile').click());
    if ('IntersectionObserver' in window) {
      listObserver = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting) && state.hasMore && !state.loading && !autoLoadBlocked) {
          state.page += 1;
          loadStudents(true);
        }
      }, { rootMargin: '240px' });
      listObserver.observe(more);
    }
    document.querySelectorAll('[data-leader-tab]').forEach((button) => button.addEventListener('click', () => {
      state.leader = button.dataset.leaderTab;
      document.querySelectorAll('[data-leader-tab]').forEach((tab) => tab.setAttribute('aria-selected', String(tab === button)));
      loadLeaderboard();
    }));
  }

  async function startProfile() {
    const match = window.location.pathname.match(/\/spotlight\/([^/]+)\/?$/);
    const roll = match ? decodeURIComponent(match[1]).toUpperCase() : '';
    const view = $('profileView');
    const noteWall = $('noteWall');
    const leaveNote = $('leaveNote');
    const notesList = $('notesList');
    const reacting = new Set();
    let studentData = null;
    const profileFailure = (title, text) => {
      view.replaceChildren();
      const state = make('div', 'sp-state');
      state.append(make('strong', '', title), make('span', '', text));
       const back = make('a', 'sp-btn sp-btn-secondary', t('back_to_discovery'));
      back.href = '/spotlight'; back.style.marginTop = '14px'; state.append(back); view.append(state);
    };
    const reactionButton = (note, type, label, emoji, count) => {
      const button = make('button', `sp-action${note.myReaction === type ? ' is-selected' : ''}`);
      button.type = 'button';
      button.dataset.reaction = type;
      button.setAttribute('aria-label', copyText('reaction_aria', { label, count: Number(count) || 0 }));
      button.append(make('span', '', emoji), make('span', '', String(Number(count) || 0)));
      return button;
    };
    const renderNotes = (notes) => {
      notesList.replaceChildren();
      const ordered = [...notes].sort((a, b) => {
        const totalA = Number(a.react_heart || 0) + Number(a.react_laugh || 0) + Number(a.react_fire || 0);
        const totalB = Number(b.react_heart || 0) + Number(b.react_laugh || 0) + Number(b.react_fire || 0);
        return totalB - totalA || new Date(b.approved_at || b.created_at).getTime() - new Date(a.approved_at || a.created_at).getTime();
      });
      if (!ordered.length) {
        const empty = make('div', 'sp-state');
         empty.append(make('strong', '', t('notes_empty_title')), make('span', '', t('notes_empty_hint')));
        notesList.append(empty); return;
      }
      ordered.forEach((note) => {
        const card = make('article', 'sp-note');
        card.dataset.noteId = String(note.id);
        card.append(make('div', 'sp-note-text', note.text || ''));
        const footer = make('div', 'sp-note-footer');
        const reactions = make('div', 'sp-reactions');
        reactions.append(
           reactionButton(note, 'heart', t('reaction_heart_label'), t('reaction_heart'), note.react_heart),
           reactionButton(note, 'laugh', t('reaction_laugh_label'), t('reaction_laugh'), note.react_laugh),
           reactionButton(note, 'fire', t('reaction_fire_label'), t('reaction_fire'), note.react_fire),
        );
        const tools = make('div', '');
         const time = make('div', 'sp-time', spotlightUI.relativeTime(note.approved_at || note.created_at));
         const report = make('button', 'sp-action sp-report', t('report_menu_icon'));
         report.type = 'button'; report.dataset.reportMenu = 'true'; report.setAttribute('aria-label', t('report_menu_aria')); report.setAttribute('aria-expanded', 'false');
         const menu = make('div', 'sp-report-menu');
         menu.hidden = true;
         const reportAction = make('button', 'sp-action sp-report-action', t('report_label'));
         reportAction.type = 'button'; reportAction.dataset.report = 'true';
         menu.append(reportAction);
         tools.append(time, report, menu);
        footer.append(reactions, tools);
        card.append(footer);
        notesList.append(card);
      });
    };
    try {
      await ensureConfig();
      let deviceHash = null;
      try { deviceHash = await getDeviceHash(); } catch { /* Keep profile available; liking will report an explicit device-check error when required. */ }
      const profileUrl = new URL(`/api/spotlight/students/${encodeURIComponent(roll)}`, window.location.origin);
      if (deviceHash) profileUrl.searchParams.set('device_hash', deviceHash);
      const data = await getJSON(profileUrl.pathname + profileUrl.search, { cache: 'no-store' });
      studentData = data.student;
      if (!studentData) throw new Error(t('profile_missing'));
      document.title = `${studentData.name || t('student_fallback')} · ${t('brand_name')}`;
      view.replaceChildren();
      const card = make('section', 'sp-profile-card');
      const photoBackdrop = make('div', 'sp-profile-backdrop');
      const backdropPhoto = document.createElement('img');
      backdropPhoto.alt = '';
      backdropPhoto.width = 720;
      backdropPhoto.height = 360;
      backdropPhoto.loading = 'lazy';
      backdropPhoto.decoding = 'async';
      backdropPhoto.src = `/api/spotlight/photo/${encodeURIComponent(studentData.roll_number)}`;
      backdropPhoto.addEventListener('error', () => backdropPhoto.remove(), { once: true });
      photoBackdrop.append(backdropPhoto);
      card.append(photoBackdrop);
      const main = make('div', 'sp-profile-main');
      const person = make('div', 'sp-profile-person');
      person.append(makeAvatar(studentData, true));
      const info = make('div', 'sp-profile-info');
       info.append(make('h1', 'sp-profile-name', studentData.name || t('student_fallback')));
      info.append(make('div', 'sp-roll', studentData.roll_number || roll));
      const chips = make('div', 'sp-profile-meta');
      [studentData.course, studentData.section, studentData.year].filter(Boolean).forEach((value) => chips.append(make('span', 'sp-profile-chip', value)));
      info.append(chips);
      person.append(info);
      main.append(person);
      const actions = make('div', 'sp-profile-actions');
      const like = make('button', `sp-btn sp-btn-like${data.likedByMe ? ' is-liked' : ''}`);
      like.type = 'button';
      like.dataset.likeButton = 'true';
       like.setAttribute('aria-pressed', String(Boolean(data.likedByMe)));
       const likeLabel = make('span', '', copyText('like_count_format', { emoji: t('like_emoji'), label: data.likedByMe ? t('liked_label') : t('like_label'), count: Number(studentData.like_count) || 0 }));
       like.setAttribute('aria-label', copyText('like_aria', { label: `${t('like_emoji')} ${data.likedByMe ? t('liked_label') : t('like_label')}`, count: Number(studentData.like_count) || 0 }));
      like.append(likeLabel);
      like.addEventListener('click', async () => {
        if (like.disabled) return;
        like.disabled = true;
        try {
           if (!deviceHash && spotlightSettings.like_device_check !== false) throw new Error(t('device_hash_error'));
           if (!deviceHash) deviceHash = await getDeviceHash().catch(() => null);
           const token = await acquireTurnstile();
           const body = { device_hash: deviceHash };
           if (token) body.turnstileToken = token;
          const updated = await getJSON(`/api/spotlight/students/${encodeURIComponent(roll)}/like`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          data.likedByMe = Boolean(updated.liked);
          studentData.like_count = updated.like_count;
          like.classList.toggle('is-liked', data.likedByMe);
          like.setAttribute('aria-pressed', String(data.likedByMe));
           likeLabel.textContent = copyText('like_count_format', { emoji: t('like_emoji'), label: data.likedByMe ? t('liked_label') : t('like_label'), count: Number(updated.like_count) || 0 });
            like.setAttribute('aria-label', copyText('like_aria', { label: `${t('like_emoji')} ${data.likedByMe ? t('liked_label') : t('like_label')}`, count: Number(updated.like_count) || 0 }));
           markLocallyVerified();
          $('profileLikeCount').textContent = String(Number(updated.like_count) || 0);
          if (data.likedByMe) {
            const rect = like.getBoundingClientRect();
            const burst = make('span', 'sp-like-burst');
            burst.append(svgIcon('heart'));
            burst.style.left = `${rect.left + rect.width / 2}px`;
            burst.style.top = `${rect.top}px`;
            document.body.append(burst);
            setTimeout(() => burst.remove(), 700);
          }
         } catch (error) {
           if (error.status === 409 && error.data?.liked) {
             markLocallyVerified();
             data.likedByMe = true;
             studentData.like_count = Number(error.data.like_count ?? studentData.like_count) || 0;
             like.classList.add('is-liked');
             like.setAttribute('aria-pressed', 'true');
             likeLabel.textContent = copyText('like_count_format', { emoji: t('like_emoji'), label: t('liked_label'), count: studentData.like_count });
             like.setAttribute('aria-label', copyText('like_aria', { label: `${t('like_emoji')} ${t('liked_label')}`, count: studentData.like_count }));
             $('profileLikeCount').textContent = String(studentData.like_count);
           }
           showToast(error.message || t('like_failed'));
        } finally { resetTurnstile(); like.disabled = false; }
      });
      const share = make('button', 'sp-btn sp-btn-secondary');
       share.type = 'button'; share.append(svgIcon('share'), make('span', '', t('share_button')));
      share.addEventListener('click', () => shareProfile(studentData));
      actions.append(like, share);
      main.append(actions);
      const stats = make('div', 'sp-profile-stats');
        [[t('likes_label'), studentData.like_count], [t('notes_label'), studentData.note_count]].forEach(([label, value], index) => {
        const stat = make('div', 'sp-profile-stat');
        const count = make('b', '', String(Number(value) || 0));
         if (index === 0) count.id = 'profileLikeCount';
        const emoji = make('span', 'sp-stat-emoji', t(index === 0 ? 'like_emoji' : 'notes_emoji'));
        emoji.setAttribute('aria-hidden', 'true');
        stat.append(emoji);
        stat.append(count, make('span', '', label));
        stats.append(stat);
      });
      main.append(stats);
      card.append(main);
      view.append(card);
      renderNotes(Array.isArray(data.notes) ? data.notes : []);
      noteWall.hidden = false;
      $('openNoteComposer').hidden = false;
      const form = $('noteForm');
      const textInput = $('noteText');
      const counter = $('noteCounter');
      const submit = $('noteSubmit');
      const noteSheet = $('noteSheet');
      const openNoteButton = $('openNoteComposer');
      const closeNoteButton = $('closeNoteComposer');
      let lastSheetFocus = null;
      const closeNoteSheet = () => {
        leaveNote.hidden = true;
        document.body.classList.remove('sp-sheet-open');
        lastSheetFocus?.focus?.();
      };
      const openNoteSheet = () => {
        lastSheetFocus = document.activeElement;
        leaveNote.hidden = false;
        document.body.classList.add('sp-sheet-open');
        textInput.focus();
      };
      openNoteButton.addEventListener('click', openNoteSheet);
      closeNoteButton.setAttribute('aria-label', t('sheet_close_aria'));
      closeNoteButton.addEventListener('click', closeNoteSheet);
      leaveNote.addEventListener('click', (event) => { if (event.target === leaveNote) closeNoteSheet(); });
      document.addEventListener('keydown', (event) => {
        if ($('spotlightSecurityDialog')?.open) return;
        if (leaveNote.hidden) return;
        if (event.key === 'Escape') { event.preventDefault(); closeNoteSheet(); return; }
        if (event.key !== 'Tab') return;
        const focusable = Array.from(noteSheet.querySelectorAll('button:not([disabled]),textarea,input,a[href],[tabindex]:not([tabindex="-1"])')).filter((el) => !el.hidden);
        if (!focusable.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      });
      textInput.addEventListener('input', () => {
        counter.textContent = copyText('note_counter', { count: textInput.value.length });
        counter.setAttribute('aria-label', copyText('note_counter_aria', { count: textInput.value.length }));
        counter.style.setProperty('--note-progress', `${Math.min(200, textInput.value.length) * 1.8}deg`);
      });
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const text = textInput.value.trim();
        setMessage($('noteMessage'), '');
       if (!text) { setMessage($('noteMessage'), t('note_empty_error'), 'error'); return; }
       submit.disabled = true; submit.textContent = t('note_sending');
        try {
          const token = await acquireTurnstile();
          const body = { text };
          if (token) body.turnstileToken = token;
          const response = await getJSON(`/api/spotlight/students/${encodeURIComponent(roll)}/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
         setMessage($('noteMessage'), response.message || t('note_review'), 'success');
         markLocallyVerified();
         textInput.value = ''; counter.textContent = copyText('note_counter', { count: 0 });
         counter.style.setProperty('--note-progress', '0deg');
          showToast(t('note_review'));
          closeNoteSheet();
       } catch (error) { setMessage($('noteMessage'), error.message || t('note_send_error'), 'error'); }
       finally { resetTurnstile(); submit.disabled = false; submit.textContent = t('note_send'); }
      });
      notesList.addEventListener('click', async (event) => {
        const cardElement = event.target.closest('[data-note-id]');
        if (!cardElement) return;
        const noteId = cardElement.dataset.noteId;
        const reportButton = event.target.closest('[data-report]');
         if (reportButton) {
            if (!(await spotlightUI.confirm(t('report_confirm')))) return;
          reportButton.disabled = true;
          try {
            const reportResult = await getJSON(`/api/spotlight/notes/${encodeURIComponent(noteId)}/report`, { method: 'POST' });
             if (reportResult.success === false) throw new Error(reportResult.message || t('report_failed'));
            cardElement.remove();
            const currentNotes = Array.isArray(data.notes) ? data.notes : [];
            data.notes = currentNotes.filter((note) => String(note.id) !== String(noteId));
            renderNotes(data.notes);
             showToast(t('note_reported_thanks'));
           } catch (error) { showToast(error.message || t('report_failed')); reportButton.disabled = false; }
          return;
        }
         const menuButton = event.target.closest('[data-report-menu]');
         if (menuButton) {
           const menu = cardElement.querySelector('.sp-report-menu');
           const opening = menu.hidden;
           notesList.querySelectorAll('.sp-report-menu').forEach((item) => { item.hidden = true; });
           notesList.querySelectorAll('[data-report-menu]').forEach((item) => item.setAttribute('aria-expanded', 'false'));
           menu.hidden = !opening;
           menuButton.setAttribute('aria-expanded', String(opening));
           return;
         }
        const reactionButtonElement = event.target.closest('[data-reaction]');
        if (!reactionButtonElement || reactionButtonElement.disabled || reacting.has(noteId)) return;
        const kind = reactionButtonElement.dataset.reaction;
        reacting.add(noteId);
        cardElement.querySelectorAll('[data-reaction]').forEach(button => { button.disabled = true; });
        try {
          const result = await getJSON(`/api/spotlight/notes/${encodeURIComponent(noteId)}/react`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ emoji: kind }),
          });
          const note = data.notes.find((item) => String(item.id) === String(noteId));
          if (note) {
            note.react_heart = result.counts?.heart ?? result.counts?.react_heart ?? note.react_heart;
            note.react_laugh = result.counts?.laugh ?? result.counts?.react_laugh ?? note.react_laugh;
            note.react_fire = result.counts?.fire ?? result.counts?.react_fire ?? note.react_fire;
            note.myReaction = result.myReaction || null;
          }
          renderNotes(data.notes);
        } catch (error) {
           showToast(error.message || t('reaction_failed'));
          cardElement.querySelectorAll('[data-reaction]').forEach(button => { button.disabled = false; });
        } finally { reacting.delete(noteId); }
      });
    } catch (error) {
      profileFailure(error.status === 404 ? t('profile_not_available') : t('profile_open_failed'), error.message || t('profile_try_again'));
    }
  }

  function shareProfile(student) {
    const link = window.location.href;
    const brand = t('share_brand') || t('brand_name');
    const message = copyText('share_template', { name: student.name || t('student_fallback'), link, brand });
    if (navigator.share) {
      navigator.share({ title: copyText('share_title', { name: student.name || t('student_fallback'), brand }), text: message }).catch(() => {});
      return;
    }
    const previousFocus = document.activeElement;
    const host = $('shareDialogHost');
    host.replaceChildren();
    const overlay = make('div', 'sp-overlay');
    const closeOverlay = () => { overlay.remove(); previousFocus?.focus?.(); };
    overlay.addEventListener('click', (event) => { if (event.target === overlay) closeOverlay(); });
    const dialog = make('section', 'sp-dialog');
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'shareHeading');
    dialog.append(make('h2', '', t('share_dialog_title')));
    const heading = dialog.lastChild; heading.id = 'shareHeading';
    dialog.append(make('p', '', t('share_dialog_hint')));
    const options = make('div', 'sp-share-options');
    const whatsapp = make('a', 'sp-btn', t('share_whatsapp'));
    whatsapp.href = `https://wa.me/?text=${encodeURIComponent(message)}`;
    whatsapp.target = '_blank'; whatsapp.rel = 'noopener noreferrer';
    const copy = make('button', 'sp-btn sp-btn-secondary', t('copy_link'));
    copy.type = 'button';
    copy.addEventListener('click', async () => {
       try { await navigator.clipboard.writeText(link); showToast(t('link_copied')); closeOverlay(); }
      catch { showToast(t('copy_failed')); }
    });
    options.append(whatsapp, copy);
    dialog.append(options);
    const close = make('button', 'sp-quiet-link', t('share_close'));
    close.type = 'button'; close.style.marginTop = '10px'; close.addEventListener('click', closeOverlay);
    dialog.append(close); overlay.append(dialog); host.append(overlay);
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); closeOverlay(); return; }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialog.querySelectorAll('a[href],button:not([disabled])'));
      if (!focusable.length) return;
      if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable[focusable.length - 1].focus(); }
      else if (!event.shiftKey && document.activeElement === focusable[focusable.length - 1]) { event.preventDefault(); focusable[0].focus(); }
    });
    close.focus();
  }

  async function startAdmin() {
    const loginView = $('adminLoginView');
    const adminView = $('adminView');
    const loginForm = $('adminLoginForm');
    const content = $('adminContent');
    const state = { tab: 'pending', queue: { pending: [], reported: [] }, students: [], search: '', loading: false };
    let searchTimer;
    let studentRequest = 0;
    const showLogin = (message = '') => {
      adminView.hidden = true;
      loginView.hidden = false;
      $('adminPassword').value = '';
      setMessage($('adminLoginError'), message, 'error');
    };
    const handleAdminError = (error) => {
      if (error.status === 401) { showLogin(t('admin_session_ended')); return; }
      setMessage($('adminError'), error.message || t('request_failed'), 'error');
    };
    const editor = window.createSpotlightEditor({
      content,
      t,
      copyText,
      make,
      getJSON,
      showToast,
      setAdminError: (message, error) => error ? handleAdminError(error) : setMessage($('adminError'), message, 'error'),
      refreshPublicCopy: async () => {
        const refreshed = await getJSON('/api/spotlight/texts', { cache: 'no-store' });
        spotlightTexts = refreshed.texts || {};
        spotlightSettings = refreshed.settings || {};
        applyStaticCopy();
      },
    });
    const loadQueue = async () => {
      content.replaceChildren(make('div', 'sp-skeleton'), make('div', 'sp-skeleton'), make('div', 'sp-skeleton'));
      try {
        const data = await getJSON('/api/spotlight/admin/queue');
        state.queue = { pending: Array.isArray(data.pending) ? data.pending : [], reported: Array.isArray(data.reported) ? data.reported : [] };
        $('pendingBadge').textContent = String(state.queue.pending.length);
        renderAdminContent();
      } catch (error) { handleAdminError(error); }
    };
    const loadSettings = () => editor.load();
    const renderAdminContent = () => {
      content.replaceChildren();
      setMessage($('adminError'), '');
      if (state.tab === 'settings') { editor.render(); return; }
      if (state.tab === 'students') {
        const inputWrap = make('div', 'sp-admin-search');
        const search = document.createElement('input');
        search.type = 'search'; search.className = 'sp-input'; search.style.paddingLeft = '14px';
         search.placeholder = t('campus_search');
        search.value = state.search;
         search.setAttribute('aria-label', t('campus_search_aria'));
        inputWrap.append(search);
        content.append(inputWrap);
       const hint = make('p', 'sp-section-caption', t('campus_search_hint'));
        content.append(hint);
        if (!state.search) {
          const info = make('div', 'sp-state');
         info.append(make('strong', '', t('student_manage_empty_title')), make('span', '', t('student_manage_empty_hint')));
          content.append(info);
        } else if (!state.students.length) {
          const empty = make('div', 'sp-state');
         empty.append(make('strong', '', t('student_no_match')), make('span', '', t('student_try_another')));
          content.append(empty);
        } else {
          state.students.forEach((student) => {
            const row = make('div', 'sp-hidden-row');
            const copy = make('div', 'sp-student-copy');
           copy.append(make('div', 'sp-student-name', student.name || t('student_fallback')));
            copy.append(make('div', 'sp-student-meta', `${student.roll_number || ''} · ${campusLine(student)}`));
           if (student.hidden) copy.append(make('span', 'sp-badge', t('hidden_label')));
           const button = make('button', `sp-btn ${student.hidden ? 'sp-btn-secondary' : 'sp-btn-danger'}`, student.hidden ? t('unhide_label') : t('hide_label'));
            button.type = 'button'; button.dataset.visibilityAction = student.hidden ? 'unhide' : 'hide'; button.dataset.roll = student.roll_number;
            row.append(copy, button); content.append(row);
          });
        }
        search.addEventListener('input', () => {
          clearTimeout(searchTimer);
          state.search = search.value.trim();
          searchTimer = setTimeout(loadStudents, 280);
        });
        return;
      }
      const notes = state.queue[state.tab] || [];
      if (!notes.length) {
        const empty = make('div', 'sp-state');
         empty.append(make('strong', '', state.tab === 'pending' ? t('empty_pending_title') : t('empty_reported_title')), make('span', '', state.tab === 'pending' ? t('empty_pending_hint') : t('empty_reported_hint')));
        content.append(empty); return;
      }
      notes.forEach((note) => {
        const article = make('article', 'sp-admin-note');
        const head = make('div', 'sp-admin-head');
        const meta = make('div', 'sp-admin-meta');
        const nameLine = make('div');
        if (note.roll_number) head.append(makeAvatar(note));
         const name = make('b', '', note.name || t('student_fallback'));
        nameLine.append(name, document.createTextNode(` · ${note.roll_number || ''}`));
        meta.append(nameLine, make('div', '', `${campusLine(note)} · ${formatDate(note.created_at)}`));
         if (note.status) meta.append(make('div', '', `${copyText('status_label', { status: note.status })}${note.reported ? t('note_reported_suffix') : ''}`));
        head.append(meta);
        article.append(head, make('div', 'sp-admin-text', note.text || ''));
        const actions = make('div', 'sp-admin-actions');
        const addAction = (label, action, style, confirmMessage) => {
          const button = make('button', `sp-btn ${style}`, label);
          button.type = 'button';
          button.addEventListener('click', async () => {
            if (confirmMessage && !(await spotlightUI.confirm(confirmMessage))) return;
            button.disabled = true;
            try {
              const result = await getJSON(`/api/spotlight/admin/notes/${encodeURIComponent(note.id)}/${action}`, { method: 'POST' });
             if (result.success === false) throw new Error(result.message || t('admin_action_error'));
              await loadQueue();
             showToast(action === 'approve' ? t('note_approved') : action === 'keep' ? t('note_restored') : t('note_removed'));
            } catch (error) { button.disabled = false; handleAdminError(error); }
          });
          actions.append(button);
        };
        if (state.tab === 'pending') {
           addAction(t('approve_label'), 'approve', 'sp-btn-approve');
           addAction(t('reject_label'), 'reject', 'sp-btn-danger', t('reject_confirm'));
        } else {
           addAction(t('keep_note_label'), 'keep', 'sp-btn-keep');
           addAction(t('delete_label'), 'delete', 'sp-btn-danger', t('delete_confirm'));
        }
        article.append(actions); content.append(article);
      });
    };
    const loadStudents = async () => {
      const request = ++studentRequest;
      const focused = content.contains(document.activeElement) && document.activeElement.type === 'search';
      const position = focused ? document.activeElement.selectionStart : null;
      if (!state.search) { state.students = []; renderAdminContent(); return; }
      try {
        const data = await getJSON(`/api/spotlight/admin/students?q=${encodeURIComponent(state.search)}`);
        if (request !== studentRequest || state.tab !== 'students') return;
        state.students = Array.isArray(data.students) ? data.students.slice(0, 50) : [];
        renderAdminContent();
        if (focused) {
          const input = content.querySelector('input[type=search]');
          input.focus();
          input.setSelectionRange(position, position);
        }
      } catch (error) { handleAdminError(error); }
    };
    loginForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = $('adminLoginButton');
      const password = $('adminPassword').value;
      setMessage($('adminLoginError'), '');
      if (!password) { setMessage($('adminLoginError'), t('login_enter_password'), 'error'); return; }
      button.disabled = true; button.textContent = t('login_signing_in');
      try {
        const result = await getJSON('/api/spotlight/admin/login', { method: 'POST', headers: { 'x-admin-password': password } });
        if (result.success !== true) throw new Error(result.message || t('login_failed'));
        loginView.hidden = true;
        adminView.hidden = false;
        $('adminPassword').value = '';
        await loadQueue();
      } catch (error) { setMessage($('adminLoginError'), error.message || t('login_failed'), 'error'); }
      finally { button.disabled = false; button.textContent = t('login_button'); $('adminPassword').value = ''; }
    });
    $('adminLogout').addEventListener('click', async () => {
      try { await getJSON('/api/spotlight/admin/logout', { method: 'POST' }); }
      catch (error) { if (error.status !== 401) setMessage($('adminError'), error.message, 'error'); }
      state.queue = { pending: [], reported: [] }; state.students = [];
      showLogin(t('signed_out'));
    });
    $('adminTabs').addEventListener('click', async (event) => {
      const tab = event.target.closest('[data-admin-tab]');
      if (!tab) return;
      if (editor.isSaving()) return;
      if (state.tab === 'settings' && editor.hasDirty()) {
        if (!(await spotlightUI.confirm(t('settings_dirty_confirm')))) return;
        editor.discard();
      }
      state.tab = tab.dataset.adminTab;
      $('adminTabs').querySelectorAll('[data-admin-tab]').forEach((button) => button.setAttribute('aria-selected', String(button === tab)));
      if (state.tab === 'students') renderAdminContent();
      else if (state.tab === 'settings') loadSettings();
      else loadQueue();
    });
    content.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-visibility-action]');
      if (!button) return;
      button.disabled = true;
      const action = button.dataset.visibilityAction;
      const roll = button.dataset.roll;
      try {
        const result = await getJSON(`/api/spotlight/admin/students/${encodeURIComponent(roll)}/${action}`, { method: 'POST' });
        if (result.success === false) throw new Error(result.message || t('profile_visibility_error'));
        await loadStudents();
        showToast(action === 'hide' ? t('profile_hidden') : t('profile_visible'));
      } catch (error) { button.disabled = false; handleAdminError(error); }
    });
    // The signed session cookie is the only credential retained after login.
    adminView.hidden = true;
    getJSON('/api/spotlight/admin/queue').then((data) => {
      state.queue = { pending: Array.isArray(data.pending) ? data.pending : [], reported: Array.isArray(data.reported) ? data.reported : [] };
      $('pendingBadge').textContent = String(state.queue.pending.length);
      loginView.hidden = true;
      adminView.hidden = false;
      renderAdminContent();
    }).catch((error) => {
      if (error.status !== 401) setMessage($('adminLoginError'), error.message || t('admin_login_session_error'), 'error');
    });
  }

  const failedPageVisibility = new Map();
  const startAfterTexts = async () => {
    const errorView = $('spotlightTextsError');
    const app = $('app');
    try {
      const response = await getJSON('/api/spotlight/texts', { cache: 'no-store' });
      spotlightTexts = response.texts || {};
      spotlightSettings = response.settings || {};
      applyStaticCopy();
      spotlightUI.setupTheme();
      if (errorView) errorView.hidden = true;
      if (app && failedPageVisibility.size) {
        failedPageVisibility.forEach((wasHidden, node) => { node.hidden = wasHidden; });
        failedPageVisibility.clear();
      }
      const page = document.body.dataset.spotlightPage;
      if (page === 'directory') startDirectory();
      if (page === 'profile') startProfile();
      if (page === 'admin') startAdmin();
    } catch (error) {
      if (app) Array.from(app.children).forEach((node) => {
        if (!failedPageVisibility.has(node)) failedPageVisibility.set(node, node.hidden);
        node.hidden = node !== errorView;
      });
      if (errorView) {
        errorView.hidden = false;
      }
      const retry = $('spotlightTextsRetry');
      if (retry) retry.addEventListener('click', () => {
        retry.disabled = true;
        startAfterTexts().finally(() => { retry.disabled = false; });
      }, { once: true });
    }
  };
  startAfterTexts();
})();
