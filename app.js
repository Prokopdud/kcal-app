(function () {
  const STORAGE_KEY = 'kcal-app-state-v1';
  const WEEKDAYS = ['Po', 'Ú', 'St', 'Č', 'Pá', 'So', 'Ne'];
  const RING_R = 11;

  let addMeal = 'obed';
  let pantryLoc = 'lednice';
  let state = {
    selectedDate: null,
    openedOn: null,
    diary: [],
    customFoods: [],
    foodOverrides: {},
  };
  let amountCtx = null;
  let foodCtx = null;

  let mediaStream = null;
  let detectTimer = null;
  let zxingReader = null;
  let zxingControls = null;
  let scanning = false;
  let zxingLoading = null;
  let sessionFoods = new Map();
  let shownOff = new Map();
  let offHits = [];
  let offFor = '';
  let offToken = 0;
  let offAbort = null;
  let offTimer = null;
  let barcodeAbort = null;
  let hold = null;
  let pressSerial = 0;

  function todayISO() {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Prague',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const get = (type) => parts.find((p) => p.type === type).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  function isISO(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  }

  function parseISO(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function toISO(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function addDays(iso, days) {
    const date = parseISO(iso);
    date.setDate(date.getDate() + days);
    return toISO(date);
  }

  function weekStart(iso) {
    const date = parseISO(iso);
    const day = date.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    date.setDate(date.getDate() + diff);
    return toISO(date);
  }

  function round(n, d) {
    const p = 10 ** (d ?? 0);
    return Math.round(n * p) / p;
  }

  function esc(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function num(value) {
    if (typeof value === 'number') return value;
    if (value == null) return NaN;
    return parseFloat(String(value).replace(',', '.').trim());
  }

  function scaled(value, grams, digits) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return round(value * (grams / 100), digits);
  }

  function foodMacros(food, grams) {
    return {
      kcal: scaled(food.kcal, grams, 0),
      protein: scaled(food.protein, grams, 1),
      carbs: scaled(food.carbs, grams, 1),
      fat: scaled(food.fat, grams, 1),
      fiber: scaled(food.fiber, grams, 1),
    };
  }

  function addNum(sum, value) {
    return value == null ? sum : sum + value;
  }

  /* Green: at the goal, slack up to about +3% or +80 kcal.
     Orange: a bit over, up to about +10% or +250 kcal.
     Red: above that. Gray: under the goal, ring filled by eaten/goal. */
  function dayBand(kcal) {
    const goal = KCAL.goals.kcal;
    const eaten = Math.max(0, kcal || 0);
    if (eaten < goal) {
      return { band: 'under', fill: goal > 0 ? eaten / goal : 0 };
    }
    const over = eaten - goal;
    const greenMax = Math.max(80, goal * 0.03);
    const orangeMax = Math.max(250, goal * 0.1);
    if (over <= greenMax) return { band: 'met', fill: 1 };
    if (over <= orangeMax) return { band: 'over', fill: 1 };
    return { band: 'high', fill: 1 };
  }

  function bandLabel(band) {
    if (band === 'met') return 'v cíli';
    if (band === 'over') return 'trochu nad';
    if (band === 'high') return 'moc';
    return 'pod cílem';
  }

  function catalog() {
    const base = KCAL.foods.map((food) => {
      const over = state.foodOverrides[food.id];
      if (!over) return food;
      const merged = { ...food, ...over, id: food.id, builtin: true };
      if (over.package_g == null) delete merged.package_g;
      return merged;
    });
    const saved = state.offFoods || [];
    const savedIds = new Set(saved.map((food) => food.id));
    const pending = [];
    sessionFoods.forEach((food) => {
      if (!savedIds.has(food.id) && food.kcal != null) pending.push(food);
    });
    return base.concat(state.customFoods, saved, pending);
  }

  function foodById(id) {
    return catalog().find((food) => food.id === id) || null;
  }

  function entriesOn(date) {
    return state.diary.filter((entry) => entry.date === date);
  }

  function dayTotals(date, opts) {
    const options = opts || {};
    const totals = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, micros: {} };
    const rows = entriesOn(date).filter((entry) => entry.id !== options.excludeId);
    if (options.extra) rows.push(options.extra);
    for (const entry of rows) {
      const food = foodById(entry.foodId);
      if (!food) continue;
      const macros = foodMacros(food, entry.grams);
      totals.kcal = addNum(totals.kcal, macros.kcal);
      totals.protein = addNum(totals.protein, macros.protein);
      totals.carbs = addNum(totals.carbs, macros.carbs);
      totals.fat = addNum(totals.fat, macros.fat);
      totals.fiber = addNum(totals.fiber, macros.fiber);
      const scale = entry.grams / 100;
      for (const [key, value] of Object.entries(food.micros || {})) {
        if (typeof value !== 'number') continue;
        totals.micros[key] = (totals.micros[key] || 0) + value * scale;
      }
    }
    totals.kcal = round(totals.kcal);
    totals.protein = round(totals.protein, 1);
    totals.carbs = round(totals.carbs, 1);
    totals.fat = round(totals.fat, 1);
    return totals;
  }

  function formatDate(iso) {
    return parseISO(iso).toLocaleDateString('cs-CZ', {
      weekday: 'short',
      day: 'numeric',
      month: 'numeric',
    });
  }

  function toast(msg, ms) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), ms || 2400);
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_) {
      toast('Nepodařilo se uložit do prohlížeče.', 3200);
    }
  }

  function sanitizeEntry(entry) {
    if (!entry || !isISO(entry.date)) return null;
    if (!KCAL.mealLabels[entry.meal]) return null;
    const grams = num(entry.grams);
    if (!entry.foodId || !Number.isFinite(grams) || grams <= 0) return null;
    return {
      id: String(entry.id),
      date: entry.date,
      meal: entry.meal,
      foodId: String(entry.foodId),
      grams: round(grams, 1),
    };
  }

  function sanitizeFood(food) {
    if (!food || !food.id || !food.name) return null;
    const kcal = num(food.kcal);
    const protein = num(food.protein);
    const carbs = num(food.carbs);
    const fat = num(food.fat);
    if (![kcal, protein, carbs, fat].every((n) => Number.isFinite(n) && n >= 0)) return null;
    const pack = num(food.package_g);
    const item = {
      id: String(food.id),
      name: String(food.name).slice(0, 80),
      kcal,
      protein,
      carbs,
      fat,
      fiber: Number.isFinite(num(food.fiber)) ? num(food.fiber) : 0,
      custom: true,
      micros: {},
      default_serving_g: 100,
    };
    if (Number.isFinite(pack) && pack > 0) item.package_g = round(pack, 1);
    if (food.barcode) item.barcode = String(food.barcode);
    return item;
  }

  function sanitizeOff(food) {
    if (!food || !food.id || !food.name) return null;
    const kcal = num(food.kcal);
    if (!Number.isFinite(kcal) || kcal < 0) return null;
    const macro = (value) => {
      if (value == null || value === '') return null;
      const n = num(value);
      return Number.isFinite(n) && n >= 0 ? n : null;
    };
    const item = {
      id: String(food.id),
      name: String(food.name).slice(0, 80),
      off: true,
      kcal: round(kcal, 1),
      protein: macro(food.protein),
      carbs: macro(food.carbs),
      fat: macro(food.fat),
      fiber: macro(food.fiber),
      micros: {},
      default_serving_g: Number.isFinite(num(food.default_serving_g)) ? num(food.default_serving_g) : 100,
    };
    const pack = num(food.package_g);
    if (Number.isFinite(pack) && pack > 0) item.package_g = round(pack, 1);
    const piece = num(food.piece_g);
    if (Number.isFinite(piece) && piece > 0) item.piece_g = round(piece, 1);
    if (food.barcode) item.barcode = String(food.barcode).replace(/\D/g, '');
    return item;
  }

  function storeOffFood(food) {
    const copy = sanitizeOff(food);
    if (!copy) return;
    if (!state.offFoods) state.offFoods = [];
    const index = state.offFoods.findIndex((item) => item.id === copy.id);
    if (index >= 0) state.offFoods[index] = copy;
    else state.offFoods.push(copy);
    sessionFoods.set(copy.id, copy);
  }

  function loadState() {
    const today = todayISO();
    let saved = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch (_) {
      saved = null;
    }
    if (saved && Array.isArray(saved.diary)) {
      const sameDay = saved.openedOn === today;
      state = {
        selectedDate: sameDay && isISO(saved.selectedDate) ? saved.selectedDate : today,
        openedOn: today,
        diary: saved.diary.map(sanitizeEntry).filter(Boolean),
        customFoods: (saved.customFoods || []).map(sanitizeFood).filter(Boolean),
        offFoods: (saved.offFoods || []).map(sanitizeOff).filter(Boolean),
        foodOverrides: saved.foodOverrides && typeof saved.foodOverrides === 'object' ? saved.foodOverrides : {},
      };
      persist();
      return;
    }
    state = {
      selectedDate: today,
      openedOn: today,
      diary: (KCAL.sampleDiary || []).map((entry) => ({ ...entry })),
      customFoods: [],
      offFoods: [],
      foodOverrides: {},
    };
    persist();
  }

  function nextDiaryId() {
    let max = 100;
    for (const entry of state.diary) {
      const match = /^d(\d+)$/.exec(entry.id);
      if (match) max = Math.max(max, Number(match[1]) + 1);
    }
    return 'd' + max;
  }

  function setSelectedDate(iso) {
    if (!isISO(iso)) return;
    state.selectedDate = iso;
    persist();
    closeAmount();
    const active = document.querySelector('.screen.active');
    const name = active ? active.id.replace('screen-', '') : 'dnes';
    paintDate();
    if (name === 'dnes') renderDnes();
    else if (name === 'mikro') renderMikro();
    else if (name === 'pridat') renderPridat();
    else renderDnes();
  }

  function paintDate() {
    document.getElementById('date-pill').textContent = formatDate(state.selectedDate);
    const input = document.getElementById('date-input');
    if (input && document.activeElement !== input) input.value = state.selectedDate;
    const jump = document.getElementById('jump-today');
    if (jump) jump.hidden = state.selectedDate === todayISO();
  }

  function setRing(el, fill) {
    const circ = 2 * Math.PI * (el.id === 'kcal-ring' ? 48 : RING_R);
    const clamped = Math.max(0, Math.min(1, fill));
    if (clamped <= 0) {
      el.style.strokeDasharray = '0';
      el.style.strokeDashoffset = '0';
      return;
    }
    el.style.strokeDasharray = String(circ);
    el.style.strokeDashoffset = String(circ * (1 - clamped));
  }

  function findByBarcode(code) {
    const cleaned = String(code || '').replace(/\s+/g, '');
    return catalog().find((food) => food.barcode && food.barcode === cleaned) || null;
  }

  function gramsFromText(text) {
    const source = String(text || '').toLowerCase().replace(',', '.');
    if (!source) return null;
    const multi = source.match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(kg|g)\b/);
    if (multi) {
      const amount = Number(multi[1]) * Number(multi[2]);
      return multi[3] === 'kg' ? amount * 1000 : amount;
    }
    const one = source.match(/(\d+(?:\.\d+)?)\s*(kg|g)\b/);
    if (!one) return null;
    const amount = Number(one[1]);
    return one[2] === 'kg' ? amount * 1000 : amount;
  }

  function gramsFromOff(product) {
    const unit = String(product.product_quantity_unit || '').trim().toLowerCase();
    const quantity = num(product.product_quantity);
    if (Number.isFinite(quantity) && quantity > 0) {
      if (unit === 'kg') return quantity * 1000;
      if (unit === 'g' || unit === 'gr' || unit === 'gram' || unit === 'grams') return quantity;
      if (unit === 'mg') return quantity / 1000;
      if (unit) return null;
    }
    return gramsFromText(product.quantity);
  }

  function servingGrams(product) {
    const fromSize = gramsFromText(product.serving_size);
    if (fromSize) return fromSize;
    const quantity = num(product.serving_quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) return null;
    const size = String(product.serving_size || '').toLowerCase();
    if (/ml|cl|dl|\bl\b/.test(size)) return null;
    if (/\bkg\b/.test(size)) return quantity * 1000;
    return quantity;
  }

  function offNutrition(nutriments) {
    const source = nutriments || {};
    let kcal = num(source['energy-kcal_100g']);
    if (!Number.isFinite(kcal)) kcal = num(source['energy-kcal']);
    if (!Number.isFinite(kcal)) {
      const kj = num(source['energy-kj_100g']);
      if (Number.isFinite(kj)) kcal = kj / 4.184;
    }
    if (!Number.isFinite(kcal) || kcal < 0 || kcal > 2000) return null;
    const macro = (key) => {
      if (!(key in source) || source[key] == null || source[key] === '') return null;
      const value = num(source[key]);
      if (!Number.isFinite(value) || value < 0 || value > 100) return null;
      return round(value, 1);
    };
    return {
      kcal: round(kcal, 1),
      protein: macro('proteins_100g'),
      carbs: macro('carbohydrates_100g'),
      fat: macro('fat_100g'),
      fiber: macro('fiber_100g'),
    };
  }

  function offName(product) {
    const czech = String(product.product_name_cs || '').trim();
    const name = String(product.product_name || '').trim();
    let label = czech || name;
    if (!label) return '';
    const brand = String(product.brands || '').split(',')[0].trim();
    if (brand && !label.toLowerCase().includes(brand.toLowerCase())) {
      label = `${label} (${brand})`;
    }
    return label.slice(0, 80);
  }

  function mapOffProduct(product) {
    if (!product) return null;
    const code = String(product.code || '').replace(/\D/g, '');
    const name = offName(product);
    if (!code || !name) return null;
    const nutrition = offNutrition(product.nutriments);
    const pack = gramsFromOff(product);
    const piece = servingGrams(product);
    const food = {
      id: 'off:' + code,
      name,
      barcode: code,
      off: true,
      micros: {},
      kcal: nutrition ? nutrition.kcal : null,
      protein: nutrition ? nutrition.protein : null,
      carbs: nutrition ? nutrition.carbs : null,
      fat: nutrition ? nutrition.fat : null,
      fiber: nutrition ? nutrition.fiber : null,
      default_serving_g: piece || 100,
    };
    if (pack && pack > 0 && pack <= 20000) food.package_g = round(pack, 1);
    if (piece && piece > 0 && piece <= 5000) food.piece_g = round(piece, 1);
    return food;
  }

  async function offGet(url, signal) {
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
      if (response.status === 404) return null;
      if (response.status !== 503 && response.status !== 429) break;
      await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
    }
    if (!response || !response.ok) throw new Error('Open Food Facts ' + (response && response.status));
    return response.json();
  }

  async function fetchOffByCode(code, signal) {
    const fields = 'code,product_name,product_name_cs,brands,quantity,product_quantity,product_quantity_unit,serving_quantity,serving_size,nutriments';
    const data = await offGet(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=${fields}`,
      signal
    );
    if (!data || data.status !== 1 || !data.product) return null;
    return mapOffProduct(data.product);
  }

  async function searchOff(query, signal) {
    const params = new URLSearchParams({
      q: query,
      page_size: '12',
      lc: 'cs',
      cc: 'cz',
      fields: 'code,product_name,product_name_cs,brands,quantity,product_quantity,product_quantity_unit,serving_quantity,serving_size,nutriments',
    });
    const data = await offGet(`https://world.openfoodfacts.org/api/v2/search?${params}`, signal);
    const foods = [];
    for (const product of (data && data.products) || []) {
      const food = mapOffProduct(product);
      if (food) foods.push(food);
    }
    return foods;
  }

  function explainMissing(food) {
    toast(`${food.name}: Open Food Facts nemá kcal na 100 g, takže to nepřidám.`, 3800);
  }

  function openAdd(food) {
    openAmount({
      mode: 'add',
      foodId: food.id,
      grams: food.default_serving_g || 100,
      meal: addMeal,
      date: state.selectedDate,
    });
  }

  function openEdit(entry) {
    openAmount({
      mode: 'edit',
      entryId: entry.id,
      foodId: entry.foodId,
      grams: entry.grams,
      meal: entry.meal,
      date: entry.date,
    });
  }

  function openAmount(ctx) {
    const food = foodById(ctx.foodId);
    if (!food) {
      toast('Tu potravinu už v katalogu nemám.');
      return;
    }
    amountCtx = ctx;
    document.getElementById('amount-title').textContent = food.name;
    document.getElementById('amount-sub').textContent =
      `${KCAL.mealLabels[ctx.meal]} · ${formatDate(ctx.date)} · ${food.kcal} kcal / 100 g`;
    const input = document.getElementById('gram-input');
    input.value = String(ctx.grams);
    const pack = document.getElementById('pack-btn');
    if (food.package_g > 0) {
      pack.hidden = false;
      pack.textContent = `Celé balení · ${food.package_g} g`;
    } else {
      pack.hidden = true;
    }
    const piece = document.getElementById('piece-btn');
    if (food.piece_g > 0) {
      piece.hidden = false;
      piece.textContent = `1 kus · ${food.piece_g} g`;
    } else {
      piece.hidden = true;
    }
    const save = document.getElementById('amount-save');
    save.textContent = ctx.mode === 'edit' ? 'Uložit' : 'Přidat';
    document.getElementById('amount-delete').hidden = ctx.mode !== 'edit';
    document.getElementById('amount-back').hidden = false;
    paintPreview();
    input.focus();
    input.select();
  }

  function closeAmount() {
    amountCtx = null;
    const back = document.getElementById('amount-back');
    if (back) back.hidden = true;
  }

  function currentGrams() {
    const grams = num(document.getElementById('gram-input').value);
    if (!Number.isFinite(grams) || grams <= 0) return null;
    return round(grams, 1);
  }

  function paintPreview() {
    const root = document.getElementById('amount-preview');
    const save = document.getElementById('amount-save');
    if (!amountCtx) return;
    const food = foodById(amountCtx.foodId);
    const grams = currentGrams();
    if (!food || grams == null) {
      root.innerHTML = '<p class="preview-empty">Napiš gramy, ať vidíš, co to udělá.</p>';
      save.disabled = true;
      return;
    }
    save.disabled = false;
    const macros = foodMacros(food, grams);
    const totals = dayTotals(amountCtx.date, {
      excludeId: amountCtx.mode === 'edit' ? amountCtx.entryId : null,
      extra: { foodId: food.id, grams },
    });
    const goal = KCAL.goals.kcal;
    const dayLine = `Den pak <b>${totals.kcal}</b> kcal z ${goal}`;
    const gram = (value) => (value == null ? '—' : `${value} g`);
    root.innerHTML = `
      <div class="preview-kicker">${amountCtx.mode === 'edit' ? 'Po úpravě' : 'Tohle přidáš'}</div>
      <div class="preview-kcal"><strong>${macros.kcal}</strong> kcal</div>
      <div class="preview-macros">
        <span>B ${gram(macros.protein)}</span>
        <span>S ${gram(macros.carbs)}</span>
        <span>T ${gram(macros.fat)}</span>
      </div>
      <div class="preview-day">${dayLine}</div>`;
  }

  function commitAmount() {
    if (!amountCtx) return;
    const grams = currentGrams();
    if (grams == null) {
      toast('Zadej gramy větší než 0.');
      return;
    }
    const food = foodById(amountCtx.foodId);
    if (!food) return;
    if (amountCtx.mode === 'edit') {
      const entry = state.diary.find((item) => item.id === amountCtx.entryId);
      if (!entry) {
        closeAmount();
        return;
      }
      entry.grams = grams;
      persist();
      closeAmount();
      toast(`Uloženo: ${food.name} (${grams} g)`);
      renderActive();
      return;
    }
    const meal = amountCtx.meal;
    if (food.off) storeOffFood(food);
    state.diary.push({
      id: nextDiaryId(),
      date: amountCtx.date,
      meal,
      foodId: food.id,
      grams,
    });
    persist();
    closeAmount();
    toast(`Přidáno: ${food.name} (${grams} g) → ${KCAL.mealLabels[meal]}`);
    navigate('dnes');
  }

  function deleteEntry(id, skipConfirm) {
    const entry = state.diary.find((item) => item.id === id);
    if (!entry) return;
    const food = foodById(entry.foodId);
    const name = food ? food.name : 'položku';
    if (!skipConfirm && !window.confirm(`Smazat „${name}“ (${entry.grams} g)?`)) return;
    state.diary = state.diary.filter((item) => item.id !== id);
    persist();
    closeAmount();
    toast('Smazáno.');
    renderActive();
  }

  function openFoodForm(food) {
    foodCtx = food ? { id: food.id, custom: !!food.custom, builtin: !food.custom } : { create: true };
    document.getElementById('food-title').textContent = food ? 'Upravit potravinu' : 'Nová potravina';
    document.getElementById('food-name').value = food ? food.name : '';
    document.getElementById('food-kcal').value = food ? String(food.kcal) : '';
    document.getElementById('food-p').value = food ? String(food.protein) : '';
    document.getElementById('food-c').value = food ? String(food.carbs) : '';
    document.getElementById('food-f').value = food ? String(food.fat) : '';
    document.getElementById('food-pack').value = food && food.package_g ? String(food.package_g) : '';
    const hint = document.getElementById('food-hint');
    hint.textContent = food && !food.custom
      ? 'Úprava startovní potraviny se uloží v telefonu. Mikronutrienty nechávám původní.'
      : 'Hodnoty na 100 g. Vlastní potravina se uloží jen v tomhle telefonu. Mikronutrienty u ní nepočítám.';
    const del = document.getElementById('food-delete');
    del.hidden = !(food && food.custom);
    const reset = document.getElementById('food-reset');
    reset.hidden = !(food && !food.custom && state.foodOverrides[food.id]);
    document.getElementById('food-back').hidden = false;
    document.getElementById('food-name').focus();
  }

  function closeFoodForm() {
    foodCtx = null;
    const back = document.getElementById('food-back');
    if (back) back.hidden = true;
  }

  function readFoodForm() {
    const name = document.getElementById('food-name').value.trim();
    const kcal = num(document.getElementById('food-kcal').value);
    const proteinRaw = document.getElementById('food-p').value.trim();
    const carbsRaw = document.getElementById('food-c').value.trim();
    const fatRaw = document.getElementById('food-f').value.trim();
    const protein = proteinRaw === '' ? 0 : num(proteinRaw);
    const carbs = carbsRaw === '' ? 0 : num(carbsRaw);
    const fat = fatRaw === '' ? 0 : num(fatRaw);
    const packRaw = document.getElementById('food-pack').value.trim();
    const pack = packRaw === '' ? null : num(packRaw);
    if (!name) return { error: 'Napiš název.' };
    if (!Number.isFinite(kcal) || kcal < 0 || kcal > 2000) return { error: 'kcal na 100 g dej mezi 0 a 2000.' };
    if (![protein, carbs, fat].every((n) => Number.isFinite(n) && n >= 0 && n <= 100)) {
      return { error: 'Makra na 100 g dej mezi 0 a 100 g.' };
    }
    if (pack != null && (!Number.isFinite(pack) || pack <= 0 || pack > 20000)) {
      return { error: 'Balení zadej v gramech, nebo nech prázdné.' };
    }
    return { name, kcal, protein, carbs, fat, package_g: pack };
  }

  function saveFoodForm() {
    if (!foodCtx) return;
    const draft = readFoodForm();
    if (draft.error) {
      toast(draft.error, 3200);
      return;
    }
    if (foodCtx.create) {
      state.customFoods.push({
        id: 'u' + Date.now().toString(36),
        name: draft.name,
        kcal: draft.kcal,
        protein: draft.protein,
        carbs: draft.carbs,
        fat: draft.fat,
        fiber: 0,
        custom: true,
        micros: {},
        default_serving_g: 100,
        ...(draft.package_g ? { package_g: draft.package_g } : {}),
      });
      persist();
      closeFoodForm();
      toast(`Uloženo: ${draft.name}`);
      renderPridat();
      return;
    }
    if (foodCtx.custom) {
      const food = state.customFoods.find((item) => item.id === foodCtx.id);
      if (!food) return;
      food.name = draft.name;
      food.kcal = draft.kcal;
      food.protein = draft.protein;
      food.carbs = draft.carbs;
      food.fat = draft.fat;
      if (draft.package_g) food.package_g = draft.package_g;
      else delete food.package_g;
      persist();
      closeFoodForm();
      toast(`Upraveno: ${draft.name}`);
      renderActive();
      return;
    }
    const override = {
      name: draft.name,
      kcal: draft.kcal,
      protein: draft.protein,
      carbs: draft.carbs,
      fat: draft.fat,
      package_g: draft.package_g,
    };
    state.foodOverrides[foodCtx.id] = override;
    persist();
    closeFoodForm();
    toast(`Upraveno: ${draft.name}`);
    renderActive();
  }

  function deleteCustomFood() {
    if (!foodCtx || !foodCtx.custom) return;
    const used = state.diary.some((entry) => entry.foodId === foodCtx.id);
    if (used) {
      toast('Nejdřív ji smaž z deníku — pořád je v nějakém dni.', 3400);
      return;
    }
    const food = state.customFoods.find((item) => item.id === foodCtx.id);
    if (!food) return;
    if (!window.confirm(`Smazat potravinu „${food.name}“?`)) return;
    state.customFoods = state.customFoods.filter((item) => item.id !== foodCtx.id);
    persist();
    closeFoodForm();
    toast('Potravina smazaná.');
    renderPridat();
  }

  function resetBuiltinFood() {
    if (!foodCtx || foodCtx.custom || foodCtx.create) return;
    delete state.foodOverrides[foodCtx.id];
    persist();
    closeFoodForm();
    toast('Vráceno na původní hodnoty.');
    renderActive();
  }

  async function applyBarcode(code) {
    const cleaned = String(code || '').replace(/\D/g, '');
    if (!cleaned) {
      toast('Zadej nebo naskenuj EAN.');
      return;
    }
    document.getElementById('barcode').value = cleaned;
    const local = findByBarcode(cleaned);
    if (local) {
      toast('Načteno: ' + local.name);
      openAdd(local);
      return;
    }
    if (barcodeAbort) barcodeAbort.abort();
    const controller = new AbortController();
    barcodeAbort = controller;
    toast('Hledám kód v Open Food Facts…', 2200);
    try {
      const food = await fetchOffByCode(cleaned, controller.signal);
      if (controller.signal.aborted) return;
      if (!food) {
        toast('V Open Food Facts ten kód není.', 3200);
        return;
      }
      if (food.kcal == null) {
        explainMissing(food);
        return;
      }
      sessionFoods.set(food.id, food);
      toast('Načteno: ' + food.name);
      openAdd(food);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      toast('Open Food Facts teď neodpovídá. Zkus to za chvíli.', 3400);
    }
  }

  function stopScan() {
    scanning = false;
    if (detectTimer) {
      clearInterval(detectTimer);
      detectTimer = null;
    }
    if (zxingControls && typeof zxingControls.stop === 'function') {
      try { zxingControls.stop(); } catch (_) {}
      zxingControls = null;
    }
    if (zxingReader && typeof zxingReader.reset === 'function') {
      try { zxingReader.reset(); } catch (_) {}
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
      mediaStream = null;
    }
    const video = document.getElementById('scan-video');
    if (video) video.srcObject = null;
    const panel = document.getElementById('scan-panel');
    if (panel) panel.hidden = true;
    const btn = document.getElementById('barcode-scan');
    if (btn) btn.disabled = false;
  }

  function loadZXing() {
    if (window.ZXing) return Promise.resolve(window.ZXing);
    if (zxingLoading) return zxingLoading;
    zxingLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
      script.async = true;
      script.onload = () => (window.ZXing ? resolve(window.ZXing) : reject(new Error('ZXing chybí')));
      script.onerror = () => reject(new Error('CDN ZXing se nenačetla (potřebuje síť)'));
      document.head.appendChild(script);
    });
    return zxingLoading;
  }

  async function startNativeDetect(video) {
    const formats = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
    let detector;
    try {
      detector = new BarcodeDetector({ formats });
    } catch (_) {
      detector = new BarcodeDetector();
    }
    detectTimer = setInterval(async () => {
      if (!scanning) return;
      try {
        const codes = await detector.detect(video);
        if (codes && codes.length) {
          const raw = codes[0].rawValue;
          stopScan();
          applyBarcode(raw);
        }
      } catch (_) {
        /* frame skip */
      }
    }, 280);
  }

  async function startZXingDecode(video) {
    const ZXing = await loadZXing();
    zxingReader = new ZXing.BrowserMultiFormatReader();
    const constraints = { audio: false, video: { facingMode: { ideal: 'environment' } } };
    zxingControls = await zxingReader.decodeFromConstraints(constraints, video, (result, err) => {
      if (!scanning) return;
      if (result && result.getText) {
        const text = result.getText();
        stopScan();
        applyBarcode(text);
        return;
      }
      if (err && ZXing.NotFoundException && err instanceof ZXing.NotFoundException) return;
    });
  }

  async function startScan() {
    if (scanning) return;
    if (!window.isSecureContext && location.protocol !== 'http:') {
      toast('Kamera potřebuje HTTPS (nebo localhost). Teď použij opsání EAN nebo fotku níž.', 3800);
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Kamera v tomhle prohlížeči nejde. Opsat EAN nebo fotka níž.', 3200);
      return;
    }
    const panel = document.getElementById('scan-panel');
    const video = document.getElementById('scan-video');
    const btn = document.getElementById('barcode-scan');
    panel.hidden = false;
    btn.disabled = true;
    scanning = true;
    toast('Spouštím kameru…', 1200);
    try {
      if ('BarcodeDetector' in window) {
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' } },
        });
        video.srcObject = mediaStream;
        await video.play();
        await startNativeDetect(video);
      } else {
        await startZXingDecode(video);
      }
    } catch (err) {
      console.warn(err);
      stopScan();
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError');
      toast(
        denied
          ? 'Přístup ke kameře zamítnut — opsat EAN nebo přečíst fotku tady v telefonu.'
          : 'Kameru se nepodařilo spustit — opsat EAN nebo fotka níž.',
        3600
      );
    }
  }

  async function decodeImageFile(file) {
    if (!file) return;
    const preview = document.getElementById('photo-preview');
    const thumb = document.getElementById('photo-thumb');
    const status = document.getElementById('photo-status');
    const url = URL.createObjectURL(file);
    thumb.src = url;
    preview.hidden = false;
    status.textContent = 'Čtu kód jen u tebe…';
    try {
      if ('BarcodeDetector' in window) {
        const bmp = await createImageBitmap(file);
        const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
        const codes = await detector.detect(bmp);
        if (bmp.close) bmp.close();
        if (codes && codes.length) {
          status.textContent = 'Hotovo.';
          applyBarcode(codes[0].rawValue);
          return;
        }
      }
      const ZXing = await loadZXing();
      const reader = new ZXing.BrowserMultiFormatReader();
      const result = await reader.decodeFromImageUrl(url);
      if (result && result.getText) {
        status.textContent = 'Hotovo.';
        applyBarcode(result.getText());
        return;
      }
      status.textContent = 'Nepřečteno.';
      toast('Kód na fotce se nepodařilo přečíst — zkus ostřejší foto nebo opsat číslo.', 3600);
    } catch (err) {
      console.warn(err);
      status.textContent = 'Nepřečteno.';
      toast('Kód na fotce se nepodařilo přečíst — zkus ostřejší foto nebo opsat číslo.', 3600);
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 8000);
    }
  }

  function renderWeek() {
    const start = weekStart(state.selectedDate);
    const root = document.getElementById('week-days');
    root.innerHTML = WEEKDAYS.map((label, index) => {
      const iso = addDays(start, index);
      const kcal = dayTotals(iso).kcal;
      const status = dayBand(kcal);
      const selected = iso === state.selectedDate;
      return `<button type="button" class="day-btn${selected ? ' selected' : ''}" data-date="${iso}" role="option" aria-selected="${selected}" aria-label="${label} ${formatDate(iso)}, ${kcal} kcal, ${bandLabel(status.band)}">
        <span class="mini-ring" aria-hidden="true">
          <svg viewBox="0 0 32 32">
            <circle class="track" cx="16" cy="16" r="${RING_R}"></circle>
            <circle class="fg ${status.band}" data-fill="${status.fill}" cx="16" cy="16" r="${RING_R}"></circle>
          </svg>
        </span>
        <span class="lbl">${label}</span>
      </button>`;
    }).join('');
    root.querySelectorAll('.fg').forEach((circle) => {
      setRing(circle, Number(circle.getAttribute('data-fill')));
    });
    root.querySelectorAll('.day-btn').forEach((btn) => {
      btn.addEventListener('click', () => setSelectedDate(btn.getAttribute('data-date')));
    });
  }

  function renderDnes() {
    const totals = dayTotals(state.selectedDate);
    const goal = KCAL.goals;
    const status = dayBand(totals.kcal);
    const today = state.selectedDate === todayISO();
    paintDate();
    renderWeek();
    document.getElementById('day-heading').textContent = today ? 'Dnes · trénink' : formatDate(state.selectedDate);
    document.getElementById('day-blurb').textContent = today
      ? 'Cíl 2800 kcal. Makra níž, jídla ve slotech.'
      : 'Jiný den. Můžeš dopsat, co už bylo, nebo si jídlo naplánovat.';
    document.getElementById('kcal-total').textContent = String(totals.kcal);
    document.getElementById('kcal-goal').textContent = `z ${goal.kcal}`;
    const ring = document.getElementById('kcal-ring');
    ring.classList.remove('under', 'met', 'over', 'high');
    ring.classList.add(status.band);
    setRing(ring, totals.kcal / goal.kcal);

    const macros = [
      ['p', 'Bílkoviny', totals.protein, goal.protein_g],
      ['c', 'Sacharidy', totals.carbs, goal.carbs_g],
      ['f', 'Tuky', totals.fat, goal.fat_g],
    ];
    document.getElementById('macros').innerHTML = macros
      .map(([cls, label, val, target]) => {
        const pct = Math.min(100, target ? (val / target) * 100 : 0);
        return `<div class="macro-row">
          <div>${label}</div>
          <div class="bar"><div class="fill ${cls}" style="width:${pct}%"></div></div>
          <div class="nums">${round(val)}/${target} g</div>
        </div>`;
      })
      .join('');

    const slots = ['snidane', 'obed', 'svacina', 'vecere'];
    const box = document.getElementById('meals');
    const dayEntries = entriesOn(state.selectedDate);
    box.innerHTML = slots
      .map((slot) => {
        const items = dayEntries.filter((entry) => entry.meal === slot);
        let mealKcal = 0;
        const rows = items
          .map((entry) => {
            const food = foodById(entry.foodId);
            const name = esc(food ? food.name : 'Neznámá potravina');
            const macrosFor = food ? foodMacros(food, entry.grams) : { kcal: 0, protein: null, carbs: null, fat: null };
            if (macrosFor.kcal != null) mealKcal += macrosFor.kcal;
            const bit = (label, value) => `${label} ${value == null ? '—' : value}`;
            return `<div class="food-row" data-entry="${entry.id}">
              <div class="food-main">
                <div>${name}</div>
                <div class="meta">${entry.grams} g · ${bit('B', macrosFor.protein)} · ${bit('S', macrosFor.carbs)} · ${bit('T', macrosFor.fat)}</div>
              </div>
              <div class="food-side">
                <div class="kcal">${macrosFor.kcal == null ? '—' : macrosFor.kcal} kcal</div>
              </div>
              <div class="row-pop" hidden>
                <button type="button" class="pop-rect edit" data-pop-edit="${entry.id}">Upravit</button>
                <button type="button" class="pop-rect del" data-pop-del="${entry.id}">Smazat</button>
              </div>
            </div>`;
          })
          .join('');
        return `<section class="card meal-card" data-meal="${slot}">
          <div class="meal-head">
            <h3>${KCAL.mealLabels[slot]}</h3>
            <div class="meal-kcal">${mealKcal} kcal</div>
          </div>
          ${rows || '<div class="note empty-meal">Zatím prázdné.</div>'}
          <button class="add-slot" type="button" data-add-meal="${slot}">+ Přidat jídlo</button>
        </section>`;
      })
      .join('');

    box.querySelectorAll('[data-add-meal]').forEach((btn) => {
      btn.addEventListener('click', () => {
        addMeal = btn.getAttribute('data-add-meal');
        navigate('pridat');
      });
    });
    box.querySelectorAll('.food-row').forEach((row) => bindRowHold(row));
    box.querySelectorAll('[data-pop-edit]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        hideRowActions();
        const entry = state.diary.find((item) => item.id === btn.getAttribute('data-pop-edit'));
        if (entry) openEdit(entry);
      });
    });
    box.querySelectorAll('[data-pop-del]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        hideRowActions();
        deleteEntry(btn.getAttribute('data-pop-del'));
      });
    });
  }

  function hideRowActions() {
    document.querySelectorAll('.row-pop').forEach((pop) => {
      pop.hidden = true;
    });
    document.querySelectorAll('.food-row.armed').forEach((row) => row.classList.remove('armed'));
  }

  function showRowActions(row) {
    hideRowActions();
    const pop = row.querySelector('.row-pop');
    if (!pop) return;
    pop.hidden = false;
    row.classList.add('armed');
  }

  function cancelHold() {
    if (hold && hold.timer) clearTimeout(hold.timer);
    hold = null;
  }

  function bindRowHold(row) {
    row.addEventListener('pointerdown', (event) => {
      if (event.target.closest('.row-pop')) return;
      if (row.classList.contains('armed')) {
        hideRowActions();
        return;
      }
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      cancelHold();
      const gen = ++pressSerial;
      const timer = setTimeout(() => {
        if (!hold || hold.gen !== gen) return;
        hold = null;
        showRowActions(row);
        if (navigator.vibrate) {
          try { navigator.vibrate(12); } catch (_) {}
        }
      }, 500);
      hold = { gen, timer, x: event.clientX, y: event.clientY, row };
      try { row.setPointerCapture(event.pointerId); } catch (_) {}
    });
    row.addEventListener('pointermove', (event) => {
      if (!hold || hold.row !== row) return;
      if (Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > 12) cancelHold();
    });
    const end = (event) => {
      if (hold && hold.row === row) cancelHold();
      try { row.releasePointerCapture(event.pointerId); } catch (_) {}
    };
    row.addEventListener('pointerup', end);
    row.addEventListener('pointercancel', end);
    row.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  function renderMikro() {
    const totals = dayTotals(state.selectedDate);
    const today = state.selectedDate === todayISO();
    const when = formatDate(state.selectedDate).replace(/\.\s*$/, '');
    document.getElementById('mikro-note').textContent = today
      ? 'Vitaminy a minerály vs. denní orientační cíl (EFSA, dospělý muž). Není to lékařská rada — jen přehled, co dnes jsi pokryl.'
      : `Vitaminy a minerály za ${when}. Není to lékařská rada — jen přehled, co ten den vyšlo.`;
    const root = document.getElementById('mikro-list');
    root.innerHTML = KCAL.themes
      .map((theme) => {
        const nutrients = KCAL.targets.filter((target) => target.theme === theme.id);
        const rows = nutrients
          .map((target) => {
            const val = totals.micros[target.key] || 0;
            const pct = (val / target.target) * 100;
            const pctShow = Math.min(999, Math.round(pct));
            const bar = Math.min(100, pct);
            let cls = 'low';
            if (pct >= 85) cls = 'ok';
            else if (pct >= 45) cls = 'mid';
            const valTxt = val < 10 ? round(val, 2) : round(val, 1);
            return `<div class="nutrient">
              <div><strong>${target.label}</strong></div>
              <div class="pct ${cls}">${pctShow}%</div>
              <div class="hint">${target.hint} · ${valTxt} / ${target.target} ${target.unit}</div>
              <div class="mini-bar"><i style="width:${bar}%"></i></div>
            </div>`;
          })
          .join('');
        return `<section class="theme-block">
          <h3><span class="theme-dot ${theme.id}"></span>${theme.label}</h3>
          <div class="card" style="padding-top:4px;padding-bottom:4px">${rows}</div>
        </section>`;
      })
      .join('');
  }

  function renderZasoby() {
    document.querySelectorAll('.loc-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.loc === pantryLoc);
    });
    const list = KCAL.pantry.filter((item) => item.loc === pantryLoc);
    const root = document.getElementById('pantry-list');
    if (!list.length) {
      root.innerHTML = '<p class="note">Tady nic není.</p>';
      return;
    }
    const soonLimit = addDays(todayISO(), 4);
    root.innerHTML = list
      .map((item) => {
        const food = foodById(item.foodId);
        const name = esc(food ? food.name : 'Neznámá potravina');
        const soon = item.expiry <= soonLimit;
        const qty = item.unit === 'ks' ? `${item.qty} ks` : item.unit === 'ml' ? `${item.qty} ml` : `${item.qty} g`;
        return `<div class="pantry-item">
          <div>
            <div>${name}</div>
            <div class="sub">${qty}${item.opened ? ' · otevřeno' : ''} · do ${item.expiry.split('-').reverse().join('.')}</div>
          </div>
          <div><span class="badge ${soon ? 'soon' : ''}">${soon ? 'brzy' : KCAL.locLabels[item.loc]}</span></div>
        </div>`;
      })
      .join('');
  }

  function foodCard(food, remote) {
    const pack = food.package_g ? ` · balení ${food.package_g} g` : '';
    const own = food.custom ? ' · vlastní' : '';
    const source = remote ? ' · Open Food Facts' : own;
    const missing = food.kcal == null;
    const kcal = missing ? 'bez kcal' : `${food.kcal} kcal/100 g`;
    const macros = missing
      ? 'Open Food Facts u tohohle nemá výživu na 100 g'
      : `B ${food.protein == null ? '—' : food.protein} · S ${food.carbs == null ? '—' : food.carbs} · T ${food.fat == null ? '—' : food.fat}${pack}${source}`;
    const attr = remote ? `data-off="${esc(food.id)}"` : `data-food="${esc(food.id)}"`;
    const edit = remote || food.off
      ? ''
      : `<button type="button" class="food-edit-link" data-edit-food="${esc(food.id)}">Upravit</button>`;
    return `<div class="food-pick-row">
      <button type="button" class="food-pick${remote ? ' off' : ''}${missing ? ' missing' : ''}" ${attr}>
        <div>${esc(food.name)}</div>
        <div class="right">${kcal}</div>
        <div class="sub">${macros}</div>
      </button>
      ${edit}
    </div>`;
  }

  function paintFoodList(remote) {
    const query = (document.getElementById('food-search').value || '').trim().toLowerCase();
    const local = catalog().filter((food) => !query || food.name.toLowerCase().includes(query));
    const known = new Set(local.map((food) => food.barcode).filter(Boolean));
    const extra = (remote || []).filter((food) => food.barcode && !known.has(food.barcode));
    extra.forEach((food) => shownOff.set(food.id, food));
    const root = document.getElementById('food-results');
    if (!local.length && !extra.length) {
      root.innerHTML = query.length >= 2
        ? '<p class="note">Nic v telefonu. Když Open Food Facts něco najde, objeví se to tady.</p>'
        : '<p class="note">Nic takového nemám. Přidej si vlastní potravinu.</p>';
      return;
    }
    root.innerHTML = local.map((food) => foodCard(food, false)).join('')
      + extra.map((food) => foodCard(food, true)).join('');
    root.querySelectorAll('[data-food]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const food = foodById(btn.dataset.food);
        if (food) openAdd(food);
      });
    });
    root.querySelectorAll('[data-off]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const food = shownOff.get(btn.dataset.off) || sessionFoods.get(btn.dataset.off) || foodById(btn.dataset.off);
        if (!food) return;
        if (food.kcal == null) {
          explainMissing(food);
          return;
        }
        sessionFoods.set(food.id, food);
        openAdd(food);
      });
    });
    root.querySelectorAll('[data-edit-food]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const food = foodById(btn.getAttribute('data-edit-food'));
        if (food) openFoodForm(food);
      });
    });
  }

  function scheduleOff(query) {
    clearTimeout(offTimer);
    const trimmed = query.trim();
    const status = document.getElementById('off-status');
    if (trimmed.length < 2) {
      if (offAbort) offAbort.abort();
      offHits = [];
      offFor = '';
      if (status) status.textContent = '';
      return;
    }
    if (status) status.textContent = 'Hledám v Open Food Facts…';
    offTimer = setTimeout(() => { runOff(trimmed); }, 350);
  }

  async function runOff(query) {
    const token = ++offToken;
    if (offAbort) offAbort.abort();
    const controller = new AbortController();
    offAbort = controller;
    const status = document.getElementById('off-status');
    try {
      const foods = await searchOff(query, controller.signal);
      if (token !== offToken) return;
      offHits = foods;
      offFor = query;
      const current = (document.getElementById('food-search').value || '').trim();
      if (current.toLowerCase() !== query.toLowerCase()) return;
      const known = new Set(catalog().map((food) => food.barcode).filter(Boolean));
      const fresh = foods.filter((food) => !known.has(food.barcode));
      paintFoodList(foods);
      if (status) {
        status.textContent = fresh.length
          ? 'Níže jsou i výrobky z Open Food Facts.'
          : 'V Open Food Facts nic dalšího.';
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (token !== offToken) return;
      if (status) status.textContent = 'Open Food Facts teď neodpovídá.';
    }
  }

  function renderPridat() {
    paintDate();
    document.querySelectorAll('.meal-pick button').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.meal === addMeal);
    });
    document.getElementById('add-target').textContent =
      `Zapisuješ do ${formatDate(state.selectedDate)} · ${KCAL.mealLabels[addMeal]}. Nejdřív zvolíš gramy.`;
    const query = (document.getElementById('food-search').value || '').trim();
    paintFoodList(query.toLowerCase() === offFor.toLowerCase() ? offHits : []);
    scheduleOff(query);
  }

  function renderActive() {
    const active = document.querySelector('.screen.active');
    const name = active ? active.id.replace('screen-', '') : 'dnes';
    paintDate();
    if (name === 'dnes') renderDnes();
    else if (name === 'mikro') renderMikro();
    else if (name === 'zasoby') renderZasoby();
    else if (name === 'pridat') renderPridat();
  }

  function navigate(name) {
    if (!['dnes', 'mikro', 'zasoby', 'pridat'].includes(name)) name = 'dnes';
    hideRowActions();
    if (name !== 'pridat') stopScan();
    history.replaceState(null, '', '#' + name);
    document.querySelectorAll('.screen').forEach((screen) => {
      screen.classList.toggle('active', screen.id === 'screen-' + name);
    });
    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.nav === name);
    });
    if (name === 'dnes') renderDnes();
    if (name === 'mikro') renderMikro();
    if (name === 'zasoby') renderZasoby();
    if (name === 'pridat') renderPridat();
  }

  function stepGrams(delta) {
    const input = document.getElementById('gram-input');
    const current = num(input.value);
    const base = Number.isFinite(current) ? current : 0;
    const next = Math.max(1, round(base + delta, 1));
    input.value = String(next);
    paintPreview();
  }

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => navigate(btn.dataset.nav));
  });
  document.querySelectorAll('.loc-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      pantryLoc = btn.dataset.loc;
      renderZasoby();
    });
  });
  document.querySelectorAll('.meal-pick button').forEach((btn) => {
    btn.addEventListener('click', () => {
      addMeal = btn.dataset.meal;
      renderPridat();
    });
  });
  document.getElementById('food-search').addEventListener('input', renderPridat);
  document.getElementById('new-food').addEventListener('click', () => openFoodForm(null));

  document.getElementById('week-prev').addEventListener('click', () => {
    setSelectedDate(addDays(state.selectedDate, -7));
  });
  document.getElementById('week-next').addEventListener('click', () => {
    setSelectedDate(addDays(state.selectedDate, 7));
  });
  document.getElementById('date-input').addEventListener('change', (event) => {
    if (isISO(event.target.value)) setSelectedDate(event.target.value);
  });
  document.getElementById('jump-today').addEventListener('click', () => setSelectedDate(todayISO()));

  document.getElementById('gram-input').addEventListener('input', paintPreview);
  document.getElementById('gram-minus').addEventListener('click', () => stepGrams(-10));
  document.getElementById('gram-plus').addEventListener('click', () => stepGrams(10));
  document.getElementById('pack-btn').addEventListener('click', () => {
    if (!amountCtx) return;
    const food = foodById(amountCtx.foodId);
    if (!food || !food.package_g) return;
    document.getElementById('gram-input').value = String(food.package_g);
    paintPreview();
  });
  document.getElementById('piece-btn').addEventListener('click', () => {
    if (!amountCtx) return;
    const food = foodById(amountCtx.foodId);
    if (!food || !food.piece_g) return;
    document.getElementById('gram-input').value = String(food.piece_g);
    paintPreview();
  });
  document.getElementById('amount-cancel').addEventListener('click', closeAmount);
  document.getElementById('amount-save').addEventListener('click', commitAmount);
  document.getElementById('amount-delete').addEventListener('click', () => {
    if (amountCtx && amountCtx.entryId) deleteEntry(amountCtx.entryId);
  });
  document.getElementById('amount-back').addEventListener('click', (event) => {
    if (event.target.id === 'amount-back') closeAmount();
  });
  document.getElementById('gram-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') commitAmount();
  });

  document.getElementById('food-cancel').addEventListener('click', closeFoodForm);
  document.getElementById('food-save').addEventListener('click', saveFoodForm);
  document.getElementById('food-delete').addEventListener('click', deleteCustomFood);
  document.getElementById('food-reset').addEventListener('click', resetBuiltinFood);
  document.getElementById('food-back').addEventListener('click', (event) => {
    if (event.target.id === 'food-back') closeFoodForm();
  });

  document.getElementById('barcode-scan').addEventListener('click', startScan);
  document.getElementById('scan-stop').addEventListener('click', stopScan);
  document.getElementById('barcode-go').addEventListener('click', () => {
    applyBarcode(document.getElementById('barcode').value);
  });
  document.getElementById('barcode').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') applyBarcode(event.target.value);
  });
  document.getElementById('barcode-camera').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    decodeImageFile(file);
    event.target.value = '';
  });
  document.getElementById('barcode-gallery').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    decodeImageFile(file);
    event.target.value = '';
  });

  document.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.row-pop') || event.target.closest('.food-row')) return;
    hideRowActions();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    hideRowActions();
    if (!document.getElementById('amount-back').hidden) closeAmount();
    else if (!document.getElementById('food-back').hidden) closeFoodForm();
  });

  window.addEventListener('pagehide', stopScan);
  window.addEventListener('beforeunload', stopScan);

  loadState();
  const hash = (location.hash || '#dnes').slice(1);
  navigate(hash);
})();
