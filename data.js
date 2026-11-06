/* Mock data for static preview — training day for a gym-going physio student. */
window.KCAL = window.KCAL || {};

KCAL.goals = {
  kcal: 2800,
  protein_g: 170,
  carbs_g: 320,
  fat_g: 80,
};

/* EFSA adult-male oriented targets (same keys as nutrient_targets in schema). Informational. */
KCAL.targets = [
  { key: 'vit_a_ug',  unit: 'µg', target: 750,  theme: 'imunita', label: 'Vitamin A',  hint: 'zrak a imunitní funkce' },
  { key: 'vit_c_mg',  unit: 'mg', target: 110,  theme: 'imunita', label: 'Vitamin C',  hint: 'antioxidant, imunitní podpora' },
  { key: 'vit_d_ug',  unit: 'µg', target: 15,   theme: 'kosti',   label: 'Vitamin D',  hint: 'kosti a svalová funkce' },
  { key: 'vit_e_mg',  unit: 'mg', target: 13,   theme: 'imunita', label: 'Vitamin E',  hint: 'ochrana buněk před oxidací' },
  { key: 'vit_k_ug',  unit: 'µg', target: 70,   theme: 'kosti',   label: 'Vitamin K',  hint: 'srážení krve a kosti' },
  { key: 'b1_mg',     unit: 'mg', target: 1.1,  theme: 'energie', label: 'Vitamin B1', hint: 'přeměna sacharidů na energii' },
  { key: 'b2_mg',     unit: 'mg', target: 1.6,  theme: 'energie', label: 'Vitamin B2', hint: 'energetický metabolismus' },
  { key: 'b6_mg',     unit: 'mg', target: 1.7,  theme: 'svaly',   label: 'Vitamin B6', hint: 'metabolismus bílkovin, nervy' },
  { key: 'folate_ug', unit: 'µg', target: 330,  theme: 'mozek',   label: 'Folát',      hint: 'tvorba buněk a DNA' },
  { key: 'b12_ug',    unit: 'µg', target: 4,    theme: 'mozek',   label: 'Vitamin B12',hint: 'nervy a tvorba červených krvinek' },
  { key: 'ca_mg',     unit: 'mg', target: 1000, theme: 'kosti',   label: 'Vápník',     hint: 'kosti a zuby' },
  { key: 'fe_mg',     unit: 'mg', target: 11,   theme: 'energie', label: 'Železo',     hint: 'transport kyslíku' },
  { key: 'mg_mg',     unit: 'mg', target: 350,  theme: 'spanek',  label: 'Hořčík',     hint: 'svaly, regenerace, nervy' },
  { key: 'zn_mg',     unit: 'mg', target: 11,   theme: 'svaly',   label: 'Zinek',      hint: 'svalová regenerace a imunita' },
  { key: 'k_mg',      unit: 'mg', target: 3500, theme: 'energie', label: 'Draslík',    hint: 'tlak a svalová funkce' },
  { key: 'na_mg',     unit: 'mg', target: 2000, theme: 'energie', label: 'Sodík',      hint: 'udržuj spíš nízko (solení)' },
  { key: 'se_ug',     unit: 'µg', target: 70,   theme: 'imunita', label: 'Selen',      hint: 'antioxidant a štítná žláza' },
  { key: 'iodine_ug', unit: 'µg', target: 150,  theme: 'energie', label: 'Jód',        hint: 'štítná žláza a metabolismus' },
  { key: 'choline_mg',unit: 'mg', target: 400,  theme: 'mozek',   label: 'Cholin',     hint: 'mozek a nervové přenosy' },
];

KCAL.themes = [
  { id: 'mozek',   label: 'Mozek' },
  { id: 'svaly',   label: 'Svaly & výkon' },
  { id: 'energie', label: 'Energie' },
  { id: 'spanek',  label: 'Spánek & regenerace' },
  { id: 'imunita', label: 'Imunita' },
  { id: 'kosti',   label: 'Kosti' },
];

KCAL.foods = [
  { id: 'f1', name: 'Kuřecí prsa', kcal: 110, protein: 23.1, carbs: 0, fat: 1.2, fiber: 0,
    micros: { b6_mg: 0.6, b3_like: 0, fe_mg: 0.4, zn_mg: 0.7, se_ug: 22, b12_ug: 0.3, k_mg: 256, na_mg: 45, mg_mg: 28, choline_mg: 85, vit_d_ug: 0.1 } },
  { id: 'f2', name: 'Rýže vařená', kcal: 130, protein: 2.7, carbs: 28, fat: 0.3, fiber: 0.4,
    micros: { b1_mg: 0.02, mg_mg: 12, k_mg: 35, fe_mg: 0.2, folate_ug: 3, na_mg: 1 } },
  { id: 'f3', name: 'Vejce (celé)', kcal: 143, protein: 12.6, carbs: 0.7, fat: 9.5, fiber: 0,
    micros: { b12_ug: 1.1, choline_mg: 250, vit_d_ug: 2, vit_a_ug: 160, se_ug: 30, fe_mg: 1.8, zn_mg: 1.3, b2_mg: 0.45, folate_ug: 47, na_mg: 142 } },
  { id: 'f4', name: 'Bílý jogurt 1,5 %', kcal: 57, protein: 4.5, carbs: 5.5, fat: 1.5, fiber: 0,
    micros: { ca_mg: 150, b12_ug: 0.4, b2_mg: 0.2, iodine_ug: 20, k_mg: 180, na_mg: 50, mg_mg: 15 } },
  { id: 'f5', name: 'Ovesné vločky', kcal: 367, protein: 13.2, carbs: 58, fat: 7, fiber: 10,
    micros: { mg_mg: 130, fe_mg: 4.2, zn_mg: 3.6, b1_mg: 0.5, folate_ug: 32, k_mg: 350, se_ug: 28, choline_mg: 40 } },
  { id: 'f6', name: 'Banán', kcal: 89, protein: 1.1, carbs: 23, fat: 0.3, fiber: 2.6,
    micros: { k_mg: 358, b6_mg: 0.4, vit_c_mg: 8.7, mg_mg: 27, folate_ug: 20 } },
  { id: 'f7', name: 'Cottage cheese', kcal: 98, protein: 11.5, carbs: 3.5, fat: 4.3, fiber: 0,
    micros: { ca_mg: 83, b12_ug: 0.4, se_ug: 9, na_mg: 360, b2_mg: 0.16, choline_mg: 18 } },
  { id: 'f8', name: 'Olivový olej', kcal: 884, protein: 0, carbs: 0, fat: 100, fiber: 0,
    micros: { vit_e_mg: 14, vit_k_ug: 60 } },
  { id: 'f9', name: 'Brokolice', kcal: 34, protein: 2.8, carbs: 7, fat: 0.4, fiber: 2.6,
    micros: { vit_c_mg: 89, vit_k_ug: 101, folate_ug: 63, k_mg: 316, ca_mg: 47, fe_mg: 0.7, mg_mg: 21 } },
  { id: 'f10', name: 'Losos', kcal: 208, protein: 20, carbs: 0, fat: 13, fiber: 0,
    micros: { vit_d_ug: 11, b12_ug: 3.2, se_ug: 36, b6_mg: 0.9, niacin: 0, choline_mg: 90, k_mg: 363, na_mg: 59, iodine_ug: 14 } },
  { id: 'f11', name: 'Celozrnný chléb', kcal: 247, protein: 9, carbs: 41, fat: 3.5, fiber: 6.5,
    micros: { fe_mg: 2.5, mg_mg: 75, zn_mg: 1.8, b1_mg: 0.35, folate_ug: 40, se_ug: 18, na_mg: 450 } },
  { id: 'f12', name: 'Mandlové máslo', kcal: 614, protein: 21, carbs: 19, fat: 56, fiber: 10,
    micros: { vit_e_mg: 24, mg_mg: 270, ca_mg: 260, fe_mg: 3.5, zn_mg: 3.1, k_mg: 740 } },
  { id: 'f13', name: 'Špenát syrový', kcal: 23, protein: 2.9, carbs: 3.6, fat: 0.4, fiber: 2.2,
    micros: { vit_k_ug: 483, vit_a_ug: 469, folate_ug: 194, fe_mg: 2.7, mg_mg: 79, k_mg: 558, vit_c_mg: 28, ca_mg: 99 } },
  { id: 'f14', name: 'Tvaroh polotučný', kcal: 110, protein: 14, carbs: 3.5, fat: 4.5, fiber: 0,
    micros: { ca_mg: 90, b12_ug: 0.5, se_ug: 12, na_mg: 40, b2_mg: 0.2 } },
  { id: 'f15', name: 'Brambory vařené', kcal: 87, protein: 1.9, carbs: 20, fat: 0.1, fiber: 1.8,
    micros: { k_mg: 379, vit_c_mg: 13, b6_mg: 0.3, mg_mg: 22, fe_mg: 0.3 } },
  { id: 'f16', name: 'Syrovátkový protein', barcode: '8594001123452', kcal: 380, protein: 80, carbs: 6, fat: 4, fiber: 0,
    micros: { ca_mg: 400, b12_ug: 1.5, na_mg: 250, k_mg: 500, mg_mg: 80 } },
];

/* Diary entries: grams of each food on mock date 2026-11-06 (training day). */
KCAL.diaryDate = '2026-11-06';
KCAL.diary = [
  { id: 'd1', meal: 'snidane', foodId: 'f5', grams: 80 },
  { id: 'd2', meal: 'snidane', foodId: 'f4', grams: 200 },
  { id: 'd3', meal: 'snidane', foodId: 'f6', grams: 120 },
  { id: 'd4', meal: 'svacina', foodId: 'f7', grams: 180 },
  { id: 'd5', meal: 'svacina', foodId: 'f11', grams: 60 },
  { id: 'd6', meal: 'obed', foodId: 'f1', grams: 200 },
  { id: 'd7', meal: 'obed', foodId: 'f2', grams: 250 },
  { id: 'd8', meal: 'obed', foodId: 'f9', grams: 180 },
  { id: 'd9', meal: 'obed', foodId: 'f8', grams: 10 },
  { id: 'd10', meal: 'svacina', foodId: 'f16', grams: 35 },
  { id: 'd11', meal: 'svacina', foodId: 'f6', grams: 100 },
  { id: 'd12', meal: 'vecere', foodId: 'f10', grams: 160 },
  { id: 'd13', meal: 'vecere', foodId: 'f15', grams: 250 },
  { id: 'd14', meal: 'vecere', foodId: 'f13', grams: 80 },
  { id: 'd15', meal: 'vecere', foodId: 'f3', grams: 100 },
];

KCAL.pantry = [
  { foodId: 'f1', qty: 600, unit: 'g', loc: 'lednice', expiry: '2026-11-08', opened: false },
  { foodId: 'f4', qty: 2, unit: 'ks', loc: 'lednice', expiry: '2026-11-12', opened: false },
  { foodId: 'f7', qty: 1, unit: 'ks', loc: 'lednice', expiry: '2026-11-09', opened: true },
  { foodId: 'f3', qty: 8, unit: 'ks', loc: 'lednice', expiry: '2026-11-18', opened: false },
  { foodId: 'f14', qty: 250, unit: 'g', loc: 'lednice', expiry: '2026-11-07', opened: true },
  { foodId: 'f10', qty: 400, unit: 'g', loc: 'mrazak', expiry: '2026-12-15', opened: false },
  { foodId: 'f9', qty: 500, unit: 'g', loc: 'mrazak', expiry: '2027-01-20', opened: false },
  { foodId: 'f13', qty: 300, unit: 'g', loc: 'mrazak', expiry: '2026-12-01', opened: false },
  { foodId: 'f5', qty: 1000, unit: 'g', loc: 'spiz', expiry: '2027-03-01', opened: true },
  { foodId: 'f2', qty: 1500, unit: 'g', loc: 'spiz', expiry: '2027-06-01', opened: false },
  { foodId: 'f8', qty: 500, unit: 'ml', loc: 'spiz', expiry: '2027-02-01', opened: true },
  { foodId: 'f16', qty: 800, unit: 'g', loc: 'spiz', expiry: '2027-04-10', opened: true },
  { foodId: 'f12', qty: 250, unit: 'g', loc: 'spiz', expiry: '2026-12-20', opened: true },
  { foodId: 'f11', qty: 1, unit: 'ks', loc: 'spiz', expiry: '2026-11-10', opened: true },
];

KCAL.mealLabels = {
  snidane: 'Snídaně',
  obed: 'Oběd',
  vecere: 'Večeře',
  svacina: 'Svačina',
};

KCAL.locLabels = {
  lednice: 'Lednice',
  mrazak: 'Mrazák',
  spiz: 'Spíž',
};
