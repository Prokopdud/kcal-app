(async function () {
  const LEGACY_KEY = 'kcal-app-state-v1';
  const IMPORT_FLAG = 'kcal-app-import-done-v1';
  const UI_KEY = 'kcal-app-ui-v1';
  const APP_ROUTES = ['dnes', 'mikro', 'zasoby', 'pridat', 'nastaveni'];
  const WEEKDAYS = ['Po', 'Ú', 'St', 'Č', 'Pá', 'So', 'Ne'];
  const RING_R = 11;

  const initialHash = location.hash || '';
  let recoveryPending = initialHash.includes('type=recovery');
  let pendingAuthError = '';
  if (initialHash.includes('error=')) {
    const params = new URLSearchParams(initialHash.replace(/^#/, ''));
    pendingAuthError = params.get('error_description') || 'Odkaz vypršel. Pošli si nový.';
  }

  let supabase = null;
  try {
    const mod = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm');
    const cfg = window.KCAL_SUPABASE || {};
    if (!cfg.url || !cfg.publishableKey) throw new Error('missing config');
    supabase = mod.createClient(cfg.url, cfg.publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'implicit',
      },
    });
  } catch (err) {
    console.warn(err);
    const error = document.getElementById('auth-error');
    if (error) {
      error.hidden = false;
      error.textContent = 'Přihlášení se nenačetlo. Zkontroluj připojení a obnov stránku.';
    }
    return;
  }

  let addMeal = 'obed';
  let pantryLoc = 'lednice';
  let state = {
    selectedDate: null,
    openedOn: null,
    diary: [],
    goals: [],
    pantry: [],
    ready: false,
  };
  let dbFoods = [];
  let sessionUser = null;
  let appUserId = null;
  let activeLoad = null;
  let authMode = 'login';
  let amountCtx = null;
  let foodCtx = null;
  let saving = false;

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
    if (value == null || value === '') return NaN;
    return parseFloat(String(value).replace(',', '.').trim());
  }

  function fold(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  function normalizeBarcode(code) {
    const cleaned = String(code || '').replace(/\D/g, '');
    return /^[0-9]{6,14}$/.test(cleaned) ? cleaned : '';
  }

  function positiveOrNull(value) {
    const n = num(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  }

  function optionalMacro(value) {
    if (value == null || value === '') return null;
    const n = num(value);
    return Number.isFinite(n) ? n : null;
  }

  function scaled(value, grams, digits) {
    const n = num(value);
    if (!Number.isFinite(n)) return null;
    return round(n * (grams / 100), digits);
  }

  function scaleMicros(micros, scale, digits) {
    const out = {};
    if (!micros || typeof micros !== 'object') return out;
    for (const [key, value] of Object.entries(micros)) {
      const n = num(value);
      if (!Number.isFinite(n)) continue;
      out[key] = round(n * scale, digits);
    }
    return out;
  }

  function totalsFromPer100(per100, grams) {
    const scale = grams / 100;
    return {
      kcal: round(num(per100.kcal) * scale, 2),
      protein: scaled(per100.protein, grams, 2),
      carbs: scaled(per100.carbs, grams, 2),
      fat: scaled(per100.fat, grams, 2),
      fiber: scaled(per100.fiber, grams, 2),
      micros: scaleMicros(per100.micros, scale, 4),
    };
  }

  function snapshotFromFood(food, grams) {
    const per100 = {
      kcal: num(food.kcal),
      protein: optionalMacro(food.protein),
      carbs: optionalMacro(food.carbs),
      fat: optionalMacro(food.fat),
      fiber: optionalMacro(food.fiber),
      micros: food.micros && typeof food.micros === 'object' ? food.micros : {},
    };
    const scaledTotals = totalsFromPer100(per100, grams);
    return {
      food_name_snapshot: String(food.name).slice(0, 200),
      kcal_per_100g: per100.kcal,
      protein_per_100g: per100.protein,
      carbs_per_100g: per100.carbs,
      fat_per_100g: per100.fat,
      fiber_per_100g: per100.fiber,
      micros_per_100g: per100.micros,
      kcal: scaledTotals.kcal,
      protein: scaledTotals.protein,
      carbs: scaledTotals.carbs,
      fat: scaledTotals.fat,
      fiber: scaledTotals.fiber,
      micros: scaledTotals.micros,
    };
  }

  function addNum(sum, value) {
    const n = num(value);
    return Number.isFinite(n) ? sum + n : sum;
  }

  /* Green: at the goal, slack up to about +3% or +80 kcal.
     Orange: a bit over, up to about +10% or +250 kcal.
     Red: above that. Gray: under the goal. No goal: a short teal arc if anything was logged. */
  function dayBand(kcal, goalKcal) {
    const eaten = Math.max(0, Number(kcal) || 0);
    const goal = Number(goalKcal);
    if (!Number.isFinite(goal) || goal <= 0) {
      return eaten > 0 ? { band: 'logged', fill: 0.35 } : { band: 'none', fill: 0 };
    }
    if (eaten < goal) return { band: 'under', fill: eaten / goal };
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
    if (band === 'logged' || band === 'none') return 'bez cíle';
    return 'pod cílem';
  }

  function mapDbFood(row) {
    return {
      dbId: row.id,
      id: row.legacy_id || ('db:' + row.id),
      legacyId: row.legacy_id || null,
      name: row.name,
      brand: row.brand || '',
      barcode: row.barcode || '',
      kcal: num(row.kcal),
      protein: optionalMacro(row.protein),
      carbs: optionalMacro(row.carbs),
      fat: optionalMacro(row.fat),
      fiber: optionalMacro(row.fiber),
      micros: row.micros || {},
      package_g: positiveOrNull(row.package_g),
      piece_g: positiveOrNull(row.piece_g),
      default_serving_g: positiveOrNull(row.default_serving_g) || 100,
      source: row.source,
      owned: !!row.owner_id,
      custom: !!row.owner_id,
      off: row.source === 'off',
    };
  }

  function mapBundled(food) {
    const id = String(food.id);
    return {
      dbId: null,
      id,
      legacyId: id,
      name: food.name,
      brand: food.brand || '',
      barcode: food.barcode ? String(food.barcode) : '',
      kcal: num(food.kcal),
      protein: optionalMacro(food.protein),
      carbs: optionalMacro(food.carbs),
      fat: optionalMacro(food.fat),
      fiber: optionalMacro(food.fiber),
      micros: food.micros || {},
      package_g: positiveOrNull(food.package_g),
      piece_g: positiveOrNull(food.piece_g),
      default_serving_g: positiveOrNull(food.default_serving_g) || 100,
      source: id.startsWith('off:') ? 'off' : 'builtin',
      owned: false,
      custom: false,
      off: id.startsWith('off:'),
    };
  }

  function catalog() {
    const byLegacy = new Map();
    const byBarcode = new Map();
    for (const row of dbFoods) {
      const food = mapDbFood(row);
      if (food.legacyId) byLegacy.set(food.legacyId, food);
      if (food.barcode) byBarcode.set(String(food.barcode), food);
    }
    const list = [];
    const seenDb = new Set();
    for (const raw of KCAL.foods || []) {
      const fromDb = byLegacy.get(raw.id) || (raw.barcode && byBarcode.get(String(raw.barcode)));
      const food = fromDb || mapBundled(raw);
      list.push(food);
      if (food.dbId != null) seenDb.add(food.dbId);
    }
    const extras = [];
    for (const row of dbFoods) {
      if (seenDb.has(row.id)) continue;
      extras.push(mapDbFood(row));
      seenDb.add(row.id);
    }
    extras.sort((a, b) => a.name.localeCompare(b.name, 'cs'));
    list.push(...extras);
    sessionFoods.forEach((food) => {
      if (list.some((item) => item.id === food.id || (food.barcode && item.barcode === food.barcode))) return;
      list.push(food);
    });
    return list;
  }

  function foodById(id) {
    if (id == null || id === '') return null;
    const key = String(id);
    return catalog().find((food) => food.id === key || String(food.dbId) === key || food.legacyId === key) || null;
  }

  function goalsFor(date) {
    let best = null;
    for (const row of state.goals) {
      if (row.effective_from <= date && (!best || row.effective_from > best.effective_from)) best = row;
    }
    return best;
  }

  function entriesOn(date) {
    return state.diary.filter((entry) => entry.date === date);
  }

  function dayTotals(date, opts) {
    const options = opts || {};
    const totals = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, micros: {} };
    const rows = entriesOn(date).filter((entry) => entry.id !== options.excludeId);
    for (const entry of rows) {
      totals.kcal = addNum(totals.kcal, entry.kcal);
      totals.protein = addNum(totals.protein, entry.protein);
      totals.carbs = addNum(totals.carbs, entry.carbs);
      totals.fat = addNum(totals.fat, entry.fat);
      totals.fiber = addNum(totals.fiber, entry.fiber);
      for (const [key, value] of Object.entries(entry.micros || {})) {
        const n = num(value);
        if (!Number.isFinite(n)) continue;
        totals.micros[key] = (totals.micros[key] || 0) + n;
      }
    }
    totals.kcal = round(totals.kcal);
    totals.protein = round(totals.protein, 1);
    totals.carbs = round(totals.carbs, 1);
    totals.fat = round(totals.fat, 1);
    totals.fiber = round(totals.fiber, 1);
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

  function persistUi() {
    try {
      localStorage.setItem(UI_KEY, JSON.stringify({
        selectedDate: state.selectedDate,
        openedOn: state.openedOn,
      }));
    } catch (_) {
      /* the diary itself is in Supabase */
    }
  }

  function readLegacy() {
    try {
      const raw = localStorage.getItem(LEGACY_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function loadUiDate() {
    const today = todayISO();
    try {
      const saved = JSON.parse(localStorage.getItem(UI_KEY) || 'null');
      if (saved && saved.openedOn === today && isISO(saved.selectedDate)) return saved.selectedDate;
    } catch (_) {}
    const legacy = readLegacy();
    if (legacy && legacy.openedOn === today && isISO(legacy.selectedDate)) return legacy.selectedDate;
    return today;
  }

  function hasRealLegacy(saved) {
    if (!saved) return false;
    const diary = Array.isArray(saved.diary) ? saved.diary : [];
    if (diary.some((entry) => entry && entry.id && !/^d\d{1,2}$/.test(String(entry.id)))) return true;
    if (Array.isArray(saved.customFoods) && saved.customFoods.length) return true;
    if (Array.isArray(saved.offFoods) && saved.offFoods.length) return true;
    if (saved.foodOverrides && typeof saved.foodOverrides === 'object' && Object.keys(saved.foodOverrides).length) return true;
    return false;
  }

  function cleanImportFood(food) {
    if (!food || typeof food !== 'object') return null;
    const copy = { ...food };
    const code = normalizeBarcode(copy.barcode);
    if (code) copy.barcode = code;
    else delete copy.barcode;
    return copy;
  }

  async function maybeImport(userId) {
    if (localStorage.getItem(IMPORT_FLAG)) return null;
    const saved = readLegacy();
    if (!hasRealLegacy(saved)) {
      localStorage.setItem(IMPORT_FLAG, userId);
      return null;
    }
    const payload = {
      diary: saved.diary || [],
      customFoods: (saved.customFoods || []).map(cleanImportFood).filter(Boolean),
      offFoods: (saved.offFoods || []).map(cleanImportFood).filter(Boolean),
      foodOverrides: saved.foodOverrides || {},
    };
    const { data, error } = await supabase.rpc('import_local_state', { payload });
    if (error) throw error;
    localStorage.setItem(IMPORT_FLAG, userId);
    return data;
  }

  function mapGoal(row) {
    return {
      id: row.id,
      effective_from: row.effective_from,
      kcal: num(row.kcal),
      protein_g: num(row.protein_g),
      carbs_g: num(row.carbs_g),
      fat_g: num(row.fat_g),
      fiber_g: row.fiber_g == null ? null : num(row.fiber_g),
    };
  }

  function mapEntry(row) {
    const per = (value) => (value == null || value === '' ? null : num(value));
    return {
      id: String(row.id),
      dbId: row.id,
      date: row.eaten_on,
      meal: row.meal,
      foodId: row.food_id == null ? null : String(row.food_id),
      grams: num(row.grams),
      name: row.food_name_snapshot,
      kcal: per(row.kcal),
      protein: per(row.protein),
      carbs: per(row.carbs),
      fat: per(row.fat),
      fiber: per(row.fiber),
      micros: row.micros || {},
      per100: {
        kcal: per(row.kcal_per_100g),
        protein: per(row.protein_per_100g),
        carbs: per(row.carbs_per_100g),
        fat: per(row.fat_per_100g),
        fiber: per(row.fiber_per_100g),
        micros: row.micros_per_100g || {},
      },
    };
  }

  function mapPantry(row) {
    const embedded = Array.isArray(row.foods) ? row.foods[0] : row.foods;
    const local = dbFoods.find((item) => item.id === row.food_id);
    return {
      id: row.id,
      foodId: row.food_id,
      name: (embedded && embedded.name) || (local && local.name) || 'Neznámá potravina',
      loc: row.loc,
      qty: num(row.quantity),
      unit: row.unit,
      expiry: row.expiry,
      opened: !!row.opened,
    };
  }

  function rememberFood(row) {
    const index = dbFoods.findIndex((item) => item.id === row.id);
    if (index >= 0) dbFoods[index] = row;
    else dbFoods.push(row);
  }

  async function refreshPantry() {
    const embedded = await supabase
      .from('pantry_items')
      .select('id, loc, quantity, unit, expiry, opened, food_id, foods(name)')
      .order('id');
    if (!embedded.error) {
      state.pantry = (embedded.data || []).map(mapPantry);
      return;
    }
    const plain = await supabase
      .from('pantry_items')
      .select('id, loc, quantity, unit, expiry, opened, food_id')
      .order('id');
    if (plain.error) throw plain.error;
    state.pantry = (plain.data || []).map(mapPantry);
  }

  async function loadAll(session) {
    let imported = null;
    try {
      imported = await maybeImport(session.user.id);
    } catch (err) {
      console.warn(err);
      toast('Starý deník z prohlížeče se nepodařilo přenést. Obnov stránku a zkus to znovu.', 4200);
    }
    const [foodsRes, diaryRes, goalsRes] = await Promise.all([
      supabase.from('foods').select('*').order('name'),
      supabase.from('diary_entries').select('*').order('id', { ascending: true }),
      supabase.from('user_goals').select('id, effective_from, kcal, protein_g, carbs_g, fat_g, fiber_g').order('effective_from'),
    ]);
    if (foodsRes.error) throw foodsRes.error;
    if (diaryRes.error) throw diaryRes.error;
    if (goalsRes.error) throw goalsRes.error;
    dbFoods = foodsRes.data || [];
    state.diary = (diaryRes.data || []).map(mapEntry);
    state.goals = (goalsRes.data || []).map(mapGoal);
    await refreshPantry();
    const today = todayISO();
    state.selectedDate = loadUiDate();
    state.openedOn = today;
    state.ready = true;
    if (imported && Number(imported.entries_imported) > 0) {
      toast(`Přenesený deník: ${imported.entries_imported} zápisů.`, 3600);
    } else if (imported && Number(imported.foods_upserted) > 0) {
      toast('Vlastní potraviny jsou v účtu.', 3200);
    }
  }

  async function ensureFoodRow(food) {
    if (!food) throw new Error('missing food');
    if (food.dbId) return food.dbId;
    const userId = sessionUser && sessionUser.id;
    if (!userId) throw new Error('no session');
    const legacy = food.legacyId || (food.id && !String(food.id).startsWith('db:') ? String(food.id) : null);
    const barcode = normalizeBarcode(food.barcode);
    const owned = dbFoods.find((row) => row.owner_id && (
      (legacy && row.legacy_id === legacy) || (barcode && row.barcode === barcode)
    ));
    if (owned) return owned.id;
    const shared = dbFoods.find((row) => !row.owner_id && legacy && row.legacy_id === legacy);
    if (shared && !food.off && food.source !== 'off') return shared.id;
    const source = food.off || (legacy && String(legacy).startsWith('off:')) ? 'off' : 'manual';
    const payload = {
      owner_id: userId,
      source,
      legacy_id: legacy,
      barcode: barcode || null,
      name: String(food.name || '').trim().slice(0, 80),
      kcal: num(food.kcal),
      protein: optionalMacro(food.protein),
      carbs: optionalMacro(food.carbs),
      fat: optionalMacro(food.fat),
      fiber: optionalMacro(food.fiber),
      micros: food.micros && typeof food.micros === 'object' ? food.micros : {},
      package_g: positiveOrNull(food.package_g),
      piece_g: positiveOrNull(food.piece_g),
      default_serving_g: positiveOrNull(food.default_serving_g) || 100,
    };
    if (!payload.name || !Number.isFinite(payload.kcal)) throw new Error('invalid food');
    const { data, error } = await supabase.from('foods').insert(payload).select('*').single();
    if (error) {
      if (error.code === '23505') {
        const { data: rows, error: readError } = await supabase.from('foods').select('*').eq('owner_id', userId);
        if (readError) throw error;
        for (const row of rows || []) rememberFood(row);
        const again = (rows || []).find((row) => (legacy && row.legacy_id === legacy) || (barcode && row.barcode === barcode));
        if (again) return again.id;
      }
      throw error;
    }
    rememberFood(data);
    if (food.id) sessionFoods.delete(food.id);
    return data.id;
  }

  function redirectUrl() {
    const url = new URL(location.href);
    url.hash = '';
    url.search = '';
    return url.origin + url.pathname;
  }

  function czechAuthError(err) {
    const code = String((err && (err.code || err.error_code)) || '');
    const msg = String((err && err.message) || '');
    const hay = (code + ' ' + msg).toLowerCase();
    if (code === 'password_mismatch') return 'Hesla se neshodují.';
    if (hay.includes('invalid_credentials') || hay.includes('invalid login')) return 'E-mail nebo heslo nesedí.';
    if (hay.includes('email_not_confirmed') || hay.includes('not confirmed')) return 'Nejdřív potvrď e-mail, pak se přihlas.';
    if (hay.includes('user_already_exists') || hay.includes('already registered') || hay.includes('already been registered')) {
      return 'Účet s tímhle e-mailem už existuje. Přihlas se.';
    }
    if (hay.includes('email_address_not_authorized')) return 'Na tuhle adresu teď nejde poslat e-mail.';
    if (hay.includes('over_email_send_rate_limit') || hay.includes('email rate limit')) return 'E-mailů bylo moc najednou. Zkus to za chvíli.';
    if (hay.includes('email_address_invalid') || (hay.includes('invalid') && hay.includes('email'))) return 'E-mail nevypadá správně.';
    if (hay.includes('weak_password') || (hay.includes('password') && (hay.includes('short') || hay.includes('least') || hay.includes('6')))) {
      return 'Heslo musí mít aspoň 6 znaků.';
    }
    if (hay.includes('redirect')) return 'Tahle adresa není v Supabase povolená jako návrat z e-mailu.';
    return 'Nepovedlo se to. Zkus to znovu.';
  }

  function showAuthError(message) {
    const error = document.getElementById('auth-error');
    const info = document.getElementById('auth-info');
    if (info) info.hidden = true;
    if (!error) return;
    error.hidden = !message;
    error.textContent = message || '';
  }

  function showAuthInfo(message) {
    const error = document.getElementById('auth-error');
    const info = document.getElementById('auth-info');
    if (error) error.hidden = true;
    if (!info) return;
    info.hidden = !message;
    info.textContent = message || '';
  }

  function showAuthMode(mode) {
    authMode = mode;
    const titles = {
      login: 'Přihlášení',
      signup: 'Nový účet',
      reset: 'Zapomenuté heslo',
      recovery: 'Nové heslo',
    };
    const leads = {
      login: 'Deník, potraviny a cíle se ukládají k tvému účtu.',
      signup: 'Po odeslání přijde e-mail s odkazem. Heslo má aspoň 6 znaků.',
      reset: 'Pošleme odkaz na nové heslo. Otevři ho v tomhle prohlížeči.',
      recovery: 'Nastav si nové heslo k tomuto účtu.',
    };
    const submits = {
      login: 'Přihlásit se',
      signup: 'Vytvořit účet',
      reset: 'Poslat odkaz',
      recovery: 'Uložit heslo',
    };
    document.getElementById('auth-title').textContent = titles[mode];
    document.getElementById('auth-lead').textContent = leads[mode];
    document.getElementById('auth-form').hidden = false;
    document.getElementById('auth-links').hidden = mode === 'recovery';
    document.getElementById('auth-email-field').hidden = mode === 'recovery';
    document.getElementById('auth-password-field').hidden = mode === 'reset';
    document.getElementById('auth-password2-field').hidden = mode !== 'signup' && mode !== 'recovery';
    document.getElementById('auth-submit').textContent = submits[mode];
    document.getElementById('auth-submit').disabled = false;
    const password = document.getElementById('auth-password');
    password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    password.placeholder = '';
    document.getElementById('auth-password-label').textContent = mode === 'recovery' ? 'Nové heslo' : 'Heslo';
    const toggle = document.getElementById('auth-toggle');
    const reset = document.getElementById('auth-reset');
    if (mode === 'login') {
      toggle.hidden = false;
      toggle.textContent = 'Nemám účet — vytvořit';
      reset.hidden = false;
      reset.textContent = 'Zapomenuté heslo';
    } else if (mode === 'signup') {
      toggle.hidden = false;
      toggle.textContent = 'Už účet mám — přihlásit';
      reset.hidden = true;
    } else if (mode === 'reset') {
      toggle.hidden = false;
      toggle.textContent = 'Zpět na přihlášení';
      reset.hidden = true;
    }
    showShell('auth');
  }

  function showLoading(message) {
    document.getElementById('auth-title').textContent = message;
    document.getElementById('auth-lead').textContent = 'Chvilku.';
    document.getElementById('auth-form').hidden = true;
    document.getElementById('auth-links').hidden = true;
    showAuthError('');
    showShell('auth');
  }

  function showShell(mode) {
    const loggedIn = mode === 'app';
    document.getElementById('bottom-nav').hidden = !loggedIn;
    document.getElementById('open-settings').hidden = !loggedIn;
    document.getElementById('date-pill').hidden = !loggedIn;
    if (!loggedIn) {
      document.querySelectorAll('.screen').forEach((screen) => {
        screen.classList.toggle('active', screen.id === 'screen-auth');
      });
    }
  }

  function routeFromHash() {
    const raw = (location.hash || '').replace(/^#/, '');
    if (!raw || raw.includes('=') || raw.includes('&')) return 'dnes';
    return APP_ROUTES.includes(raw) ? raw : 'dnes';
  }

  function cleanAuthHash() {
    const hash = location.hash || '';
    if (!(hash.includes('access_token') || hash.includes('error=') || hash.includes('refresh_token'))) return;
    const route = recoveryPending ? '' : '#' + routeFromHash();
    history.replaceState(null, '', location.pathname + location.search + route);
  }

  async function enterApp(session) {
    if (!session || !session.user || recoveryPending) return;
    if (appUserId === session.user.id && state.ready) {
      showShell('app');
      navigate(routeFromHash());
      return;
    }
    if (activeLoad) return activeLoad;
    activeLoad = (async () => {
      sessionUser = session.user;
      showLoading('Načítám deník…');
      try {
        await loadAll(session);
        appUserId = session.user.id;
        cleanAuthHash();
        showShell('app');
        navigate(routeFromHash());
      } catch (err) {
        console.warn(err);
        state.ready = false;
        appUserId = null;
        showAuthMode('login');
        showAuthError('Deník se nepodařilo načíst. Zkus to znovu.');
      } finally {
        activeLoad = null;
      }
    })();
    return activeLoad;
  }

  function onAuth(event, session) {
    cleanAuthHash();
    if (recoveryPending || event === 'PASSWORD_RECOVERY') {
      recoveryPending = true;
      sessionUser = session ? session.user : sessionUser;
      showAuthMode('recovery');
      return;
    }
    if (!session) {
      appUserId = null;
      sessionUser = null;
      state.ready = false;
      state.diary = [];
      state.goals = [];
      state.pantry = [];
      dbFoods = [];
      showAuthMode(authMode === 'signup' || authMode === 'reset' ? authMode : 'login');
      if (pendingAuthError) {
        showAuthError(pendingAuthError);
        pendingAuthError = '';
      }
      return;
    }
    void enterApp(session);
  }

  supabase.auth.onAuthStateChange((event, session) => {
    setTimeout(() => onAuth(event, session), 0);
  });

  function setSelectedDate(iso) {
    if (!isISO(iso)) return;
    state.selectedDate = iso;
    persistUi();
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
    const pill = document.getElementById('date-pill');
    if (pill) pill.textContent = formatDate(state.selectedDate);
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
    const cleaned = normalizeBarcode(code) || String(code || '').replace(/\s+/g, '');
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
    const code = normalizeBarcode(product.code);
    const name = offName(product);
    if (!code || !name) return null;
    const nutrition = offNutrition(product.nutriments);
    const pack = gramsFromOff(product);
    const piece = servingGrams(product);
    const food = {
      id: 'off:' + code,
      legacyId: 'off:' + code,
      dbId: null,
      name,
      barcode: code,
      off: true,
      owned: false,
      custom: false,
      source: 'off',
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

  function preferQuery(foods, query) {
    const q = fold(query.trim());
    if (q.length < 2) return foods;
    const named = foods.filter((food) => fold(food.name).includes(q));
    return named.length ? named : foods;
  }

  function explainMissing(food) {
    toast(`${food.name}: Open Food Facts nemá kcal na 100 g, takže to nepřidám.`, 3800);
  }

  function openAdd(food) {
    openAmount({
      mode: 'add',
      foodId: food.id,
      food,
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
      name: entry.name,
      per100: entry.per100,
    });
  }

  function openAmount(ctx) {
    const food = ctx.food || (ctx.foodId ? foodById(ctx.foodId) : null);
    const per100 = ctx.per100 || (food ? {
      kcal: food.kcal,
      protein: food.protein,
      carbs: food.carbs,
      fat: food.fat,
      fiber: food.fiber,
      micros: food.micros || {},
    } : null);
    const name = (food && food.name) || ctx.name;
    if (!name || !per100 || !Number.isFinite(num(per100.kcal))) {
      toast('Tu potravinu už v katalogu nemám.');
      return;
    }
    amountCtx = { ...ctx, food, per100, name };
    document.getElementById('amount-title').textContent = name;
    document.getElementById('amount-sub').textContent =
      `${KCAL.mealLabels[ctx.meal]} · ${formatDate(ctx.date)} · ${per100.kcal} kcal / 100 g`;
    const input = document.getElementById('gram-input');
    input.value = String(ctx.grams);
    const pack = document.getElementById('pack-btn');
    if (food && food.package_g > 0) {
      pack.hidden = false;
      pack.textContent = `Celé balení · ${food.package_g} g`;
    } else {
      pack.hidden = true;
    }
    const piece = document.getElementById('piece-btn');
    if (food && food.piece_g > 0) {
      piece.hidden = false;
      piece.textContent = `1 kus · ${food.piece_g} g`;
    } else {
      piece.hidden = true;
    }
    const save = document.getElementById('amount-save');
    save.textContent = ctx.mode === 'edit' ? 'Uložit' : 'Přidat';
    save.disabled = false;
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
    const grams = currentGrams();
    if (!amountCtx.per100 || grams == null) {
      root.innerHTML = '<p class="preview-empty">Napiš gramy, ať vidíš, co to udělá.</p>';
      save.disabled = true;
      return;
    }
    save.disabled = saving;
    const macros = totalsFromPer100(amountCtx.per100, grams);
    const base = dayTotals(amountCtx.date, {
      excludeId: amountCtx.mode === 'edit' ? amountCtx.entryId : null,
    });
    const dayKcal = round(addNum(base.kcal, macros.kcal));
    const goal = goalsFor(amountCtx.date);
    const dayLine = goal
      ? `Den pak <b>${dayKcal}</b> kcal z ${round(goal.kcal)}`
      : `Den pak <b>${dayKcal}</b> kcal, bez cíle`;
    const gram = (value) => (value == null ? '—' : `${round(value, 1)} g`);
    root.innerHTML = `
      <div class="preview-kicker">${amountCtx.mode === 'edit' ? 'Po úpravě' : 'Tohle přidáš'}</div>
      <div class="preview-kcal"><strong>${round(macros.kcal)}</strong> kcal</div>
      <div class="preview-macros">
        <span>B ${gram(macros.protein)}</span>
        <span>S ${gram(macros.carbs)}</span>
        <span>T ${gram(macros.fat)}</span>
      </div>
      <div class="preview-day">${dayLine}</div>`;
  }

  async function commitAmount() {
    if (!amountCtx || saving) return;
    const grams = currentGrams();
    if (grams == null) {
      toast('Zadej gramy větší než 0.');
      return;
    }
    if (grams > 20000) {
      toast('Gramů je moc. Nejvýš 20000.');
      return;
    }
    saving = true;
    document.getElementById('amount-save').disabled = true;
    try {
      if (amountCtx.mode === 'edit') {
        const entry = state.diary.find((item) => item.id === amountCtx.entryId);
        if (!entry) {
          closeAmount();
          return;
        }
        const scaledTotals = totalsFromPer100(entry.per100, grams);
        const { data, error } = await supabase.from('diary_entries').update({
          grams,
          kcal: scaledTotals.kcal,
          protein: scaledTotals.protein,
          carbs: scaledTotals.carbs,
          fat: scaledTotals.fat,
          fiber: scaledTotals.fiber,
          micros: scaledTotals.micros,
        }).eq('id', entry.dbId).select('*').single();
        if (error) throw error;
        const mapped = mapEntry(data);
        const index = state.diary.findIndex((item) => item.id === entry.id);
        if (index >= 0) state.diary[index] = mapped;
        closeAmount();
        toast(`Uloženo: ${mapped.name} (${grams} g)`);
        await refreshPantry();
        renderActive();
        return;
      }
      const food = amountCtx.food || foodById(amountCtx.foodId);
      if (!food || !Number.isFinite(num(food.kcal))) {
        toast('Tahle potravina nemá kcal, takže ji nezapíšu.');
        return;
      }
      const foodId = await ensureFoodRow(food);
      const fresh = foodById(foodId) || food;
      const snap = snapshotFromFood(fresh, grams);
      const { data, error } = await supabase.from('diary_entries').insert({
        user_id: sessionUser.id,
        eaten_on: amountCtx.date,
        meal: amountCtx.meal,
        food_id: foodId,
        grams,
        ...snap,
      }).select('*').single();
      if (error) throw error;
      state.diary.push(mapEntry(data));
      const meal = amountCtx.meal;
      closeAmount();
      toast(`Přidáno: ${fresh.name} (${grams} g) → ${KCAL.mealLabels[meal]}`);
      await refreshPantry();
      navigate('dnes');
    } catch (err) {
      console.warn(err);
      toast('Zápis se nepodařilo uložit.', 3400);
      document.getElementById('amount-save').disabled = false;
    } finally {
      saving = false;
    }
  }

  async function deleteEntry(id, skipConfirm) {
    const entry = state.diary.find((item) => item.id === id);
    if (!entry || saving) return;
    const name = entry.name || 'položku';
    if (!skipConfirm && !window.confirm(`Smazat „${name}“ (${entry.grams} g)?`)) return;
    saving = true;
    try {
      const { error } = await supabase.from('diary_entries').delete().eq('id', entry.dbId);
      if (error) throw error;
      state.diary = state.diary.filter((item) => item.id !== id);
      closeAmount();
      toast('Smazáno.');
      await refreshPantry();
      renderActive();
    } catch (err) {
      console.warn(err);
      toast('Smazání se nepovedlo.', 3200);
    } finally {
      saving = false;
    }
  }

  function openFoodForm(food) {
    if (food && !food.owned) {
      toast('Sdílenou potravinu nejde měnit. Založ si vlastní.', 3200);
      return;
    }
    foodCtx = food ? { id: food.id, dbId: food.dbId, owned: true } : { create: true };
    document.getElementById('food-title').textContent = food ? 'Upravit potravinu' : 'Nová potravina';
    document.getElementById('food-name').value = food ? food.name : '';
    document.getElementById('food-kcal').value = food && food.kcal != null ? String(food.kcal) : '';
    document.getElementById('food-p').value = food && food.protein != null ? String(food.protein) : '';
    document.getElementById('food-c').value = food && food.carbs != null ? String(food.carbs) : '';
    document.getElementById('food-f').value = food && food.fat != null ? String(food.fat) : '';
    document.getElementById('food-pack').value = food && food.package_g ? String(food.package_g) : '';
    document.getElementById('food-hint').textContent = 'Hodnoty na 100 g. Uloží se k tvému účtu.';
    document.getElementById('food-delete').hidden = !(food && food.owned);
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

  async function saveFoodForm() {
    if (!foodCtx || saving) return;
    const draft = readFoodForm();
    if (draft.error) {
      toast(draft.error, 3200);
      return;
    }
    saving = true;
    try {
      if (foodCtx.create) {
        const legacy = 'u' + Date.now().toString(36);
        const food = {
          id: legacy,
          legacyId: legacy,
          name: draft.name,
          kcal: draft.kcal,
          protein: draft.protein,
          carbs: draft.carbs,
          fat: draft.fat,
          fiber: 0,
          custom: true,
          owned: true,
          off: false,
          source: 'manual',
          micros: {},
          default_serving_g: 100,
          ...(draft.package_g ? { package_g: draft.package_g } : {}),
        };
        await ensureFoodRow(food);
        closeFoodForm();
        toast(`Uloženo: ${draft.name}`);
        renderPridat();
        return;
      }
      const patch = {
        name: draft.name,
        kcal: draft.kcal,
        protein: draft.protein,
        carbs: draft.carbs,
        fat: draft.fat,
        package_g: draft.package_g || null,
      };
      const { data, error } = await supabase.from('foods').update(patch).eq('id', foodCtx.dbId).select('*').single();
      if (error) throw error;
      rememberFood(data);
      closeFoodForm();
      toast(`Upraveno: ${draft.name}`);
      renderActive();
    } catch (err) {
      console.warn(err);
      toast('Potravinu se nepodařilo uložit.', 3200);
    } finally {
      saving = false;
    }
  }

  async function deleteCustomFood() {
    if (!foodCtx || !foodCtx.owned || saving) return;
    const food = foodById(foodCtx.dbId) || foodById(foodCtx.id);
    if (!food) return;
    const used = state.diary.some((entry) => entry.foodId === String(food.dbId) || entry.foodId === food.id);
    if (used) {
      toast('Nejdřív ji smaž z deníku — pořád je v nějakém dni.', 3400);
      return;
    }
    if (!window.confirm(`Smazat potravinu „${food.name}“?`)) return;
    saving = true;
    try {
      const { error } = await supabase.from('foods').delete().eq('id', food.dbId);
      if (error) throw error;
      dbFoods = dbFoods.filter((row) => row.id !== food.dbId);
      closeFoodForm();
      toast('Potravina smazaná.');
      renderPridat();
    } catch (err) {
      console.warn(err);
      toast('Nejde smazat. Ještě je v zásobách nebo v receptu.', 3600);
    } finally {
      saving = false;
    }
  }

  async function applyBarcode(code) {
    const cleaned = normalizeBarcode(code);
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
      const goal = goalsFor(iso);
      const status = dayBand(kcal, goal && goal.kcal);
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
    const goal = goalsFor(state.selectedDate);
    const status = dayBand(totals.kcal, goal && goal.kcal);
    const today = state.selectedDate === todayISO();
    paintDate();
    renderWeek();
    document.getElementById('day-heading').textContent = today ? 'Dnes' : formatDate(state.selectedDate);
    const blurb = document.getElementById('day-blurb');
    const setGoals = document.getElementById('set-goals');
    if (!goal) {
      blurb.textContent = today
        ? 'Cíle ještě nemáš. Bez nich uvidíš, co jsi snědl, ale kroužek se nebarví podle cíle.'
        : 'Pro tenhle den není nastavený cíl.';
      if (setGoals) setGoals.hidden = false;
    } else {
      blurb.textContent = today
        ? `Cíl ${round(goal.kcal)} kcal. Makra níž, jídla ve slotech.`
        : 'Jiný den. Můžeš dopsat, co už bylo, nebo si jídlo naplánovat.';
      if (setGoals) setGoals.hidden = true;
    }
    document.getElementById('kcal-total').textContent = String(totals.kcal);
    document.getElementById('kcal-goal').textContent = goal ? `z ${round(goal.kcal)}` : 'bez cíle';
    const ring = document.getElementById('kcal-ring');
    ring.classList.remove('under', 'met', 'over', 'high', 'logged', 'none');
    ring.classList.add(status.band);
    setRing(ring, goal ? totals.kcal / goal.kcal : status.fill);

    const macros = [
      ['p', 'Bílkoviny', totals.protein, goal ? goal.protein_g : null],
      ['c', 'Sacharidy', totals.carbs, goal ? goal.carbs_g : null],
      ['f', 'Tuky', totals.fat, goal ? goal.fat_g : null],
    ];
    if (goal && goal.fiber_g != null) macros.push(['fiber', 'Vláknina', totals.fiber, goal.fiber_g]);
    document.getElementById('macros').innerHTML = macros
      .map(([cls, label, val, target]) => {
        const hasTarget = target != null && Number.isFinite(Number(target));
        const pct = hasTarget && target > 0 ? Math.min(100, (val / target) * 100) : 0;
        const nums = hasTarget ? `${round(val)}/${round(target)} g` : `${round(val)} g`;
        return `<div class="macro-row">
          <div>${label}</div>
          <div class="bar"><div class="fill ${cls}" style="width:${pct}%"></div></div>
          <div class="nums">${nums}</div>
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
            const name = esc(entry.name || 'Neznámá potravina');
            const kcal = entry.kcal == null ? null : round(num(entry.kcal));
            const protein = entry.protein == null ? null : round(num(entry.protein), 1);
            const carbs = entry.carbs == null ? null : round(num(entry.carbs), 1);
            const fat = entry.fat == null ? null : round(num(entry.fat), 1);
            if (kcal != null) mealKcal += kcal;
            const bit = (label, value) => `${label} ${value == null ? '—' : value}`;
            return `<div class="food-row" data-entry="${esc(entry.id)}">
              <div class="food-main">
                <div>${name}</div>
                <div class="meta">${entry.grams} g · ${bit('B', protein)} · ${bit('S', carbs)} · ${bit('T', fat)}</div>
              </div>
              <div class="food-side">
                <div class="kcal">${kcal == null ? '—' : kcal} kcal</div>
              </div>
              <div class="row-pop" hidden>
                <button type="button" class="pop-rect edit" data-pop-edit="${esc(entry.id)}">Upravit</button>
                <button type="button" class="pop-rect del" data-pop-del="${esc(entry.id)}">Smazat</button>
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
        void deleteEntry(btn.getAttribute('data-pop-del'));
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
    const list = state.pantry.filter((item) => item.loc === pantryLoc);
    const root = document.getElementById('pantry-list');
    if (!list.length) {
      root.innerHTML = '<p class="note">Tady nic není.</p>';
      return;
    }
    const soonLimit = addDays(todayISO(), 4);
    root.innerHTML = list
      .map((item) => {
        const name = esc(item.name || 'Neznámá potravina');
        const soon = item.expiry && item.expiry <= soonLimit;
        const qty = item.unit === 'ks'
          ? `${round(item.qty, 3)} ks`
          : item.unit === 'ml'
            ? `${round(item.qty, 3)} ml`
            : `${round(item.qty, 3)} g`;
        const expiry = item.expiry && isISO(item.expiry)
          ? ` · do ${item.expiry.split('-').reverse().join('.')}`
          : '';
        return `<div class="pantry-item">
          <div>
            <div>${name}</div>
            <div class="sub">${qty}${item.opened ? ' · otevřeno' : ''}${expiry}</div>
          </div>
          <div><span class="badge ${soon ? 'soon' : ''}">${soon ? 'brzy' : KCAL.locLabels[item.loc]}</span></div>
        </div>`;
      })
      .join('');
  }

  function fillGoalForm(goal) {
    document.getElementById('goal-kcal').value = goal ? String(round(goal.kcal)) : '';
    document.getElementById('goal-p').value = goal ? String(goal.protein_g) : '';
    document.getElementById('goal-c').value = goal ? String(goal.carbs_g) : '';
    document.getElementById('goal-f').value = goal ? String(goal.fat_g) : '';
    document.getElementById('goal-fiber').value = goal && goal.fiber_g != null ? String(goal.fiber_g) : '';
  }

  function renderNastaveni() {
    const today = todayISO();
    const goal = goalsFor(today);
    const status = document.getElementById('goals-status');
    const email = sessionUser && sessionUser.email ? sessionUser.email : '';
    document.getElementById('account-email').textContent = email ? `Přihlášený e-mail: ${email}` : '';
    if (!goal) {
      status.textContent = 'Zatím žádný cíl. Vyplň ho a ulož — platí od dneška.';
    } else if (goal.effective_from === today) {
      status.textContent = 'Dnešní cíl. Uložení ho přepíše.';
    } else {
      status.textContent = `Teď platí cíl od ${formatDate(goal.effective_from)}. Uložení založí nový cíl od dneška, starší dny zůstanou.`;
    }
    const form = document.getElementById('goals-form');
    if (form.contains(document.activeElement)) return;
    fillGoalForm(goal);
  }

  function readGoalsForm() {
    const kcal = num(document.getElementById('goal-kcal').value);
    const protein = num(document.getElementById('goal-p').value);
    const carbs = num(document.getElementById('goal-c').value);
    const fat = num(document.getElementById('goal-f').value);
    const fiberRaw = document.getElementById('goal-fiber').value.trim();
    const fiber = fiberRaw === '' ? null : num(fiberRaw);
    if (!Number.isFinite(kcal) || kcal <= 0 || kcal > 20000) return { error: 'kcal musí být větší než 0.' };
    if (![protein, carbs, fat].every((n) => Number.isFinite(n) && n >= 0)) return { error: 'Bílkoviny, sacharidy a tuky vyplň číslem od 0.' };
    if (protein > 1000 || carbs > 2000 || fat > 1000) return { error: 'Některé makro je moc vysoké.' };
    if (fiber != null && (!Number.isFinite(fiber) || fiber < 0 || fiber > 500)) return { error: 'Vlákninu nech prázdnou, nebo dej číslo od 0.' };
    return {
      kcal: round(kcal),
      protein_g: round(protein, 1),
      carbs_g: round(carbs, 1),
      fat_g: round(fat, 1),
      fiber_g: fiber == null ? null : round(fiber, 1),
    };
  }

  async function saveGoals(event) {
    event.preventDefault();
    if (saving) return;
    const parsed = readGoalsForm();
    if (parsed.error) {
      toast(parsed.error, 3400);
      return;
    }
    const today = todayISO();
    const current = state.goals.find((row) => row.effective_from === today);
    saving = true;
    document.getElementById('goals-save').disabled = true;
    try {
      const payload = {
        kcal: parsed.kcal,
        protein_g: parsed.protein_g,
        carbs_g: parsed.carbs_g,
        fat_g: parsed.fat_g,
        fiber_g: parsed.fiber_g,
      };
      const result = current
        ? await supabase.from('user_goals').update(payload).eq('id', current.id).select('id, effective_from, kcal, protein_g, carbs_g, fat_g, fiber_g').single()
        : await supabase.from('user_goals').insert({
          ...payload,
          user_id: sessionUser.id,
          effective_from: today,
        }).select('id, effective_from, kcal, protein_g, carbs_g, fat_g, fiber_g').single();
      if (result.error) throw result.error;
      const mapped = mapGoal(result.data);
      state.goals = state.goals.filter((row) => row.id !== mapped.id).concat(mapped);
      toast('Cíle uložené.');
      renderNastaveni();
    } catch (err) {
      console.warn(err);
      toast('Cíle se nepodařilo uložit.', 3200);
    } finally {
      saving = false;
      document.getElementById('goals-save').disabled = false;
    }
  }

  function foodCard(food, remote) {
    const pack = food.package_g ? ` · balení ${food.package_g} g` : '';
    const own = food.owned ? (food.off ? ' · tvoje z Open Food Facts' : ' · vlastní') : '';
    const source = remote ? ' · Open Food Facts' : own;
    const missing = food.kcal == null || !Number.isFinite(num(food.kcal));
    const kcal = missing ? 'bez kcal' : `${food.kcal} kcal/100 g`;
    const macros = missing
      ? 'Open Food Facts u tohohle nemá výživu na 100 g'
      : `B ${food.protein == null ? '—' : food.protein} · S ${food.carbs == null ? '—' : food.carbs} · T ${food.fat == null ? '—' : food.fat}${pack}${source}`;
    const attr = remote ? `data-off="${esc(food.id)}"` : `data-food="${esc(food.id)}"`;
    const edit = !remote && food.owned
      ? `<button type="button" class="food-edit-link" data-edit-food="${esc(food.id)}">Upravit</button>`
      : '';
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
    const query = fold(document.getElementById('food-search').value || '');
    const local = catalog().filter((food) => {
      if (!query) return true;
      return fold(`${food.name} ${food.brand || ''}`).includes(query);
    });
    const known = new Set(local.map((food) => food.barcode).filter(Boolean));
    const extra = (remote || []).filter((food) => food.barcode && !known.has(food.barcode));
    extra.forEach((food) => shownOff.set(food.id, food));
    const root = document.getElementById('food-results');
    if (!local.length && !extra.length) {
      root.innerHTML = query.length >= 2
        ? '<p class="note">Nic v katalogu. Když Open Food Facts něco najde, objeví se to tady.</p>'
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
      const foods = preferQuery(await searchOff(query, controller.signal), query);
      if (token !== offToken) return;
      offHits = foods;
      offFor = query;
      const current = (document.getElementById('food-search').value || '').trim();
      if (fold(current) !== fold(query)) return;
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
    paintFoodList(fold(query) === fold(offFor) ? offHits : []);
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
    else if (name === 'nastaveni') renderNastaveni();
  }

  function navigate(name) {
    if (!APP_ROUTES.includes(name)) name = 'dnes';
    hideRowActions();
    if (name !== 'pridat') stopScan();
    const hash = '#' + name;
    if (location.hash !== hash) history.replaceState(null, '', hash);
    document.querySelectorAll('.screen').forEach((screen) => {
      screen.classList.toggle('active', screen.id === 'screen-' + name);
    });
    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.nav === name);
    });
    const settings = document.getElementById('open-settings');
    if (settings) settings.classList.toggle('active', name === 'nastaveni');
    if (name === 'dnes') renderDnes();
    if (name === 'mikro') renderMikro();
    if (name === 'zasoby') renderZasoby();
    if (name === 'pridat') renderPridat();
    if (name === 'nastaveni') renderNastaveni();
  }

  function stepGrams(delta) {
    const input = document.getElementById('gram-input');
    const current = num(input.value);
    const base = Number.isFinite(current) ? current : 0;
    const next = Math.max(1, round(base + delta, 1));
    input.value = String(next);
    paintPreview();
  }

  async function onAuthSubmit(event) {
    event.preventDefault();
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const password2 = document.getElementById('auth-password2').value;
    showAuthError('');
    showAuthInfo('');
    if (authMode !== 'recovery' && !email) {
      showAuthError('Napiš e-mail.');
      return;
    }
    if (authMode !== 'reset' && password.length < 6) {
      showAuthError('Heslo musí mít aspoň 6 znaků.');
      return;
    }
    if ((authMode === 'signup' || authMode === 'recovery') && password !== password2) {
      showAuthError('Hesla se neshodují.');
      return;
    }
    const submit = document.getElementById('auth-submit');
    submit.disabled = true;
    try {
      if (authMode === 'login') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else if (authMode === 'signup') {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: redirectUrl() },
        });
        if (error) throw error;
        if (!data.session) {
          showAuthInfo('Účet je založený. Otevři odkaz v e-mailu. Pak se přihlas heslem, nebo se sem rovnou vrátíš, když odkaz otevřeš v tomhle prohlížeči.');
          showAuthMode('login');
          document.getElementById('auth-email').value = email;
        }
      } else if (authMode === 'reset') {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: redirectUrl() });
        if (error) throw error;
        showAuthInfo('Pokud k e-mailu účet patří, poslali jsme odkaz na nové heslo.');
        showAuthMode('login');
        document.getElementById('auth-email').value = email;
      } else if (authMode === 'recovery') {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        recoveryPending = false;
        toast('Heslo je změněné.');
        const { data } = await supabase.auth.getSession();
        await enterApp(data.session);
      }
    } catch (err) {
      console.warn(err);
      showAuthError(czechAuthError(err));
    } finally {
      submit.disabled = false;
    }
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
  document.getElementById('open-settings').addEventListener('click', () => navigate('nastaveni'));
  document.getElementById('set-goals').addEventListener('click', () => navigate('nastaveni'));
  document.getElementById('goals-form').addEventListener('submit', (event) => { void saveGoals(event); });
  document.getElementById('logout').addEventListener('click', () => { void supabase.auth.signOut(); });
  document.getElementById('auth-form').addEventListener('submit', (event) => { void onAuthSubmit(event); });
  document.getElementById('auth-toggle').addEventListener('click', () => {
    showAuthError('');
    showAuthInfo('');
    if (authMode === 'signup' || authMode === 'reset') showAuthMode('login');
    else showAuthMode('signup');
  });
  document.getElementById('auth-reset').addEventListener('click', () => {
    showAuthError('');
    showAuthInfo('');
    showAuthMode('reset');
  });

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
    if (!amountCtx || !amountCtx.food || !amountCtx.food.package_g) return;
    document.getElementById('gram-input').value = String(amountCtx.food.package_g);
    paintPreview();
  });
  document.getElementById('piece-btn').addEventListener('click', () => {
    if (!amountCtx || !amountCtx.food || !amountCtx.food.piece_g) return;
    document.getElementById('gram-input').value = String(amountCtx.food.piece_g);
    paintPreview();
  });
  document.getElementById('amount-cancel').addEventListener('click', closeAmount);
  document.getElementById('amount-save').addEventListener('click', () => { void commitAmount(); });
  document.getElementById('amount-delete').addEventListener('click', () => {
    if (amountCtx && amountCtx.entryId) void deleteEntry(amountCtx.entryId);
  });
  document.getElementById('amount-back').addEventListener('click', (event) => {
    if (event.target.id === 'amount-back') closeAmount();
  });
  document.getElementById('gram-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void commitAmount();
  });

  document.getElementById('food-cancel').addEventListener('click', closeFoodForm);
  document.getElementById('food-save').addEventListener('click', () => { void saveFoodForm(); });
  document.getElementById('food-delete').addEventListener('click', () => { void deleteCustomFood(); });
  document.getElementById('food-back').addEventListener('click', (event) => {
    if (event.target.id === 'food-back') closeFoodForm();
  });

  document.getElementById('barcode-scan').addEventListener('click', startScan);
  document.getElementById('scan-stop').addEventListener('click', stopScan);
  document.getElementById('barcode-go').addEventListener('click', () => {
    void applyBarcode(document.getElementById('barcode').value);
  });
  document.getElementById('barcode').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void applyBarcode(event.target.value);
  });
  document.getElementById('barcode-camera').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    void decodeImageFile(file);
    event.target.value = '';
  });
  document.getElementById('barcode-gallery').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    void decodeImageFile(file);
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

  if (pendingAuthError && !recoveryPending) {
    showAuthMode('login');
    showAuthError(pendingAuthError);
    pendingAuthError = '';
  }
})();
