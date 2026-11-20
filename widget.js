document.addEventListener('DOMContentLoaded', () => {
  let allRecords = [];
  let selectedTags = {};
  let selectedTexts = {};
  let textModes = {};
  let selectEls = {};
  let textEls = {};
  const STORAGE_KEY = 'grist_filters_session_v3';
  const DROPDOWN_THRESHOLD = 10;
  let tagColumns = {};
  let selectColumns = {};
  let textColumns = {};
  let visibleFilters = { tags: true };
  let columnsOrder = [];
  let hideUnavailable = true;
  let isModalDirty = false;
  let isInitialized = false;

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
  const hideUnavailableOpt = document.getElementById('hide-unavailable-opt');

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

  async function saveWidgetConfig() {
    try {
      await grist.setOption('filterWidgetConfig', {
        visibleFilters,
        columnsOrder,
        textModes,
        hideUnavailable
      });
    } catch (e) {
      console.warn('Impossible de sauvegarder dans les options Grist :', e);
    }
  }

  function saveSessionState() {
    try {
      const key = window._currentStorageKey || STORAGE_KEY;
      sessionStorage.setItem(key, JSON.stringify({
        selectedTags,
        selectedTexts,
        selectEls: serializeSelects()
      }));
    } catch (e) { /* Ignore */ }
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
      if (textModes[col] === undefined) textModes[col] = 'multi';
    });
  }

  function countValues(records, col) {
    const counts = {};
    for (let i = 0; i < records.length; i++) {
      const v = records[i][col];
      if (v === null || v === undefined || v === '') continue;
      if (Array.isArray(v)) {
        for (let j = 0; j < v.length; j++) {
          const item = v[j];
          if (item !== 'L' && item !== null && item !== undefined && item !== '') {
            counts[item] = (counts[item] || 0) + 1;
          }
        }
      } else {
        const str = String(v);
        counts[str] = (counts[str] || 0) + 1;
      }
    }
    return counts;
  }

  function initOrder() {
    const allCols = [
      ...Object.keys(tagColumns).map(col => ({ col, type: 'tag' })),
      ...Object.keys(selectColumns).map(col => ({ col, type: 'select' })),
      ...Object.keys(textColumns).map(col => ({ col, type: 'text' })),
    ];
    const savedOrder = (columnsOrder && columnsOrder.length > 0) ? columnsOrder : (visibleFilters.order || []);
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
        const matchesSearch = o.dataset.value.toLowerCase().includes(q);
        const hiddenByFilter = hideUnavailable && o.dataset.unavailable === 'true';
        o.style.display = (matchesSearch && !hiddenByFilter) ? 'flex' : 'none';
      });
    });
    panel.appendChild(ddSearch);

    const frag = document.createDocumentFragment();
    uniqueValues.forEach(val => {
      const opt = document.createElement('label');
      opt.className = 'dd-option';
      opt.dataset.value = val;
      opt.dataset.unavailable = 'false';

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
      frag.appendChild(opt);
    });
    panel.appendChild(frag);

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
      wrapper.dataset.col = col;

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

      if (mode === 'multi') {
        wrapper.appendChild(createMultiDropdown(col, uniqueValues, counts));
      }

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
      wrapper.dataset.col = col;

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

  function hasAnyActiveFilter() {
    const hasTags = Object.values(selectedTags).some(arr => arr && arr.length > 0);
    const hasTexts = Object.values(selectedTexts).some(t => t && t.trim() !== '');
    const hasSelects = Object.values(selectEls).some(el => el && el.value !== '');
    const hasGlobal = globalSearch && globalSearch.value.trim() !== '';
    return hasTags || hasTexts || hasSelects || hasGlobal;
  }

  function applyFilters(isInitialLoad = false) {
    // Optimisation majeure : si aucun filtre n'est actif, pas besoin de filtrer ni de recalculer 1M d'options
    if (!hasAnyActiveFilter()) {
      resultsCount.textContent = `Résultats: ${allRecords.length}`;
      if (!isInitialLoad) {
        grist.setSelectedRows(allRecords.map(r => r.id));
      }
      resetAllDisabledOptions();
      saveSessionState();
      return;
    }

    let filtered = allRecords;

    Object.keys(selectedTags).forEach(col => {
      const vals = selectedTags[col];
      if (vals && vals.length > 0) {
        filtered = filtered.filter(r => cleanVal(r[col]).some(v => vals.includes(v)));
      }
    });

    Object.keys(textEls).forEach(col => {
      const q = (selectedTexts[col] || '').toLowerCase().trim();
      if (q) {
        filtered = filtered.filter(r => String(r[col] ?? '').toLowerCase().includes(q));
      }
    });

    Object.keys(selectEls).forEach(col => {
      const val = selectEls[col]?.value;
      if (val) {
        filtered = filtered.filter(r => cleanVal(r[col]).includes(val));
      }
    });

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
    saveSessionState();
  }

  function resetAllDisabledOptions() {
    document.querySelectorAll('.dd-option').forEach(opt => {
      opt.dataset.unavailable = 'false';
      opt.classList.remove('disabled');
      opt.style.display = 'flex';
      const cb = opt.querySelector('input');
      if (cb) cb.disabled = false;
    });
    document.querySelectorAll('.tag').forEach(tag => {
      tag.classList.remove('disabled');
      tag.style.display = 'inline-block';
    });
    Object.keys(selectEls).forEach(col => {
      Array.from(selectEls[col].options).forEach(opt => {
        opt.disabled = false;
        opt.hidden = false;
      });
    });
  }

  function updateDisabledOptions(filtered) {
    const allMultiCols = [...Object.keys(tagColumns), ...Object.keys(textColumns), ...Object.keys(selectColumns)];
    
    allMultiCols.forEach(col => {
      if (visibleFilters[col] === false) return; // Ignore les colonnes masquées pour gagner du temps

      let otherFiltered = allRecords;

      Object.keys(selectedTags).forEach(otherCol => {
        if (otherCol === col) return;
        const vals = selectedTags[otherCol];
        if (vals && vals.length > 0) {
          otherFiltered = otherFiltered.filter(r => cleanVal(r[otherCol]).some(v => vals.includes(v)));
        }
      });

      Object.keys(textEls).forEach(otherCol => {
        if (otherCol === col) return;
        const q = (selectedTexts[otherCol] || '').toLowerCase().trim();
        if (q) {
          otherFiltered = otherFiltered.filter(r => String(r[otherCol] ?? '').toLowerCase().includes(q));
        }
      });

      Object.keys(selectEls).forEach(otherCol => {
        if (otherCol === col) return;
        const val = selectEls[otherCol]?.value;
        if (val) {
          otherFiltered = otherFiltered.filter(r => cleanVal(r[otherCol]).includes(val));
        }
      });

      const search = globalSearch.value.toLowerCase().trim();
      if (search) {
        otherFiltered = otherFiltered.filter(r =>
          Object.values(r).some(v => {
            if (!v) return false;
            if (Array.isArray(v)) return v.some(x => String(x).toLowerCase().includes(search));
            return String(v).toLowerCase().includes(search);
          })
        );
      }

      const counts = countValues(otherFiltered, col);
      const container = document.querySelector(`.filter-card[data-col="${col}"], .tag-group[data-col="${col}"]`);
      if (!container) return;

      const ddSearch = container.querySelector('.dd-search');
      const searchQuery = ddSearch ? ddSearch.value.toLowerCase() : '';

      container.querySelectorAll('.dd-option').forEach(opt => {
        const val = opt.dataset.value;
        if (!val) return;
        const isChecked = (selectedTags[col] || []).includes(val);
        const unavailable = !counts[val] && !isChecked;
        opt.dataset.unavailable = unavailable ? 'true' : 'false';

        const cb = opt.querySelector('input');
        if (cb) cb.disabled = unavailable;

        if (hideUnavailable) {
          opt.classList.remove('disabled');
          const matchesSearch = !searchQuery || val.toLowerCase().includes(searchQuery);
          opt.style.display = (!unavailable && matchesSearch) ? 'flex' : 'none';
        } else {
          opt.classList.toggle('disabled', unavailable);
          const matchesSearch = !searchQuery || val.toLowerCase().includes(searchQuery);
          opt.style.display = matchesSearch ? 'flex' : 'none';
        }
      });

      container.querySelectorAll('.tag').forEach(tag => {
        const val = tag.textContent;
        const isChecked = (selectedTags[col] || []).includes(val);
        const unavailable = !counts[val] && !isChecked;
        if (hideUnavailable) {
          tag.classList.remove('disabled');
          tag.style.display = unavailable ? 'none' : 'inline-block';
        } else {
          tag.style.display = 'inline-block';
          tag.classList.toggle('disabled', unavailable);
        }
      });
    });

    Object.keys(selectEls).forEach(col => {
      const counts = countValues(filtered, col);
      Array.from(selectEls[col].options).forEach(opt => {
        if (!opt.value) return;
        const unavailable = !counts[opt.value];
        opt.disabled = unavailable;
        opt.hidden = hideUnavailable && unavailable;
      });
    });
  }

  function serializeSelects() {
    const sel = {};
    Object.entries(selectEls).forEach(([col, selEl]) => { sel[col] = selEl.value; });
    return sel;
  }

  async function updateFilterVisibility() {
    tagContainer.style.display = visibleFilters.tags ? 'block' : 'none';
    applyOrder();
    applyFilters();
    await saveWidgetConfig();
  }

  function renderFilterCheckboxes() {
    filterCheckboxesContainer.innerHTML = '';

    const intro = document.createElement('div');
    intro.style.cssText = 'font-size:0.85em;color:var(--color-text-secondary);margin-bottom:6px;';
    intro.textContent = 'Glisse une ligne (ou utilise ↑ ↓) pour réordonner. Enregistré dans le document à la fermeture.';
    filterCheckboxesContainer.appendChild(intro);

    let dragFromIdx = null;

    columnsOrder.forEach(({ col, type }, idx) => {
      const label = type === 'tag' ? tagColumns[col]
                  : type === 'select' ? selectColumns[col]
                  : textColumns[col];
      if (!label) return;

      const div = document.createElement('div');
      div.className = 'checkbox-item';
      div.dataset.col = col;
      div.dataset.idx = idx;
      div.draggable = true;
      div.style.cssText = 'display:flex; align-items:center; gap:6px; padding:5px 8px; border-radius:5px; border:1px solid #e5e7eb; background:#fff; transition: background 0.1s;';

      const handle = document.createElement('span');
      handle.textContent = '⠿';
      handle.title = 'Glisser pour déplacer';
      handle.style.cssText = 'color:#9ca3af; cursor:grab; font-size:15px; user-select:none;';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = `order-${col}`;
      checkbox.checked = visibleFilters[col] !== false;
      checkbox.style.accentColor = '#951b1e';
      checkbox.addEventListener('change', e => {
        visibleFilters[col] = e.target.checked;
        isModalDirty = true;
      });

      const labelEl = document.createElement('label');
      labelEl.htmlFor = `order-${col}`;
      labelEl.textContent = label;
      labelEl.style.cssText = 'flex:1; cursor:pointer; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';

      const moveBox = document.createElement('div');
      moveBox.style.cssText = 'display:flex; gap:2px;';

      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.textContent = '↑';
      upBtn.title = 'Monter';
      upBtn.disabled = idx === 0;
      upBtn.style.cssText = 'padding:1px 5px; font-size:11px; border:1px solid #d1d5db; border-radius:3px; background:#f9fafb; cursor:pointer;';
      upBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (idx > 0) {
          const [moved] = columnsOrder.splice(idx, 1);
          columnsOrder.splice(idx - 1, 0, moved);
          visibleFilters.order = columnsOrder;
          isModalDirty = true;
          renderFilterCheckboxes();
        }
      });

      const downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.textContent = '↓';
      downBtn.title = 'Descendre';
      downBtn.disabled = idx === columnsOrder.length - 1;
      downBtn.style.cssText = 'padding:1px 5px; font-size:11px; border:1px solid #d1d5db; border-radius:3px; background:#f9fafb; cursor:pointer;';
      downBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (idx < columnsOrder.length - 1) {
          const [moved] = columnsOrder.splice(idx, 1);
          columnsOrder.splice(idx + 1, 0, moved);
          visibleFilters.order = columnsOrder;
          isModalDirty = true;
          renderFilterCheckboxes();
        }
      });

      moveBox.appendChild(upBtn);
      moveBox.appendChild(downBtn);

      div.appendChild(handle);
      div.appendChild(checkbox);
      div.appendChild(labelEl);

      if (type === 'text') {
        const modeSelect = document.createElement('select');
        modeSelect.style.cssText = 'font-size:11.5px; padding:2px 4px; border-radius:4px; border:1px solid #d1d5db;';
        modeSelect.appendChild(new Option('Multi-sélection', 'multi'));
        modeSelect.appendChild(new Option('Recherche texte', 'search'));
        modeSelect.appendChild(new Option('Liste simple', 'dropdown'));
        modeSelect.appendChild(new Option('Recherche + Liste', 'both'));
        modeSelect.value = textModes[col] || 'multi';
        modeSelect.addEventListener('change', () => {
          textModes[col] = modeSelect.value;
          selectedTags[col] = [];
          isModalDirty = true;
        });
        modeSelect.addEventListener('mousedown', e => e.stopPropagation());
        div.appendChild(modeSelect);
      }

      div.appendChild(moveBox);

      div.addEventListener('dragstart', e => {
        dragFromIdx = idx;
        div.style.opacity = '0.4';
        div.style.background = '#fef2f2';
        e.dataTransfer.effectAllowed = 'move';
      });

      div.addEventListener('dragend', () => {
        div.style.opacity = '1';
        div.style.background = '#fff';
        filterCheckboxesContainer.querySelectorAll('.checkbox-item').forEach(el => {
          el.style.borderTop = '1px solid #e5e7eb';
          el.style.borderBottom = '1px solid #e5e7eb';
        });
      });

      div.addEventListener('dragover', e => {
        e.preventDefault();
        if (dragFromIdx === null || dragFromIdx === idx) return;
        const rect = div.getBoundingClientRect();
        const isTopHalf = (e.clientY - rect.top) < rect.height / 2;
        div.style.borderTop = isTopHalf ? '2.5px solid #951b1e' : '1px solid #e5e7eb';
        div.style.borderBottom = !isTopHalf ? '2.5px solid #951b1e' : '1px solid #e5e7eb';
      });

      div.addEventListener('dragleave', () => {
        div.style.borderTop = '1px solid #e5e7eb';
        div.style.borderBottom = '1px solid #e5e7eb';
      });

      div.addEventListener('drop', e => {
        e.preventDefault();
        if (dragFromIdx === null || dragFromIdx === idx) return;
        const rect = div.getBoundingClientRect();
        const isTopHalf = (e.clientY - rect.top) < rect.height / 2;
        let toIdx = isTopHalf ? idx : idx + 1;
        if (dragFromIdx < toIdx) toIdx--;

        const [moved] = columnsOrder.splice(dragFromIdx, 1);
        columnsOrder.splice(toIdx, 0, moved);
        visibleFilters.order = columnsOrder;
        isModalDirty = true;
        renderFilterCheckboxes();
      });

      filterCheckboxesContainer.appendChild(div);
    });
  }

  async function restoreAllState() {
    try {
      const savedConfig = await grist.getOption('filterWidgetConfig');
      if (savedConfig) {
        if (savedConfig.visibleFilters) visibleFilters = savedConfig.visibleFilters;
        if (savedConfig.columnsOrder) columnsOrder = savedConfig.columnsOrder;
        if (savedConfig.textModes) textModes = savedConfig.textModes;
        if (savedConfig.hideUnavailable !== undefined) hideUnavailable = savedConfig.hideUnavailable;
      }
    } catch (e) { /* Ignore */ }

    if (hideUnavailableOpt) hideUnavailableOpt.checked = hideUnavailable;

    try {
      const key = window._currentStorageKey || STORAGE_KEY;
      const savedSession = sessionStorage.getItem(key);
      if (savedSession) {
        const state = JSON.parse(savedSession);
        selectedTags = state.selectedTags || {};
        selectedTexts = state.selectedTexts || {};
        applyOrder();
        Object.entries(state.selectEls || {}).forEach(([col, val]) => {
          if (selectEls[col]) selectEls[col].value = val;
        });
        Object.keys(textEls).forEach(col => {
          textEls[col].value = selectedTexts[col] || '';
        });
        applyFilters(true);
        return;
      }
    } catch (e) { /* Ignore */ }

    // Un seul rendu complet au démarrage
    applyOrder();
    applyFilters(true);
  }

  if (hideUnavailableOpt) {
    hideUnavailableOpt.addEventListener('change', (e) => {
      hideUnavailable = e.target.checked;
      isModalDirty = true;
    });
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
    isModalDirty = false;
    filterModal.style.display = 'flex';
    if (hideUnavailableOpt) hideUnavailableOpt.checked = hideUnavailable;
    renderFilterCheckboxes();
  });

  closeModalBtn.addEventListener('click', async () => {
    filterModal.style.display = 'none';
    if (isModalDirty) {
      await updateFilterVisibility();
      isModalDirty = false;
    }
  });

  selectAllBtn.addEventListener('click', () => {
    visibleFilters.tags = true;
    Object.keys(selectColumns).forEach(col => { visibleFilters[col] = true; });
    Object.keys(tagColumns).forEach(col => { visibleFilters[col] = true; });
    Object.keys(textColumns).forEach(col => { visibleFilters[col] = true; });
    isModalDirty = true;
    renderFilterCheckboxes();
  });

  deselectAllBtn.addEventListener('click', () => {
    visibleFilters.tags = false;
    Object.keys(selectColumns).forEach(col => { visibleFilters[col] = false; });
    Object.keys(tagColumns).forEach(col => { visibleFilters[col] = false; });
    Object.keys(textColumns).forEach(col => { visibleFilters[col] = false; });
    isModalDirty = true;
    renderFilterCheckboxes();
  });

  globalSearch.addEventListener('input', () => applyFilters());

  grist.ready({ requiredAccess: 'full', allowSelectBy: true });

  async function initData(records, tableId) {
    allRecords = records || [];
    tagColumns = {};
    selectColumns = {};
    textColumns = {};

    if (tableId) {
      window._currentStorageKey = `${STORAGE_KEY}_${tableId}`;
    }

    try {
      await fetchColumnsAndTypes(allRecords);
    } catch (error) {
      console.error('Impossible de récupérer les métadonnées :', error);
    }

    await restoreAllState();
  }

  async function forceLoadTable() {
    if (isInitialized) return;
    try {
      const tableId = await grist.selectedTable.getTableId();
      if (!tableId) return;

      const raw = await grist.docApi.fetchTable(tableId);
      if (!raw || !raw.id || raw.id.length === 0) return;

      const cols = Object.keys(raw).filter(k => k !== 'id' && k !== 'manualSort' && !k.startsWith('gristHelper'));
      const records = new Array(raw.id.length);
      for (let i = 0; i < raw.id.length; i++) {
        const rec = { id: raw.id[i] };
        for (let c = 0; c < cols.length; c++) {
          rec[cols[c]] = raw[cols[c]][i];
        }
        records[i] = rec;
      }

      isInitialized = true;
      await initData(records, tableId);
    } catch (err) {
      console.error('Erreur chargement direct :', err);
    }
  }

  grist.onRecords(async (records) => {
    if (records && records.length > 0 && !isInitialized) {
      isInitialized = true;
      let tableId = '';
      try { tableId = await grist.selectedTable.getTableId(); } catch {}
      await initData(records, tableId);
    }
  });

  // Délai réduit à 150ms au lieu de 500ms
  setTimeout(forceLoadTable, 150);
});
