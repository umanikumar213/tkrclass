(() => {
  'use strict';
  window.createSpotlightEditor = function createSpotlightEditor({ content, t, copyText, make, getJSON, showToast, setAdminError, refreshPublicCopy }) {
    let settings = null;
    let changes = {};
    let saving = false;
    let loading = false;
    const fieldCurrent = (field) => {
      if (!Object.prototype.hasOwnProperty.call(changes, field.key)) return field.value;
      return changes[field.key] === null ? field.defaultValue : changes[field.key];
    };
    const formatValue = (field, value) => {
      if (field.type === 'boolean') return t(value ? 'settings_boolean_on' : 'settings_boolean_off');
      if (Array.isArray(value)) return value.join(', ');
      return String(value ?? '');
    };
    const setChange = (key, value, original) => {
      if (JSON.stringify(value) === JSON.stringify(original)) delete changes[key];
      else changes[key] = value;
      const saveButton = content.querySelector('.sp-settings-save');
      if (saveButton) saveButton.disabled = saving || !Object.keys(changes).length;
    };
    const render = () => {
      content.replaceChildren();
      const data = settings;
      if (!data || !Array.isArray(data.fields)) return;
      const preview = make('a', 'sp-quiet-link', t('settings_preview'));
      preview.href = '/spotlight';
      preview.target = '_blank';
      preview.rel = 'noopener noreferrer';
      content.append(preview);
      const byGroup = new Map();
      data.fields.forEach((field) => {
        const group = field.group || 'Other';
        if (!byGroup.has(group)) byGroup.set(group, []);
        byGroup.get(group).push(field);
      });
      byGroup.forEach((fields, groupName) => {
        const section = make('section', 'sp-settings-group');
        const groupKey = `group_${String(groupName).toLowerCase().replace(/[^a-z]+/g, '_')}`;
        section.append(make('h2', 'sp-section-title', t(groupKey) || groupName));
        fields.forEach((field) => {
          const row = make('div', 'sp-settings-field');
          const labelText = t(`setting_label_${field.key}`) || copyText('setting_field_label', { key: field.key });
          const label = make('label', 'sp-settings-label', labelText);
          const current = fieldCurrent(field);
          let control;
          if (field.type === 'boolean') {
            control = document.createElement('input');
            control.type = 'checkbox';
            control.checked = Boolean(current);
            control.setAttribute('role', 'switch');
            control.addEventListener('change', () => {
              setChange(field.key, control.checked, field.value);
              const currentLabel = row.querySelector('.sp-settings-current');
              if (currentLabel) currentLabel.textContent = `${t('settings_current')}: ${formatValue(field, control.checked)}`;
            });
          } else if (field.type === 'years') {
            control = make('fieldset', 'sp-settings-years');
            control.setAttribute('aria-label', copyText('settings_text_aria', { label: labelText }));
            const values = Array.isArray(current) ? current : [];
            const choices = [...new Set([...(Array.isArray(data.years) ? data.years : []), ...(Array.isArray(field.defaultValue) ? field.defaultValue : []), ...values])];
            choices.forEach((year) => {
              const optionLabel = make('label', 'sp-settings-check');
              const checkbox = document.createElement('input');
              checkbox.type = 'checkbox';
              checkbox.checked = values.includes(year);
              checkbox.disabled = saving;
              checkbox.dataset.year = year;
              checkbox.setAttribute('aria-label', copyText('setting_year_checkbox_aria', { year }));
              checkbox.addEventListener('change', () => {
                const next = Array.from(control.querySelectorAll('input[type=checkbox]')).filter((item) => item.checked).map((item) => item.dataset.year);
                setChange(field.key, next, field.value);
                const currentLabel = row.querySelector('.sp-settings-current');
                if (currentLabel) currentLabel.textContent = `${t('settings_current')}: ${next.join(', ')}`;
              });
              optionLabel.append(checkbox, document.createTextNode(year));
              control.append(optionLabel);
            });
          } else if (field.type === 'number') {
            control = document.createElement('input');
            control.type = 'number';
            control.className = 'sp-input sp-settings-input';
            control.step = '1';
            if (field.min != null) control.min = String(field.min);
            if (field.max != null) control.max = String(field.max);
            control.value = current == null ? '' : String(current);
            control.addEventListener('input', () => {
              const value = control.value === '' ? '' : Number(control.value);
              setChange(field.key, value, field.value);
              const currentLabel = row.querySelector('.sp-settings-current');
              if (currentLabel) currentLabel.textContent = `${t('settings_current')}: ${String(value)}`;
            });
          } else {
            control = field.maxLength > 240 ? document.createElement('textarea') : document.createElement('input');
            control.className = field.maxLength > 240 ? 'sp-textarea sp-settings-input' : 'sp-input sp-settings-input';
            if (control.tagName === 'INPUT') control.type = 'text';
            control.maxLength = Number(field.maxLength) || 300;
            control.value = current == null ? '' : String(current);
            control.addEventListener('input', () => {
              setChange(field.key, control.value, field.value);
              const currentLabel = row.querySelector('.sp-settings-current');
              if (currentLabel) currentLabel.textContent = `${t('settings_current')}: ${control.value}`;
              const counter = row.querySelector('[data-char-counter]');
              if (counter) counter.textContent = copyText('setting_counter', { count: control.value.length, max: control.maxLength });
            });
          }
          control.disabled = saving;
          if (field.type !== 'years') label.htmlFor = `setting-${field.key}`;
          control.id = `setting-${field.key}`;
          row.append(label, control);
          row.append(make('div', 'sp-settings-current', `${t('settings_current')}: ${formatValue(field, current)}`));
          row.append(make('div', 'sp-settings-default', copyText('setting_default_placeholder', { value: formatValue(field, field.defaultValue) })));
          if (field.type === 'text') {
            const counter = make('div', 'sp-settings-counter', copyText('setting_counter', { count: String(current ?? '').length, max: Number(field.maxLength) || 300 }));
            counter.dataset.charCounter = 'true';
            row.append(counter);
          } else if (field.type === 'years') row.append(make('p', 'sp-settings-default', t('settings_years_hint')));
          const reset = make('button', 'sp-quiet-link sp-settings-reset', t('settings_reset'));
          reset.type = 'button';
          reset.disabled = saving;
          reset.addEventListener('click', () => {
            setChange(field.key, null, field.value);
            const updated = changes[field.key] === null ? field.defaultValue : field.value;
            if (field.type === 'boolean') control.checked = Boolean(updated);
            else if (field.type === 'years') {
              const selected = Array.isArray(updated) ? updated : [];
              control.querySelectorAll('input[type=checkbox]').forEach((checkbox) => { checkbox.checked = selected.includes(checkbox.dataset.year); });
            } else {
              control.value = updated == null ? '' : Array.isArray(updated) ? updated.join(', ') : String(updated);
              const counter = row.querySelector('[data-char-counter]');
              if (counter) counter.textContent = copyText('setting_counter', { count: control.value.length, max: control.maxLength });
            }
            const currentLabel = row.querySelector('.sp-settings-current');
            if (currentLabel) currentLabel.textContent = `${t('settings_current')}: ${formatValue(field, updated)}`;
          });
          row.append(reset);
          section.append(row);
        });
        content.append(section);
      });
      const footer = make('div', 'sp-settings-footer');
      const save = make('button', 'sp-btn sp-settings-save', saving ? t('settings_saving') : t('settings_save'));
      save.type = 'button';
      save.disabled = saving || !Object.keys(changes).length;
      save.addEventListener('click', saveChanges);
      footer.append(save);
      content.append(footer);
    };
    const saveChanges = async () => {
      if (saving || !settings || !Object.keys(changes).length) return;
      const fields = settings.fields;
      const invalid = fields.some((field) => {
        if (!Object.prototype.hasOwnProperty.call(changes, field.key)) return false;
        const value = changes[field.key];
        if (value === null) return false;
        if (field.type === 'number') return !Number.isInteger(value) || (field.min != null && value < field.min) || (field.max != null && value > field.max);
        if (field.type === 'boolean') return typeof value !== 'boolean';
        if (field.type === 'years') {
          const allowed = [...new Set([...(settings.years || []), ...(Array.isArray(field.defaultValue) ? field.defaultValue : [])])];
          return !Array.isArray(value) || value.some((year) => !allowed.includes(year));
        }
        return typeof value !== 'string' || value.length > field.maxLength;
      });
      if (invalid) {
        setAdminError(t('settings_validation'));
        return;
      }
      const changesToSave = { ...changes };
      let saveError = null;
      saving = true;
      render();
      try {
        const result = await getJSON('/api/spotlight/admin/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ changes: changesToSave }),
        });
        if (result.success !== true) throw new Error(result.message || t('request_failed'));
        await refreshPublicCopy();
        settings = await getJSON('/api/spotlight/admin/settings');
        changes = {};
        showToast(t('settings_saved'));
      } catch (error) {
        saveError = error;
      } finally {
        saving = false;
        render();
        if (saveError) setAdminError(saveError.message || t('request_failed'), saveError);
      }
    };
    const load = async () => {
      loading = true;
      content.replaceChildren(make('div', 'sp-skeleton'), make('div', 'sp-skeleton'));
      try {
        settings = await getJSON('/api/spotlight/admin/settings');
        changes = {};
        render();
      } catch (error) {
        content.replaceChildren();
        const failed = make('div', 'sp-state');
        failed.append(make('strong', '', t('settings_load_error')), make('span', '', error.message || t('request_failed')));
        const retry = make('button', 'sp-btn sp-btn-secondary', t('settings_retry'));
        retry.type = 'button';
        retry.addEventListener('click', load);
        failed.append(retry);
        content.append(failed);
        setAdminError(error.message || t('request_failed'), error);
      } finally {
        loading = false;
      }
    };
    return {
      load,
      render,
      hasDirty: () => Object.keys(changes).length > 0,
      isSaving: () => saving,
      isLoading: () => loading,
      discard: () => { changes = {}; },
    };
  };
})();
