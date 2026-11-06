(function () {
  const foodById = Object.fromEntries(KCAL.foods.map((f) => [f.id, f]));
  let addMeal = 'obed';
  let pantryLoc = 'lednice';
  let nextDiaryId = 100;

  // live scanner state (all local — never uploaded)
  let mediaStream = null;
  let detectTimer = null;
  let zxingReader = null;
  let zxingControls = null;
  let scanning = false;
  let zxingLoading = null;

  function round(n, d) {
    const p = 10 ** (d ?? 0);
    return Math.round(n * p) / p;
  }

  function foodMacros(food, grams) {
    const s = grams / 100;
    return {
      kcal: round(food.kcal * s),
      protein: round(food.protein * s, 1),
      carbs: round(food.carbs * s, 1),
      fat: round(food.fat * s, 1),
      fiber: round((food.fiber || 0) * s, 1),
    };
  }

  function dayTotals() {
    const t = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, micros: {} };
    for (const e of KCAL.diary) {
      const f = foodById[e.foodId];
      if (!f) continue;
      const m = foodMacros(f, e.grams);
      t.kcal += m.kcal;
      t.protein += m.protein;
      t.carbs += m.carbs;
      t.fat += m.fat;
      t.fiber += m.fiber;
      const s = e.grams / 100;
      for (const [k, v] of Object.entries(f.micros || {})) {
        if (typeof v !== 'number') continue;
        t.micros[k] = (t.micros[k] || 0) + v * s;
      }
    }
    t.kcal = round(t.kcal);
    t.protein = round(t.protein, 1);
    t.carbs = round(t.carbs, 1);
    t.fat = round(t.fat, 1);
    return t;
  }

  function formatDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString('cs-CZ', { weekday: 'short', day: 'numeric', month: 'numeric' });
  }

  function setRing(pct) {
    const circ = 2 * Math.PI * 48;
    const clamped = Math.max(0, Math.min(1, pct));
    const el = document.getElementById('kcal-ring');
    el.style.strokeDasharray = String(circ);
    el.style.strokeDashoffset = String(circ * (1 - clamped));
  }

  function toast(msg, ms) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), ms || 2400);
  }

  function findByBarcode(code) {
    const c = String(code || '').replace(/\s+/g, '');
    return KCAL.foods.find((f) => f.barcode && f.barcode === c) || null;
  }

  function addFoodToMeal(food, grams) {
    const g = grams || food.default_serving_g || 100;
    KCAL.diary.push({
      id: 'd' + nextDiaryId++,
      meal: addMeal,
      foodId: food.id,
      grams: g,
    });
    toast(`Přidáno: ${food.name} (${g} g) → ${KCAL.mealLabels[addMeal]}`);
    navigate('dnes');
  }

  function applyBarcode(code) {
    const cleaned = String(code || '').replace(/\D/g, '');
    if (!cleaned) {
      toast('Zadej nebo naskenuj EAN.');
      return;
    }
    document.getElementById('barcode').value = cleaned;
    toast('Načteno: ' + cleaned);
    const food = findByBarcode(cleaned);
    if (food) {
      setTimeout(() => addFoodToMeal(food), 500);
    } else {
      setTimeout(
        () => toast('Kód známý, ale lookup přes Open Food Facts přijde později.', 3200),
        900
      );
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
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
    const video = document.getElementById('scan-video');
    if (video) {
      video.srcObject = null;
    }
    const panel = document.getElementById('scan-panel');
    if (panel) panel.hidden = true;
    const btn = document.getElementById('barcode-scan');
    if (btn) btn.disabled = false;
  }

  function loadZXing() {
    if (window.ZXing) return Promise.resolve(window.ZXing);
    if (zxingLoading) return zxingLoading;
    zxingLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
      s.async = true;
      s.onload = () => (window.ZXing ? resolve(window.ZXing) : reject(new Error('ZXing chybí')));
      s.onerror = () => reject(new Error('CDN ZXing se nenačetla (potřebuje síť)'));
      document.head.appendChild(s);
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
    // Prefer rear camera via facingMode constraints through decodeFromConstraints
    const constraints = { audio: false, video: { facingMode: { ideal: 'environment' } } };
    zxingControls = await zxingReader.decodeFromConstraints(
      constraints,
      video,
      (result, err) => {
        if (!scanning) return;
        if (result && result.getText) {
          const text = result.getText();
          stopScan();
          applyBarcode(text);
          return;
        }
        // NotFoundException is normal while hunting
        if (err && ZXing.NotFoundException && err instanceof ZXing.NotFoundException) return;
      }
    );
  }

  async function startScan() {
    if (scanning) return;
    if (!window.isSecureContext && location.protocol !== 'http:') {
      // file:// is often not a secure context → getUserMedia blocked
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
        const detector = new BarcodeDetector({
          formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'],
        });
        const codes = await detector.detect(bmp);
        bmp.close && bmp.close();
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

  function renderDnes() {
    const totals = dayTotals();
    const g = KCAL.goals;
    const left = Math.max(0, g.kcal - totals.kcal);
    const over = totals.kcal > g.kcal;
    document.getElementById('date-pill').textContent = formatDate(KCAL.diaryDate);
    document.getElementById('kcal-left').textContent = over ? `+${totals.kcal - g.kcal}` : String(left);
    document.getElementById('kcal-left-label').textContent = over ? 'kcal navíc' : 'kcal zbývá';
    document.getElementById('kcal-eaten').textContent = `${totals.kcal} / ${g.kcal} kcal`;
    setRing(totals.kcal / g.kcal);

    const macros = [
      ['p', 'Bílkoviny', totals.protein, g.protein_g],
      ['c', 'Sacharidy', totals.carbs, g.carbs_g],
      ['f', 'Tuky', totals.fat, g.fat_g],
    ];
    document.getElementById('macros').innerHTML = macros
      .map(([cls, label, val, goal]) => {
        const pct = Math.min(100, (val / goal) * 100);
        return `<div class="macro-row">
          <div>${label}</div>
          <div class="bar"><div class="fill ${cls}" style="width:${pct}%"></div></div>
          <div class="nums">${round(val)}/${goal} g</div>
        </div>`;
      })
      .join('');

    const slots = ['snidane', 'obed', 'svacina', 'vecere'];
    const box = document.getElementById('meals');
    box.innerHTML = slots
      .map((slot) => {
        const items = KCAL.diary.filter((e) => e.meal === slot);
        let mealKcal = 0;
        const rows = items
          .map((e) => {
            const f = foodById[e.foodId];
            const m = foodMacros(f, e.grams);
            mealKcal += m.kcal;
            return `<div class="food-row">
              <div>
                <div>${f.name}</div>
                <div class="meta">${e.grams} g · B ${m.protein} · S ${m.carbs} · T ${m.fat}</div>
              </div>
              <div class="kcal">${m.kcal} kcal</div>
            </div>`;
          })
          .join('');
        return `<section class="card meal-card" data-meal="${slot}">
          <div class="meal-head">
            <h3>${KCAL.mealLabels[slot]}</h3>
            <div class="meal-kcal">${mealKcal} kcal</div>
          </div>
          ${rows || '<div class="note" style="margin:0">Zatím prázdné.</div>'}
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
  }

  function renderMikro() {
    const totals = dayTotals();
    const root = document.getElementById('mikro-list');
    root.innerHTML = KCAL.themes
      .map((theme) => {
        const nutrients = KCAL.targets.filter((t) => t.theme === theme.id);
        const rows = nutrients
          .map((t) => {
            const val = totals.micros[t.key] || 0;
            const pct = (val / t.target) * 100;
            const pctShow = Math.min(999, Math.round(pct));
            const bar = Math.min(100, pct);
            let cls = 'low';
            if (pct >= 85) cls = 'ok';
            else if (pct >= 45) cls = 'mid';
            const valTxt = val < 10 ? round(val, 2) : round(val, 1);
            return `<div class="nutrient">
              <div><strong>${t.label}</strong></div>
              <div class="pct ${cls}">${pctShow}%</div>
              <div class="hint">${t.hint} · ${valTxt} / ${t.target} ${t.unit}</div>
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
    document.querySelectorAll('.loc-tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.loc === pantryLoc);
    });
    const list = KCAL.pantry.filter((p) => p.loc === pantryLoc);
    const root = document.getElementById('pantry-list');
    if (!list.length) {
      root.innerHTML = '<p class="note">Tady nic není.</p>';
      return;
    }
    root.innerHTML = list
      .map((p) => {
        const f = foodById[p.foodId];
        const soon = p.expiry <= '2026-11-10';
        const qty =
          p.unit === 'ks' ? `${p.qty} ks` : p.unit === 'ml' ? `${p.qty} ml` : `${p.qty} g`;
        return `<div class="pantry-item">
          <div>
            <div>${f.name}</div>
            <div class="sub">${qty}${p.opened ? ' · otevřeno' : ''} · do ${p.expiry.split('-').reverse().join('.')}</div>
          </div>
          <div><span class="badge ${soon ? 'soon' : ''}">${soon ? 'brzy' : KCAL.locLabels[p.loc]}</span></div>
        </div>`;
      })
      .join('');
  }

  function renderPridat() {
    document.querySelectorAll('.meal-pick button').forEach((b) => {
      b.classList.toggle('active', b.dataset.meal === addMeal);
    });
    const q = (document.getElementById('food-search').value || '').trim().toLowerCase();
    const foods = KCAL.foods.filter((f) => !q || f.name.toLowerCase().includes(q));
    const root = document.getElementById('food-results');
    root.innerHTML = foods
      .map((f) => {
        const serving = f.default_serving_g || 100;
        const bc = f.barcode ? ` · EAN ${f.barcode}` : '';
        return `<button type="button" class="food-pick" data-food="${f.id}">
          <div>${f.name}</div>
          <div class="right">${f.kcal} kcal/100 g</div>
          <div class="sub">B ${f.protein} · S ${f.carbs} · T ${f.fat} · klepni = +${serving} g do „${KCAL.mealLabels[addMeal]}“${bc}</div>
        </button>`;
      })
      .join('');
    root.querySelectorAll('[data-food]').forEach((btn) => {
      btn.addEventListener('click', () => addFoodToMeal(foodById[btn.dataset.food]));
    });
  }

  function navigate(name) {
    if (!['dnes', 'mikro', 'zasoby', 'pridat'].includes(name)) name = 'dnes';
    if (name !== 'pridat') stopScan();
    history.replaceState(null, '', '#' + name);
    document.querySelectorAll('.screen').forEach((s) => {
      s.classList.toggle('active', s.id === 'screen-' + name);
    });
    document.querySelectorAll('.nav-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.nav === name);
    });
    if (name === 'dnes') renderDnes();
    if (name === 'mikro') renderMikro();
    if (name === 'zasoby') renderZasoby();
    if (name === 'pridat') renderPridat();
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

  document.getElementById('barcode-scan').addEventListener('click', startScan);
  document.getElementById('scan-stop').addEventListener('click', stopScan);
  document.getElementById('barcode-go').addEventListener('click', () => {
    applyBarcode(document.getElementById('barcode').value);
  });
  document.getElementById('barcode').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyBarcode(e.target.value);
  });
  document.getElementById('barcode-camera').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    decodeImageFile(f);
    e.target.value = '';
  });
  document.getElementById('barcode-gallery').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    decodeImageFile(f);
    e.target.value = '';
  });

  window.addEventListener('pagehide', stopScan);
  window.addEventListener('beforeunload', stopScan);

  const hash = (location.hash || '#dnes').slice(1);
  navigate(hash);
})();
