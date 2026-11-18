document.addEventListener('DOMContentLoaded', () => {
  let allRecords = [];
  let selectedTags = {};        // Stocke les sélections multiples (tags + colonnes texte en mode multi)
  let selectedTexts = {};       // Stocke le texte de recherche par colonne
  let textModes = {};           // 'multi' | 'search' | 'dropdown' | 'both'
  let selectEls = {};
  let textEls = {};
  const STORAGE_KEY = 'grist_filters_state_v2';
  const DROPDOWN_THRESHOLD = 10;
  let tagColumns = {};
  let selectColumns = {};
  let textColumns = {};
  let visibleFilters = { tags: true };
  let columnsOrder = [];

  const tagContainer = document.getElementById('tag-filters');
  const textContainer = document.getElementById('text-filters');
  const selectContainer = document.getElementById('dynamic-filters');
  const globalSearch = document.getElementById('global-search');
  const resultsCount = document.getElementById('results-count');
  const resetButton = document.getElementById('reset-filters');
  const manageFiltersBtn = document.getElementById('manage-filters-btn');
  const filterModal = document.getElementById('filter-modal');
  const closeModalBtn = document.getElementById('close-modal');
  const filterCheckboxesContainer = document.getElementById('filter-checkboxes');
  const selectAllBtn = document.getElementById('select-all');
  const deselectAllBtn = document.getElementById('deselect-all');

  document.addEventListener('click', (e) => {
    document.querySelectorAll('.dd-panel').forEach(panel => {
      if (!panel.parentElement.contains(e.target)) panel.style.display = 'none';
    });
  });

  const cleanVal = (v) => {
    if (Array.isArray(v)) {
      return v.filter(x => x !== 'L' && x !== null && x !== undefined && x !== '');
    }
    return v !== null && v !== undefined && String(v) !== '' ? [String(v)] : [];
  };

  const sortAlphaNum = (arr) => arr.sort((a, b) => a.localeCompare(b, undefined, {
    numeric: true, sensitivity: 'base'
  }));

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      selectedTags, selectedTexts, textModes, selectEls: serializeSelects(), visibleFilters
    }));
  }

  async function fetchColumnsAndTypes(records) {
    const colTable = await grist.docApi.fetchTable('_grist_Tables_column');
    const tableRef = await grist.docApi.fetchTable('_grist_Tables');

    let tableId;
    try {
      tableId = await grist.selectedTable.getTableId();
    } catch {
      try {
        tableId = await grist.getOption('tableId');
      } catch {
        console.error('Impossible de récupérer le tableId.');
        return;
      }
    }

    if (!tableId) return;
    const tableIdx = tableRef.tableId.indexOf(tableId);
    if (tableIdx === -1) return;
    const parentRef = tableRef.id[tableIdx];

    const recordKeys = records && records.length > 0 ? new Set(Object.keys(records[0])) : null;

    colTable.parentId.forEach((pid, i) => {
      if (pid !== parentRef) return;
      const colId = colTable.colId[i];
      const label = colTable.label[i] || colId;
      const type  = colTable.type[i];
      if (!colId || colId.startsWith('gristHelper') || colId === 'manualSort') return;
      if (colTable.isHiddenCol && colTable.isHiddenCol[i]) return;
      if (recordKeys && !recordKeys.has(colId)) return;

      if (type === 'Choice' || type.startsWith('Ref:')) {
        selectColumns[colId] = label;
      } else if (type === 'ChoiceList' || type.startsWith('RefList:')) {
        tagColumns[colId] = label;
      } else if (type === 'Text' || type === 'Note') {
        textColumns[colId] = label;
      }
    });

    if (records && records.length > 0) {
      const hasValues = (col) => records.some(r => cleanVal(r[col]).length > 0);
      Object.keys(selectColumns).forEach(col => { if (!hasValues(col)) delete selectColumns[col]; });
      Object.keys(tagColumns).forEach(col => { if (!hasValues(col)) delete tagColumns[col]; });
      Object.keys(textColumns).forEach(col => {
        if (!records.some(r => r[col] !== null && r[col] !== undefined && String(r[col]) !== '')) delete textColumns[col];
      });
    }

    Object.keys(selectColumns).forEach(col => {
      if (visibleFilters[col] === undefined) visibleFilters[col] = true;
    });
    Object.keys(tagColumns).forEach(col => {
      if (visibleFilters[col] === undefined) visibleFilters[col] = true;
    });
    Object.keys(textColumns).forEach(col => {
      if (visibleFilters[col] === undefined) visibleFilters[col] = true;
      // Par défaut : Multi-sélection avec cases à cocher !
      if (textModes[col] === undefined) textModes[col] = 'multi';
    });
  }

  function countValues(records, col) {
    const counts = {};
    records.forEach(r => {
      cleanVal(r[col]).forEach(v => {
        counts[v] = (counts[v] || 0) + 1;
      });
    });
    return counts;
  }

  function initOrder() {
    const allCols = [
      ...Object.keys(tagColumns).map(col => ({ col, type: 'tag' })),
      ...Object.keys(selectColumns).map(col => ({ col, type: 'select' })),
      ...Object.keys(textColumns).map(col => ({ col, type: 'text' })),
    ];
    const savedOrder = visibleFilters.order || [];
    const existing = new Set(savedOrder.map(o => o.col));
    columnsOrder = [
      ...savedOrder.filter(o => allCols.some(c => c.col === o.col)),
      ...allCols.filter(c => !existing.has(c.col)),
    ];
    visibleFilters.order = columnsOrder;
  }

  function applyOrder() {
    initOrder();
    renderTags(allRecords);
    renderSelects(allRecords);
    renderTexts(allRecords);
  }

  // Crée un menu déroulant à cases à cocher réutilisable (pour tags et colonnes texte en mode multi)
  function createMultiDropdown(col, uniqueValues, counts) {
    if (!selectedTags[col]) selectedTags[col] = [];

    const dd = document.createElement('div');
    dd.className = 'tag-dropdown';

    const ddToggle = document.createElement('button');
    ddToggle.type = 'button';
    ddToggle.className = 'dd-toggle';

    const updateToggleText = () => {
      const sel = selectedTags[col] || [];
      if (sel.length === 0) {
        ddToggle.innerHTML = '<span>— Tous —</span><span>▾</span>';
        ddToggle.classList.remove('has-selection');
      } else if (sel.length <= 2) {
        ddToggle.innerHTML = `<span>${sel.join(', ')}</span><span>▾</span>`;
        ddToggle.classList.add('has-selection');
      } else {
        ddToggle.innerHTML = `<span>${sel.length} sélectionnés</span><span>▾</span>`;
        ddToggle.classList.add('has-selection');
      }
    };

    const panel = document.createElement('div');
    panel.className = 'dd-panel';
    panel.style.display = 'none';

    const ddSearch = document.createElement('input');
    ddSearch.type = 'text';
    ddSearch.className = 'dd-search';
    ddSearch.placeholder = 'Filtrer la liste...';
    ddSearch.addEventListener('input', () => {
      const q = ddSearch.value.toLowerCase();
      panel.querySelectorAll('.dd-option').forEach(o => {
        o.style.display = o.dataset.value.toLowerCase().includes(q) ? 'flex' : 'none';
      });
    });
    panel.appendChild(ddSearch);

    uniqueValues.forEach(val => {
      const opt = document.createElement('label');
      opt.className = 'dd-option';
      opt.dataset.value = val;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selectedTags[col].includes(val);
      cb.addEventListener('change', () => {
        if (cb.checked) {
          if (!selectedTags[col].includes(val)) selectedTags[col].push(val);
        } else {
          selectedTags[col] = selectedTags[col].filter(v => v !== val);
        }
        updateToggleText();
        applyFilters();
      });

      const txt = document.createElement('span');
      const countStr = counts && counts[val] ? ` (${counts[val]})` : '';
      txt.textContent = `${val}${countStr}`;

      opt.appendChild(cb);
      opt.appendChild(txt);
      panel.appendChild(opt);
    });

    ddToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = panel.style.display === 'block';
      document.querySelectorAll('.dd-panel').forEach(p => p.style.display = 'none');
      panel.style.display = open ? 'none' : 'block';
      if (!open) ddSearch.focus();
    });

    updateToggleText();
    dd.appendChild(ddToggle);
    dd.appendChild(panel);
    return dd;
  }

  function renderTags(records) {
    tagContainer.innerHTML = '';
    const tagOrder = columnsOrder.filter(o => o.type === 'tag');

    tagOrder.forEach(({ col }) => {
      const label = tagColumns[col];
      if (!label || visibleFilters[col] === false) return;

      const wrapper = document.createElement('div');
      wrapper.className = 'tag-group';

      const title = document.createElement('div');
      title.className = 'tag-title';
      title.textContent = label;
      wrapper.appendChild(title);

      const counts = countValues(records, col);
      const uniqueValues = sortAlphaNum(Object.keys(counts));
      if (!selectedTags[col]) selectedTags[col] = [];

      if (uniqueValues.length <= DROPDOWN_THRESHOLD) {
        const row = document.createElement('div');
        row.className = 'tag-row';
        uniqueValues.forEach(val => {
          const tag = document.createElement('span');
          tag.className = 'tag';
          tag.textContent = val;
          if (selectedTags[col].includes(val)) tag.classList.add('active');
          tag.addEventListener('click', () => {
            if (selectedTags[col].includes(val)) {
              selectedTags[col] = selectedTags[col].filter(v => v !== val);
              tag.classList.remove('active');
            } else {
              selectedTags[col].push(val);
              tag.classList.add('active');
            }
            applyFilters();
          });
          row.appendChild(tag);
        });
        wrapper.appendChild(row);
      } else {
        wrapper.appendChild(createMultiDropdown(col, uniqueValues, counts));
      }

      tagContainer.appendChild(wrapper);
    });
  }

  function renderTexts(records) {
    if (!textContainer) return;
    textContainer.innerHTML = '';
    textEls = {};

    const textOrder = columnsOrder.filter(o => o.type === 'text');

    textOrder.forEach(({ col }) => {
      const label = textColumns[col];
      if (!label || visibleFilters[col] === false) return;

      const mode = textModes[col] || 'multi';

      const wrapper = document.createElement('div');
      wrapper.className = 'filter-card';
      wrapper.dataset.col = col;

      const title = document.createElement('div');
      title.className = 'filter-title';
      title.textContent = label;
      wrapper.appendChild(title);

      const counts = countValues(records, col);
      const uniqueValues = sortAlphaNum(Object.keys(counts));

      // Mode Multi-sélection (cases à cocher)
      if (mode === 'multi') {
        wrapper.appendChild(createMultiDropdown(col, uniqueValues, counts));
      }

      // Mode Recherche texte
      if (mode === 'search' || mode === 'both') {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'filter-text';
        input.placeholder = `Rechercher dans ${label}...`;
        input.value = selectedTexts[col] || '';
        input.addEventListener('input', () => {
          selectedTexts[col] = input.value;
          applyFilters();
        });
        wrapper.appendChild(input);
        textEls[col] = input;
      }

      // Mode Liste déroulante simple
      if (mode === 'dropdown' || mode === 'both') {
        const select = document.createElement('select');
        select.className = 'filter-multi';
        select.appendChild(new Option('— Tous —', ''));
        uniqueValues.forEach(val => select.appendChild(new Option(`${val} (${counts[val]})`, val)));
        select.addEventListener('change', applyFilters);
        wrapper.appendChild(select);
        selectEls[col] = select;
      }

      textContainer.appendChild(wrapper);
    });
  }

  function renderSelects(records) {
    selectContainer.innerHTML = '';
    selectEls = {};

    const selectOrder = columnsOrder.filter(o => o.type === 'select');

    selectOrder.forEach(({ col }) => {
      const label = selectColumns[col];
      if (!label || visibleFilters[col] === false) return;

      const wrapper = document.createElement('div');
      wrapper.className = 'filter-card';

      const title = document.createElement('div');
      title.className = 'filter-title';
      title.textContent = label;

      const counts = countValues(records, col);
      const uniqueValues = sortAlphaNum(Object.keys(counts));

      wrapper.appendChild(title);
      wrapper.appendChild(createMultiDropdown(col, uniqueValues, counts));
      selectContainer.appendChild(wrapper);
    });
  }

  function applyFilters() {
    let filtered = [...allRecords];

    // Filtre par multi-sélection (tags, selects et colonnes texte en mode 'multi')
    Object.keys(selectedTags).forEach(col => {
      const vals = selectedTags[col];
      if (vals && vals.length > 0) {
        filtered = filtered.filter(r => cleanVal(r[col]).some(v => vals.includes(v)));
      }
    });

    // Filtre par recherche texte
    Object.keys(textEls).forEach(col => {
      const q = (selectedTexts[col] || '').toLowerCase().trim();
      if (q) {
        filtered = filtered.filter(r => String(r[col] ?? '').toLowerCase().includes(q));
      }
    });

    // Filtre par listes déroulantes simples
    Object.keys(selectEls).forEach(col => {
      const val = selectEls[col]?.value;
      if (val) {
        filtered = filtered.filter(r => cleanVal(r[col]).includes(val));
      }
    });

    // Recherche globale
    const search = globalSearch.value.toLowerCase().trim();
    if (search) {
      filtered = filtered.filter(r =>
        Object.values(r).some(v => {
          if (!v) return false;
          if (Array.isArray(v)) return v.some(x => String(x).toLowerCase().includes(search));
          return String(v).toLowerCase().includes(search);
        })
      );
    }

    resultsCount.textContent = `Résultats: ${filtered.length}`;
    grist.setSelectedRows(filtered.map(r => r.id));
    updateDisabledOptions(filtered);
    saveState();
  }

  function updateDisabledOptions(filtered) {
    const allMultiCols = [...Object.keys(tagColumns), ...Object.keys(textColumns), ...Object.keys(selectColumns)];
    allMultiCols.forEach(col => {
      const counts = countValues(filtered, col);
      document.querySelectorAll(`.filter-card[data-col="${col}"] .dd-option, .tag-group .dd-option`).forEach(opt => {
        const val = opt.dataset.value;
        if (!val) return;
        const isChecked = (selectedTags[col] || []).includes(val);
        const unavailable = !counts[val] && !isChecked;
        opt.classList.toggle('disabled', unavailable);
        const cb = opt.querySelector('input');
        if (cb) cb.disabled = unavailable;
      });
    });

    Object.keys(selectEls).forEach(col => {
      const counts = countValues(filtered, col);
      Array.from(selectEls[col].options).forEach(opt => {
        if (!opt.value) return;
        opt.disabled = !counts[opt.value];
      });
    });
  }

  function serializeSelects() {
    const sel = {};
    Object.entries(selectEls).forEach(([col, selEl]) => { sel[col] = selEl.value; });
    return sel;
  }

  function updateFilterVisibility() {
    tagContainer.style.display = visibleFilters.tags ? 'block' : 'none';
    applyOrder();
    saveState();
  }

  function renderFilterCheckboxes() {
    filterCheckboxesContainer.innerHTML = '';

    const intro = document.createElement('div');
    intro.style.cssText = 'font-size:0.85em;color:var(--color-text-secondary);margin-bottom:8px;';
    intro.textContent = 'Glisse pour réordonner. Coche pour afficher. Choisis le mode des filtres texte.';
    filterCheckboxesContainer.appendChild(intro);

    columnsOrder.forEach(({ col, type }) => {
      const label = type === 'tag' ? tagColumns[col]
                  : type === 'select' ? selectColumns[col]
                  : textColumns[col];
      if (!label) return;

      const div = document.createElement('div');
      div.className = 'checkbox-item';
      div.dataset.col = col;
      div.dataset.type = type;
      div.draggable = true;

      const handle = document.createElement('span');
      handle.textContent = '⠿';
      handle.style.cssText = 'color:var(--color-text-tertiary);cursor:grab;';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = `order-${col}`;
      checkbox.checked = visibleFilters[col] !== false;
      checkbox.addEventListener('change', e => {
        visibleFilters[col] = e.target.checked;
        updateFilterVisibility();
      });

      const labelEl = document.createElement('label');
      labelEl.htmlFor = `order-${col}`;
      labelEl.textContent = label;
      labelEl.style.cssText = 'flex:1;';

      div.appendChild(handle);
      div.appendChild(checkbox);
      div.appendChild(labelEl);

      if (type === 'text') {
        const modeSelect = document.createElement('select');
        modeSelect.style.cssText = 'font-size:11.5px;padding:2px 4px;border-radius:4px;border:1px solid var(--border);';
        modeSelect.appendChild(new Option('Multi-sélection', 'multi'));
        modeSelect.appendChild(new Option('Recherche texte', 'search'));
        modeSelect.appendChild(new Option('Liste simple', 'dropdown'));
        modeSelect.appendChild(new Option('Recherche + Liste', 'both'));
        modeSelect.value = textModes[col] || 'multi';
        modeSelect.addEventListener('change', () => {
          textModes[col] = modeSelect.value;
          selectedTags[col] = [];
          saveState();
          applyOrder();
          applyFilters();
        });
        modeSelect.addEventListener('mousedown', e => e.stopPropagation());
        div.appendChild(modeSelect);
      }

      filterCheckboxesContainer.appendChild(div);
    });

    let dragEl = null;
    filterCheckboxesContainer.addEventListener('dragstart', e => {
      dragEl = e.target.closest('[draggable]');
      if (dragEl) dragEl.style.opacity = '0.4';
    });
    filterCheckboxesContainer.addEventListener('dragend', () => {
      if (dragEl) dragEl.style.opacity = '1';
      dragEl = null;
    });
    filterCheckboxesContainer.addEventListener('dragover', e => e.preventDefault());
    filterCheckboxesContainer.addEventListener('drop', e => {
      e.preventDefault();
      const target = e.target.closest('[data-col]');
      if (!target || !dragEl || target === dragEl) return;
      const fromIdx = columnsOrder.findIndex(o => o.col === dragEl.dataset.col);
      const toIdx = columnsOrder.findIndex(o => o.col === target.dataset.col);
      const [moved] = columnsOrder.splice(fromIdx, 1);
      columnsOrder.splice(toIdx, 0, moved);
      visibleFilters.order = columnsOrder;
      saveState();
      renderFilterCheckboxes();
      applyOrder();
    });
  }

  function restoreState() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return;
    try {
      const state = JSON.parse(saved);
      selectedTags = state.selectedTags || {};
      selectedTexts = state.selectedTexts || {};
      textModes = state.textModes || {};
      if (state.visibleFilters) visibleFilters = state.visibleFilters;

      applyOrder();

      Object.entries(state.selectEls || {}).forEach(([col, val]) => {
        if (selectEls[col]) selectEls[col].value = val;
      });
      Object.keys(textEls).forEach(col => {
        textEls[col].value = selectedTexts[col] || '';
      });

      applyFilters();
    } catch (e) {
      console.error('Erreur restauration état :', e);
    }
  }

  resetButton.addEventListener('click', () => {
    selectedTags = {};
    selectedTexts = {};
    Object.values(selectEls).forEach(sel => sel.value = '');
    Object.values(textEls).forEach(inp => inp.value = '');
    globalSearch.value = '';
    applyOrder();
    applyFilters();
  });

  manageFiltersBtn.addEventListener('click', () => {
    filterModal.style.display = 'flex';
    renderFilterCheckboxes();
  });

  closeModalBtn.addEventListener('click', () => {
    filterModal.style.display = 'none';
  });

  selectAllBtn.addEventListener('click', () => {
    visibleFilters.tags = true;
    Object.keys(selectColumns).forEach(col => { visibleFilters[col] = true; });
    Object.keys(tagColumns).forEach(col => { visibleFilters[col] = true; });
    Object.keys(textColumns).forEach(col => { visibleFilters[col] = true; });
    updateFilterVisibility();
    renderFilterCheckboxes();
  });

  deselectAllBtn.addEventListener('click', () => {
    visibleFilters.tags = false;
    Object.keys(selectColumns).forEach(col => { visibleFilters[col] = false; });
    Object.keys(tagColumns).forEach(col => { visibleFilters[col] = false; });
    Object.keys(textColumns).forEach(col => { visibleFilters[col] = false; });
    updateFilterVisibility();
    renderFilterCheckboxes();
  });

  globalSearch.addEventListener('input', applyFilters);

  grist.ready({ requiredAccess: 'full', allowSelectBy: true });

  grist.onRecords(async (records) => {
    allRecords = records;
    tagColumns = {};
    selectColumns = {};
    textColumns = {};

    try {
      await fetchColumnsAndTypes(records);
    } catch (error) {
      console.error('Impossible de récupérer les métadonnées :', error);
    }

    initOrder();
    applyOrder();

    resultsCount.textContent = `Résultats: ${allRecords.length}`;
    grist.setSelectedRows(allRecords.map(r => r.id));

    restoreState();
  });
});
