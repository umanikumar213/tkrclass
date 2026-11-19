(() => {
  'use strict';

  window.createSpotlightUI = function createSpotlightUI({ t, copyText }) {
    const setupLight = () => {
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.content = '#f4f3fa';
    };

    const confirm = (message, { title } = {}) => new Promise((resolve) => {
      const dialog = document.getElementById('spotlightConfirmDialog');
      if (!dialog || typeof dialog.showModal !== 'function') {
        resolve(false);
        return;
      }
      const messageNode = document.getElementById('confirmDialogMessage');
      const titleNode = document.getElementById('confirmDialogTitle');
      const accept = dialog.querySelector('[data-confirm-accept]');
      const cancel = dialog.querySelector('[data-confirm-cancel]');
      const previousFocus = document.activeElement;
      if (titleNode && title) titleNode.textContent = title;
      if (messageNode) messageNode.textContent = message;

      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        dialog.close();
        accept.removeEventListener('click', onAccept);
        cancel.removeEventListener('click', onCancel);
        dialog.removeEventListener('click', onBackdrop);
        dialog.removeEventListener('cancel', onDialogCancel);
        previousFocus?.focus?.();
        resolve(result);
      };
      const onAccept = () => finish(true);
      const onCancel = () => finish(false);
      const onBackdrop = (event) => {
        if (event.target === dialog) finish(false);
      };
      const onDialogCancel = (event) => {
        event.preventDefault();
        finish(false);
      };

      accept.addEventListener('click', onAccept);
      cancel.addEventListener('click', onCancel);
      dialog.addEventListener('click', onBackdrop);
      dialog.addEventListener('cancel', onDialogCancel);
      dialog.showModal();
      cancel.focus();
    });

    const relativeTime = (value) => {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
      if (minutes < 1) return t('time_just_now');
      if (minutes < 60) return copyText('time_minutes_ago', { count: minutes });
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return copyText('time_hours_ago', { count: hours });
      const days = Math.floor(hours / 24);
      if (days < 7) return copyText('time_days_ago', { count: days });
      return date.toLocaleString('en-IN', {
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
      });
    };

    return { setupLight, confirm, relativeTime };
  };
})();
