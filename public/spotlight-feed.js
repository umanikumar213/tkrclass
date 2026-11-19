(() => {
  'use strict';

  window.startSpotlightNotesFeed = async function startSpotlightNotesFeed({
    $, make, t, copyText, getJSON, makeAvatar, profileLink, campusLine, showToast, spotlightUI,
  }) {
    const list = $('notesFeed');
    const more = $('notesFeedMore');
    const controls = $('notesFeedControls');
    const sentinel = $('notesFeedSentinel');
    const newNotes = $('notesFeedNew');
    const state = { notes: [], ids: new Set(), cursor: null, hasMore: true, loading: false, blocked: false, requestId: 0, controller: null, seenCursors: new Set() };
    const reacting = new Set();
    const reportedStorageKey = 'spotlight-reported-notes';
    let locallyReported = new Set();
    try {
      const saved = JSON.parse(localStorage.getItem(reportedStorageKey) || '[]');
      if (Array.isArray(saved)) locallyReported = new Set(saved.filter((id) => (typeof id === 'string' || typeof id === 'number') && /^\d{1,20}$/.test(String(id))).map(String));
    } catch { /* The feed remains usable when local storage is unavailable. */ }
    const persistReported = (id) => {
      if (!/^\d{1,20}$/.test(String(id))) return;
      locallyReported.add(String(id));
      try { localStorage.setItem(reportedStorageKey, JSON.stringify([...locallyReported])); } catch { /* Reporting still succeeds if local storage is unavailable. */ }
    };
    const reactionButton = (note, type, labelKey, emojiKey, countKey) => {
      const count = Number(note[countKey]) || 0;
      const button = make('button', `sp-action${note.myReaction === type ? ' is-selected' : ''}`);
      button.type = 'button';
      button.disabled = reacting.has(String(note.id));
      button.dataset.reaction = type;
      button.setAttribute('aria-label', copyText('reaction_aria', { label: t(labelKey), count }));
      button.append(make('span', '', t(emojiKey)), make('span', '', String(count)));
      return button;
    };
    const buildCard = (note) => {
      const card = make('article', 'sp-feed-note');
      card.dataset.noteId = String(note.id);
      const studentLink = make('a', 'sp-feed-student');
      studentLink.href = profileLink(note.student?.roll_number);
      studentLink.append(makeAvatar(note.student || {}, false, 40));
      const studentCopy = make('span', 'sp-feed-student-copy');
      studentCopy.append(
        make('span', 'sp-feed-student-name', note.student?.name || t('student_fallback')),
        make('span', 'sp-feed-student-meta', campusLine(note.student || {})),
      );
      studentLink.append(studentCopy);
      card.append(studentLink, make('div', 'sp-note-text', note.text || ''));
      const footer = make('div', 'sp-note-footer');
      const reactions = make('div', 'sp-reactions');
      reactions.append(
        reactionButton(note, 'heart', 'reaction_heart_label', 'notes_feed_heart_emoji', 'react_heart'),
        reactionButton(note, 'laugh', 'reaction_laugh_label', 'reaction_laugh', 'react_laugh'),
        reactionButton(note, 'fire', 'reaction_fire_label', 'reaction_fire', 'react_fire'),
      );
      const tools = make('div', 'sp-feed-tools');
      tools.append(make('time', 'sp-time', spotlightUI.relativeTime(note.approved_at)));
      const report = make('button', 'sp-action sp-report', t('report_menu_icon'));
      report.type = 'button';
      report.dataset.reportMenu = 'true';
      report.setAttribute('aria-label', t('report_menu_aria'));
      report.setAttribute('aria-expanded', 'false');
      if (locallyReported.has(String(note.id))) {
        report.disabled = true;
        report.setAttribute('aria-label', t('report_already_sent'));
      }
      const menu = make('div', 'sp-report-menu');
      menu.hidden = true;
      const reportAction = make('button', 'sp-action sp-report-action', t('report_label'));
      reportAction.type = 'button';
      reportAction.dataset.report = 'true';
      if (locallyReported.has(String(note.id))) {
        reportAction.disabled = true;
        reportAction.setAttribute('aria-label', t('report_already_sent'));
      }
      menu.append(reportAction);
      tools.append(report, menu);
      footer.append(reactions, tools);
      card.append(footer);
      return card;
    };
    const setLoadingSkeletons = (append) => {
      const skeletons = make('div', 'sp-feed-skeletons');
      skeletons.dataset.feedSkeletons = 'true';
      for (let index = 0; index < (append ? 2 : 3); index += 1) skeletons.append(make('div', 'sp-feed-skeleton'));
      if (append) list.append(skeletons);
      else list.replaceChildren(skeletons);
    };
    const drawEnd = () => {
      list.querySelector('[data-feed-end]')?.remove();
      if (!state.hasMore && state.notes.length) {
        const end = make('div', 'sp-feed-end', t('notes_feed_end'));
        end.dataset.feedEnd = 'true';
        list.append(end);
      }
    };
    const drawEmpty = () => {
      const empty = make('div', 'sp-state');
      empty.append(make('strong', '', t('notes_feed_empty')));
      list.replaceChildren(empty);
    };
    const syncControls = () => {
      controls.hidden = !state.notes.length || (!state.hasMore && !state.blocked);
      more.hidden = !state.notes.length || (!state.hasMore && !state.blocked);
      more.disabled = state.loading;
      more.textContent = state.loading ? t('notes_feed_loading') : t('notes_feed_more');
    };
    async function loadPage(append = false, refresh = false) {
      if (state.loading || (append && (!state.hasMore || state.blocked))) return;
      const cursor = append ? state.cursor : null;
      if (cursor && state.seenCursors.has(cursor)) return;
      state.loading = true;
      state.blocked = false;
      const requestId = ++state.requestId;
      const controller = new AbortController();
      state.controller = controller;
      if (!append) {
        state.notes = [];
        state.ids.clear();
        state.seenCursors.clear();
        state.cursor = null;
        setLoadingSkeletons(false);
      }
      else {
        list.querySelector('[data-feed-error]')?.remove();
        setLoadingSkeletons(true);
      }
      syncControls();
      const params = new URLSearchParams({ limit: '20' });
      if (cursor) params.set('cursor', cursor);
      try {
        const result = await getJSON(`/api/spotlight/notes/feed?${params}`, {
          signal: controller.signal, ...(refresh ? { headers: { 'Cache-Control': 'no-cache' } } : {}),
        });
        if (requestId !== state.requestId) return;
        list.querySelector('[data-feed-skeletons]')?.remove();
        const items = Array.isArray(result.notes) ? result.notes : [];
        if (!append) {
          state.notes = [];
          state.ids.clear();
          state.seenCursors.clear();
          list.replaceChildren();
        }
        items.forEach((note) => {
          const id = String(note.id);
          if (state.ids.has(id)) return;
          state.ids.add(id);
          state.notes.push(note);
          list.append(buildCard(note));
        });
        if (!append && !items.length) {
          state.cursor = null;
          state.hasMore = false;
          drawEmpty();
        } else {
          state.cursor = result.nextCursor || null;
          state.hasMore = Boolean(state.cursor) && items.length > 0 && state.cursor !== cursor;
          if (cursor) state.seenCursors.add(cursor);
          drawEnd();
        }
      } catch (error) {
        if (requestId !== state.requestId || error.name === 'AbortError') return;
        state.blocked = true;
        list.querySelector('[data-feed-skeletons]')?.remove();
        if (!append && !state.notes.length) list.replaceChildren();
        const failed = make('div', 'sp-state');
        failed.dataset.feedError = 'true';
        failed.append(make('strong', '', t('notes_feed_error')));
        const retry = make('button', 'sp-btn sp-btn-secondary', t('notes_feed_retry'));
        retry.type = 'button';
        retry.style.marginTop = '12px';
        retry.addEventListener('click', () => { state.blocked = false; loadPage(append, refresh); });
        failed.append(retry);
        list.append(failed);
      } finally {
        if (requestId === state.requestId) {
          state.loading = false;
          state.controller = null;
          syncControls();
        }
      }
    }
    const tupleAfter = (candidate, current) => {
      if (!current) return true;
      const candidateTime = String(candidate.approved_at || '');
      const currentTime = String(current.approved_at || '');
      if (candidateTime !== currentTime) return candidateTime > currentTime;
      try { return BigInt(candidate.id) > BigInt(current.id); } catch { return Number(candidate.id) > Number(current.id); }
    };
    let probing = false;
    const probeNewNotes = async () => {
      if (document.hidden || state.loading || probing) return;
      probing = true;
      try {
        const result = await getJSON('/api/spotlight/notes/feed?limit=1', { headers: { 'Cache-Control': 'no-cache' } });
        const latest = Array.isArray(result.notes) ? result.notes[0] : null;
        if (latest && tupleAfter(latest, state.notes[0])) newNotes.hidden = false;
      } catch { /* A visibility probe is opportunistic; the feed remains available. */ }
      finally { probing = false; }
    };
    const refreshTop = () => {
      state.controller?.abort();
      state.requestId += 1;
      state.loading = false;
      state.blocked = false;
      state.cursor = null;
      state.hasMore = true;
      state.seenCursors.clear();
      newNotes.hidden = true;
      loadPage(false, true);
    };
    newNotes.addEventListener('click', refreshTop);
    more.addEventListener('click', () => {
      if (state.blocked) state.blocked = false;
      loadPage(true);
    });
    list.addEventListener('click', async (event) => {
      const card = event.target.closest('[data-note-id]');
      if (!card) return;
      const noteId = card.dataset.noteId;
      const reportButton = event.target.closest('[data-report]');
      if (reportButton) {
        if (reportButton.disabled || locallyReported.has(String(noteId))) return;
        if (!(await spotlightUI.confirm(t('report_confirm')))) return;
        reportButton.disabled = true;
        try {
          const response = await getJSON(`/api/spotlight/notes/${encodeURIComponent(noteId)}/report`, { method: 'POST' });
          if (response.success === false) throw new Error(response.message || t('report_failed'));
          persistReported(noteId);
          const actionButton = card.querySelector('[data-report]');
          if (actionButton) {
            actionButton.disabled = true;
            actionButton.setAttribute('aria-label', t('report_already_sent'));
          }
          const menuButton = card.querySelector('[data-report-menu]');
          if (menuButton) {
            menuButton.disabled = true;
            menuButton.setAttribute('aria-label', t('report_already_sent'));
          }
          card.querySelector('.sp-report-menu').hidden = true;
          menuButton?.setAttribute('aria-expanded', 'false');
          showToast(t('note_reported_thanks'));
        } catch (error) {
          showToast(error.message || t('report_failed'));
          reportButton.disabled = false;
        }
        return;
      }
      const menuButton = event.target.closest('[data-report-menu]');
      if (menuButton) {
        const menu = card.querySelector('.sp-report-menu');
        const opening = menu.hidden;
        list.querySelectorAll('.sp-report-menu').forEach((entry) => { entry.hidden = true; });
        list.querySelectorAll('[data-report-menu]').forEach((entry) => entry.setAttribute('aria-expanded', 'false'));
        menu.hidden = !opening;
        menuButton.setAttribute('aria-expanded', String(opening));
        return;
      }
      const reaction = event.target.closest('[data-reaction]');
      if (!reaction || reaction.disabled || reacting.has(noteId)) return;
      const kind = reaction.dataset.reaction;
      reacting.add(noteId);
      reaction.disabled = true;
      card.querySelectorAll('[data-reaction]').forEach((button) => { button.disabled = true; });
      try {
        const result = await getJSON(`/api/spotlight/notes/${encodeURIComponent(noteId)}/react`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emoji: kind }),
        });
        const note = state.notes.find((item) => String(item.id) === String(noteId));
        if (note) {
          note.react_heart = result.counts?.heart ?? result.counts?.react_heart ?? note.react_heart;
          note.react_laugh = result.counts?.laugh ?? result.counts?.react_laugh ?? note.react_laugh;
          note.react_fire = result.counts?.fire ?? result.counts?.react_fire ?? note.react_fire;
          note.myReaction = result.myReaction || null;
          const replacement = buildCard(note);
          list.querySelector(`[data-note-id="${noteId}"]`)?.replaceWith(replacement);
        }
      } catch (error) {
        showToast(error.message || t('reaction_failed'));
        card.querySelectorAll('[data-reaction]').forEach((button) => { button.disabled = false; });
      } finally {
        reacting.delete(noteId);
        list.querySelector(`[data-note-id="${noteId}"]`)?.querySelectorAll('[data-reaction]').forEach(button => { button.disabled = false; });
      }
    });
    let feedObserver = null;
    if ('IntersectionObserver' in window) {
      feedObserver = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting) && state.hasMore && !state.loading && !state.blocked) loadPage(true);
      }, { rootMargin: '320px 0px' });
      feedObserver.observe(sentinel);
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) probeNewNotes(); });
    document.title = t('notes_feed_page_title');
    await loadPage(false);
  };
})();
