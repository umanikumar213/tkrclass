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
      const error = new Error(data.message || (response.status === 429 ? 'Please wait a little before trying again.' : `Request failed (${response.status}).`));
      error.status = response.status;
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
    avatar.setAttribute('aria-hidden', 'true');
    const image = document.createElement('img');
    image.alt = '';
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
  let turnstileWidget = null;
  let turnstileToken = null;
  let turnstileWaiters = [];
  let turnstileScriptPromise = null;
  let configPromise = null;
  const ensureConfig = () => {
    if (!configPromise) configPromise = getJSON('/api/spotlight/config').then((config) => {
      turnstileKey = config.turnstileSiteKey || null;
      if (turnstileKey) loadTurnstile();
      return config;
    }).catch(() => {
      configPromise = null;
      throw new Error('Could not load security settings. Please try again.');
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
    if (!turnstileKey || !container || turnstileWidget !== null) return;
    const loaded = await loadTurnstile();
    if (!loaded || !window.turnstile) return;
    container.hidden = false;
    container.setAttribute('aria-label', 'Security check');
    turnstileWidget = window.turnstile.render(container, {
      sitekey: turnstileKey,
      theme: 'light',
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
    if (!turnstileKey) return undefined;
    if (!(await loadTurnstile()) || turnstileWidget === null) {
      throw new Error('Security check could not load. Please refresh and try again.');
    }
    if (turnstileToken) {
      const token = turnstileToken;
      turnstileToken = null;
      return token;
    }
    $('turnstileNote')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    showToast('Complete the security check to continue.');
    const token = await new Promise((resolve) => {
      turnstileWaiters.push(resolve);
      if (turnstileWidget !== null && window.turnstile) {
        try { window.turnstile.execute(turnstileWidget); } catch { /* Visible challenge can still be completed manually. */ }
      }
      window.setTimeout(() => {
        const index = turnstileWaiters.indexOf(resolve);
        if (index !== -1) { turnstileWaiters.splice(index, 1); resolve(null); }
      }, 120000);
    });
    if (!token) throw new Error('Complete the security check and try again.');
    turnstileToken = null;
    return token;
  };
  const resetTurnstile = () => {
    turnstileToken = null;
    if (turnstileWidget !== null && window.turnstile) {
      try { window.turnstile.reset(turnstileWidget); } catch { /* Widget may have been removed. */ }
    }
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
    const renderChipGroup = (label, items, value, onPick) => {
      const group = make('div', 'sp-filter-group');
      group.append(make('span', 'sp-filter-label', label));
      const chips = make('div', 'sp-chips');
      const options = [{ value: '', label: 'All' }, ...items];
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
      filtersBox.append(renderChipGroup('Year', state.years.map((year) => ({ value: year, label: year })), state.year, (year) => {
        state.year = year; state.course = ''; state.section = ''; state.page = 1; renderFilters(); loadStudents();
      }));
      if (state.year) {
        const courses = state.courses.filter((item) => item.year === state.year);
        filtersBox.append(renderChipGroup('Course', courses.map((item) => ({ value: item.course, label: item.course })), state.course, (course) => {
          state.course = course; state.section = ''; state.page = 1; renderFilters(); loadStudents();
        }));
      }
      if (state.year && state.course) {
        const sections = state.sections.filter((item) => item.year === state.year && item.course === state.course).map((item) => item.section);
        if (sections.length) filtersBox.append(renderChipGroup('Section', [...new Set(sections)].map((section) => ({ value: section, label: section })), state.section, (section) => {
          state.section = section; state.page = 1; renderFilters(); loadStudents();
        }));
      }
    };
    const studentCard = (student) => {
      const link = make('a', 'sp-student');
      link.href = profileLink(student.roll_number);
      link.append(makeAvatar(student));
      const copy = make('span', 'sp-student-copy');
      copy.append(make('span', 'sp-student-name', student.name || 'Student'));
      copy.append(make('span', 'sp-student-meta', `${campusLine(student)} · ${student.roll_number || ''}`));
      const counts = make('span', 'sp-card-counts');
      counts.append(make('span', '', `Likes ${Number(student.like_count) || 0}`), make('span', '', `Notes ${Number(student.note_count) || 0}`));
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
      if (!append) {
        renderSkeletons();
        more.hidden = true;
      } else {
        grid.querySelector('[data-list-error]')?.remove();
        more.disabled = true;
        more.textContent = 'Loading students…';
      }
      const params = new URLSearchParams({ page: String(state.page) });
      if (state.year) params.set('year', state.year);
      if (state.course) params.set('course', state.course);
      if (state.section) params.set('section', state.section);
      if (state.query) params.set('q', state.query);
      try {
        const data = await getJSON(`/api/spotlight/students?${params}`);
        if (requestId !== listRequestId) return;
        const students = Array.isArray(data.students) ? data.students : [];
        if (!append) grid.replaceChildren();
        students.forEach((student) => grid.append(studentCard(student)));
        state.hasMore = Boolean(data.hasMore);
        more.hidden = !state.hasMore;
        more.disabled = false;
        more.textContent = 'Load more students';
        $('directoryCaption').textContent = students.length
          ? (state.query ? `Showing matches for “${state.query}”.` : `${students.length} students in this view. Find a classmate and say something kind.`)
          : 'Try another name or filter to find your classmate.';
        if (!students.length && !append) {
          const empty = make('div', 'sp-state');
          empty.append(make('strong', '', state.query ? 'No matches this time' : 'No students in this view'), make('span', '', 'Change a filter or search for a different name.'));
          grid.append(empty);
        }
      } catch (error) {
        if (requestId !== listRequestId) return;
        if (!append) {
          grid.replaceChildren();
          const failed = make('div', 'sp-state');
          failed.append(make('strong', '', 'Could not load the directory'), make('span', '', error.message || 'Please try again.'));
          const retry = make('button', 'sp-btn sp-btn-secondary', 'Try again');
          retry.type = 'button'; retry.style.marginTop = '12px'; retry.addEventListener('click', () => loadStudents(false));
          failed.append(retry); grid.append(failed);
        } else {
          const failed = make('div', 'sp-state');
          failed.dataset.listError = 'true';
          failed.append(make('strong', '', 'More students could not load'), make('span', '', error.message || 'Try again when the connection is ready.'));
          const retry = make('button', 'sp-btn sp-btn-secondary', 'Retry');
          retry.type = 'button'; retry.style.marginTop = '12px'; retry.addEventListener('click', () => loadStudents(true));
          failed.append(retry); grid.append(failed);
        }
        more.hidden = true;
      } finally {
        if (requestId === listRequestId) {
          state.loading = false;
          more.disabled = false;
        }
      }
    }
    const renderLeaderState = (text, error = false) => {
      leaderBox.replaceChildren();
      const message = make('div', 'sp-state');
      message.append(make('strong', '', error ? 'Could not load appreciation' : text));
      if (error) {
        message.append(make('span', '', text));
        const retry = make('button', 'sp-btn sp-btn-secondary', 'Try again');
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
        const students = (Array.isArray(data.students) ? data.students : []).slice(0, 20);
        leaderBox.replaceChildren();
        if (!students.length) { renderLeaderState('No appreciation to show just yet.'); return; }
        students.forEach((student) => {
          const link = make('a', 'sp-leader');
          link.href = profileLink(student.roll_number);
          link.append(makeAvatar(student));
          const copy = make('span', 'sp-leader-copy');
          copy.append(make('span', 'sp-student-name', student.name || 'Student'));
          copy.append(make('span', 'sp-student-meta', campusLine(student)));
          link.append(copy);
          const value = Number(state.leader === 'trending' ? student.score : (state.leader === 'liked' ? student.like_count : student.note_count)) || 0;
          const count = make('span', 'sp-leader-count', String(value));
          count.append(make('small', '', state.leader === 'trending' ? 'appreciation' : state.leader === 'liked' ? 'likes' : 'notes'));
          link.append(count);
          leaderBox.append(link);
        });
      } catch (error) { if (requestId === leaderRequestId) renderLeaderState(error.message || 'Please try again.', true); }
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
      warning.append(make('strong', '', 'Filters are unavailable'), make('span', '', error.message || 'You can still search the directory.'));
      filtersBox.append(warning);
    }
    await loadStudents();
    loadLeaderboard();
    search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.query = search.value.trim(); state.page = 1; loadStudents(); }, 280);
    });
    more.addEventListener('click', () => {
      if (!state.hasMore || state.loading) return;
      state.page += 1;
      loadStudents(true);
    });
    $('randomProfile').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const data = await getJSON('/api/spotlight/random');
        if (!data.roll_number) throw new Error('No profile is available yet.');
        window.location.assign(profileLink(data.roll_number));
      } catch (error) { showToast(error.message || 'Could not find a profile.'); }
      finally { button.disabled = false; }
    });
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
      const back = make('a', 'sp-btn sp-btn-secondary', 'Back to discovery');
      back.href = '/spotlight'; back.style.marginTop = '14px'; state.append(back); view.append(state);
    };
    const reactionButton = (note, type, label, count) => {
      const button = make('button', `sp-action${note.myReaction === type ? ' is-selected' : ''}`);
      button.type = 'button';
      button.dataset.reaction = type;
      button.setAttribute('aria-label', `${label}, ${Number(count) || 0}`);
      button.append(svgIcon(type), make('span', '', String(Number(count) || 0)));
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
        empty.append(make('strong', '', 'The wall is waiting for its first note'), make('span', '', 'Leave the first kind message for this student.'));
        notesList.append(empty); return;
      }
      ordered.forEach((note) => {
        const card = make('article', 'sp-note');
        card.dataset.noteId = String(note.id);
        card.append(make('div', 'sp-note-text', note.text || ''));
        const footer = make('div', 'sp-note-footer');
        const reactions = make('div', 'sp-reactions');
        reactions.append(
          reactionButton(note, 'heart', 'Heart', note.react_heart),
          reactionButton(note, 'laugh', 'Laugh', note.react_laugh),
          reactionButton(note, 'fire', 'Fire', note.react_fire),
        );
        const tools = make('div', '');
        const time = make('div', 'sp-time', formatDate(note.approved_at || note.created_at));
        const report = make('button', 'sp-action sp-report');
        report.type = 'button'; report.dataset.report = 'true'; report.append(svgIcon('report'), make('span', '', 'Report'));
        tools.append(time, report);
        footer.append(reactions, tools);
        card.append(footer);
        notesList.append(card);
      });
    };
    try {
      await ensureConfig();
      const data = await getJSON(`/api/spotlight/students/${encodeURIComponent(roll)}`, { cache: 'no-store' });
      studentData = data.student;
      if (!studentData) throw new Error('This profile is not available.');
      document.title = `${studentData.name || 'Student'} · TKR Spotlight`;
      view.replaceChildren();
      const card = make('section', 'sp-profile-card');
      const main = make('div', 'sp-profile-main');
      const person = make('div', 'sp-profile-person');
      person.append(makeAvatar(studentData, true));
      const info = make('div', 'sp-profile-info');
      info.append(make('h1', 'sp-profile-name', studentData.name || 'Student'));
      info.append(make('div', 'sp-roll', studentData.roll_number || roll));
      info.append(make('div', 'sp-profile-meta', campusLine(studentData)));
      person.append(info);
      main.append(person);
      const actions = make('div', 'sp-profile-actions');
      const like = make('button', `sp-btn sp-btn-like${data.likedByMe ? ' is-liked' : ''}`);
      like.type = 'button';
      like.dataset.likeButton = 'true';
      like.setAttribute('aria-pressed', String(Boolean(data.likedByMe)));
      like.append(svgIcon('heart'));
      const likeLabel = make('span', '', `${data.likedByMe ? 'Liked' : '+1 Like'} · ${Number(studentData.like_count) || 0}`);
      like.append(likeLabel);
      like.addEventListener('click', async () => {
        if (like.disabled) return;
        like.disabled = true;
        try {
          const token = await acquireTurnstile();
          const body = token ? { turnstileToken: token } : {};
          const updated = await getJSON(`/api/spotlight/students/${encodeURIComponent(roll)}/like`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          data.likedByMe = Boolean(updated.liked);
          studentData.like_count = updated.like_count;
          like.classList.toggle('is-liked', data.likedByMe);
          like.setAttribute('aria-pressed', String(data.likedByMe));
          likeLabel.textContent = `${data.likedByMe ? 'Liked' : '+1 Like'} · ${Number(updated.like_count) || 0}`;
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
          showToast(error.message || 'Like could not be saved.');
        } finally { resetTurnstile(); like.disabled = false; }
      });
      const share = make('button', 'sp-btn sp-btn-secondary');
      share.type = 'button'; share.append(svgIcon('share'), make('span', '', 'Share profile'));
      share.addEventListener('click', () => shareProfile(studentData));
      actions.append(like, share);
      main.append(actions);
      const stats = make('div', 'sp-profile-stats');
      [['Likes', studentData.like_count], ['Notes', studentData.note_count]].forEach(([label, value]) => {
        const stat = make('div', 'sp-profile-stat');
        const count = make('b', '', String(Number(value) || 0));
        if (label === 'Likes') count.id = 'profileLikeCount';
        stat.append(count, make('span', '', label));
        stats.append(stat);
      });
      main.append(stats);
      card.append(main);
      view.append(card);
      renderNotes(Array.isArray(data.notes) ? data.notes : []);
      noteWall.hidden = false;
      leaveNote.hidden = false;
      installTurnstile($('turnstileNote'));
      const form = $('noteForm');
      const textInput = $('noteText');
      const counter = $('noteCounter');
      const submit = $('noteSubmit');
      textInput.addEventListener('input', () => { counter.textContent = `${textInput.value.length} / 200`; });
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const text = textInput.value.trim();
        setMessage($('noteMessage'), '');
        if (!text) { setMessage($('noteMessage'), 'Write a note before sending.', 'error'); return; }
        submit.disabled = true; submit.textContent = 'Sending…';
        try {
          const token = await acquireTurnstile();
          const body = { text };
          if (token) body.turnstileToken = token;
          const response = await getJSON(`/api/spotlight/students/${encodeURIComponent(roll)}/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          setMessage($('noteMessage'), response.message || 'Your note will appear after review.', 'success');
          textInput.value = ''; counter.textContent = '0 / 200';
        } catch (error) { setMessage($('noteMessage'), error.message || 'Could not send your note.', 'error'); }
        finally { resetTurnstile(); submit.disabled = false; submit.textContent = 'Send for review'; }
      });
      notesList.addEventListener('click', async (event) => {
        const cardElement = event.target.closest('[data-note-id]');
        if (!cardElement) return;
        const noteId = cardElement.dataset.noteId;
        const reportButton = event.target.closest('[data-report]');
        if (reportButton) {
          if (!window.confirm('Report this note for review?')) return;
          reportButton.disabled = true;
          try {
            const reportResult = await getJSON(`/api/spotlight/notes/${encodeURIComponent(noteId)}/report`, { method: 'POST' });
            if (reportResult.success === false) throw new Error(reportResult.message || 'Could not report this note.');
            cardElement.remove();
            const currentNotes = Array.isArray(data.notes) ? data.notes : [];
            data.notes = currentNotes.filter((note) => String(note.id) !== String(noteId));
            renderNotes(data.notes);
            showToast('Note reported. Thank you.');
          } catch (error) { showToast(error.message || 'Could not report this note.'); reportButton.disabled = false; }
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
          showToast(error.message || 'Reaction could not be saved.');
          cardElement.querySelectorAll('[data-reaction]').forEach(button => { button.disabled = false; });
        } finally { reacting.delete(noteId); }
      });
    } catch (error) {
      profileFailure(error.status === 404 ? 'This profile is not available' : 'Could not open this profile', error.message || 'Try again in a moment.');
    }
  }

  function shareProfile(student) {
    const link = window.location.href;
    const message = `Check out ${student.name} on TKR Spotlight 💘 ${link}`;
    if (navigator.share) {
      navigator.share({ title: `${student.name} on TKR Spotlight`, text: message }).catch(() => {});
      return;
    }
    const host = $('shareDialogHost');
    host.replaceChildren();
    const overlay = make('div', 'sp-overlay');
    overlay.addEventListener('click', (event) => { if (event.target === overlay) overlay.remove(); });
    const dialog = make('section', 'sp-dialog');
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'shareHeading');
    dialog.append(make('h2', '', 'Share a good find'));
    const heading = dialog.lastChild; heading.id = 'shareHeading';
    dialog.append(make('p', '', 'Send this profile to someone who knows them.'));
    const options = make('div', 'sp-share-options');
    const whatsapp = make('a', 'sp-btn', 'WhatsApp');
    whatsapp.href = `https://wa.me/?text=${encodeURIComponent(message)}`;
    whatsapp.target = '_blank'; whatsapp.rel = 'noopener noreferrer';
    const copy = make('button', 'sp-btn sp-btn-secondary', 'Copy link');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(link); showToast('Profile link copied.'); overlay.remove(); }
      catch { showToast('Could not copy the link on this device.'); }
    });
    options.append(whatsapp, copy);
    dialog.append(options);
    const close = make('button', 'sp-quiet-link', 'Close');
    close.type = 'button'; close.style.marginTop = '10px'; close.addEventListener('click', () => overlay.remove());
    dialog.append(close); overlay.append(dialog); host.append(overlay);
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
      if (error.status === 401) { showLogin('Your admin session ended. Sign in again.'); return; }
      setMessage($('adminError'), error.message || 'The request could not be completed.', 'error');
    };
    const loadQueue = async () => {
      content.replaceChildren(make('div', 'sp-skeleton'), make('div', 'sp-skeleton'), make('div', 'sp-skeleton'));
      try {
        const data = await getJSON('/api/spotlight/admin/queue');
        state.queue = { pending: Array.isArray(data.pending) ? data.pending : [], reported: Array.isArray(data.reported) ? data.reported : [] };
        $('pendingBadge').textContent = String(state.queue.pending.length);
        renderAdminContent();
      } catch (error) { handleAdminError(error); }
    };
    const renderAdminContent = () => {
      content.replaceChildren();
      setMessage($('adminError'), '');
      if (state.tab === 'students') {
        const inputWrap = make('div', 'sp-admin-search');
        const search = document.createElement('input');
        search.type = 'search'; search.className = 'sp-input'; search.style.paddingLeft = '14px';
        search.placeholder = 'Search all students by name or roll number';
        search.value = state.search;
        search.setAttribute('aria-label', 'Search students by name or roll number');
        inputWrap.append(search);
        content.append(inputWrap);
        const hint = make('p', 'sp-section-caption', 'Search returns up to 50 matching students. Hidden profiles remain out of public view.');
        content.append(hint);
        if (!state.search) {
          const info = make('div', 'sp-state');
          info.append(make('strong', '', 'Find a student to manage visibility'), make('span', '', 'Start typing a name or roll number.'));
          content.append(info);
        } else if (!state.students.length) {
          const empty = make('div', 'sp-state');
          empty.append(make('strong', '', 'No matching students'), make('span', '', 'Try a shorter name or another roll number.'));
          content.append(empty);
        } else {
          state.students.forEach((student) => {
            const row = make('div', 'sp-hidden-row');
            const copy = make('div', 'sp-student-copy');
            copy.append(make('div', 'sp-student-name', student.name || 'Student'));
            copy.append(make('div', 'sp-student-meta', `${student.roll_number || ''} · ${campusLine(student)}`));
            if (student.hidden) copy.append(make('span', 'sp-badge', 'Hidden'));
            const button = make('button', `sp-btn ${student.hidden ? 'sp-btn-secondary' : 'sp-btn-danger'}`, student.hidden ? 'Unhide' : 'Hide');
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
        empty.append(make('strong', '', state.tab === 'pending' ? 'Nothing waiting for review' : 'No reported notes'), make('span', '', state.tab === 'pending' ? 'New notes will appear here when students send them.' : 'Reported notes will appear here for a second look.'));
        content.append(empty); return;
      }
      notes.forEach((note) => {
        const article = make('article', 'sp-admin-note');
        const meta = make('div', 'sp-admin-meta');
        const nameLine = make('div');
        const name = make('b', '', note.name || 'Student');
        nameLine.append(name, document.createTextNode(` · ${note.roll_number || ''}`));
        meta.append(nameLine, make('div', '', `${campusLine(note)} · ${formatDate(note.created_at)}`));
        if (note.status) meta.append(make('div', '', `Status: ${note.status}${note.reported ? ' · Reported' : ''}`));
        article.append(meta, make('div', 'sp-admin-text', note.text || ''));
        const actions = make('div', 'sp-admin-actions');
        const addAction = (label, action, style, confirmMessage) => {
          const button = make('button', `sp-btn ${style}`, label);
          button.type = 'button';
          button.addEventListener('click', async () => {
            if (confirmMessage && !window.confirm(confirmMessage)) return;
            button.disabled = true;
            try {
              const result = await getJSON(`/api/spotlight/admin/notes/${encodeURIComponent(note.id)}/${action}`, { method: 'POST' });
              if (result.success === false) throw new Error(result.message || 'That action could not be completed.');
              await loadQueue();
              showToast(action === 'approve' ? 'Note approved.' : action === 'keep' ? 'Note restored.' : 'Note removed.');
            } catch (error) { button.disabled = false; handleAdminError(error); }
          });
          actions.append(button);
        };
        if (state.tab === 'pending') {
          addAction('Approve', 'approve', 'sp-btn-approve');
          addAction('Reject', 'reject', 'sp-btn-danger', 'Reject this note? It will be permanently removed.');
        } else {
          addAction('Keep note', 'keep', 'sp-btn-keep');
          addAction('Delete', 'delete', 'sp-btn-danger', 'Delete this reported note permanently?');
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
      if (!password) { setMessage($('adminLoginError'), 'Enter the admin password.', 'error'); return; }
      button.disabled = true; button.textContent = 'Signing in…';
      try {
        const result = await getJSON('/api/spotlight/admin/login', { method: 'POST', headers: { 'x-admin-password': password } });
        if (result.success !== true) throw new Error(result.message || 'Could not sign in.');
        loginView.hidden = true;
        adminView.hidden = false;
        $('adminPassword').value = '';
        await loadQueue();
      } catch (error) { setMessage($('adminLoginError'), error.message || 'Could not sign in.', 'error'); }
      finally { button.disabled = false; button.textContent = 'Open review desk'; $('adminPassword').value = ''; }
    });
    $('adminLogout').addEventListener('click', async () => {
      try { await getJSON('/api/spotlight/admin/logout', { method: 'POST' }); }
      catch (error) { if (error.status !== 401) setMessage($('adminError'), error.message, 'error'); }
      state.queue = { pending: [], reported: [] }; state.students = [];
      showLogin('You have signed out.');
    });
    $('adminTabs').addEventListener('click', (event) => {
      const tab = event.target.closest('[data-admin-tab]');
      if (!tab) return;
      state.tab = tab.dataset.adminTab;
      $('adminTabs').querySelectorAll('[data-admin-tab]').forEach((button) => button.setAttribute('aria-selected', String(button === tab)));
      if (state.tab === 'students') renderAdminContent();
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
        if (result.success === false) throw new Error(result.message || 'Profile visibility could not be changed.');
        await loadStudents();
        showToast(action === 'hide' ? 'Profile hidden from public view.' : 'Profile is visible again.');
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
      if (error.status !== 401) setMessage($('adminLoginError'), error.message || 'Could not check the admin session.', 'error');
    });
  }

  const page = document.body.dataset.spotlightPage;
  if (page === 'directory') startDirectory();
  if (page === 'profile') startProfile();
  if (page === 'admin') startAdmin();
})();
