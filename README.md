# Kcal

Osobní kalorický deník: jídla, makra, mikronutrienty, zásoby a sken čárového kódu. Přihlášený deník, vlastní potraviny a cíle jsou v Supabase (projekt `kcal-app`).

Živý web na GitHub Pages se touhle větví nemění. https://prokopdud.github.io/kcal-app/ pořád ukazuje `main` a data v prohlížeči.

## Náhled větve

V kořeni repozitáře:

```bash
python3 -m http.server 3000
```

Otevři http://localhost:3000/ . Site URL v Supabase je teď `http://localhost:3000`, takže potvrzovací e-mail a odkaz na nové heslo se vrátí sem. Jinou adresu (třeba `http://127.0.0.1:3000/` nebo budoucí náhled) je potřeba přidat v Supabase pod Authentication → URL Configuration.

Nový účet se potvrzuje e-mailem. Vestavěný odesílač Supabase má nízký limit a nemusí doručit na každou adresu, dokud nebude vlastní SMTP. Cíle (kcal, bílkoviny, sacharidy, tuky, volitelně vláknina) si nastavíš v Nastavení. Nový účet začíná bez nich.

Katalog v prohlížeči pořád obsahuje 16 základních surovin a 100 českých potravin. Hledání je bez diakritiky. Vlastní potravina a naskenovaný výrobek se uloží k účtu. Deník se zapisuje do Supabase a při smazání vrátí zásoby trigger v databázi.
