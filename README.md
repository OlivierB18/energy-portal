# Brouwer EMS — Energy Portal

Een Energy Management Systeem (EMS) voor Brouwer, gebouwd met Next.js 15, Prisma en NextAuth.

---

## Wat is er gebouwd?

Hieronder staat een volledige uitleg van wat er is geïmplementeerd, waarom bepaalde keuzes zijn gemaakt en hoe alles samenwerkt.

---

### 1. Project-opzet

Het project is opgezet als een **Next.js 15 App Router** applicatie met TypeScript. De keuze voor Next.js geeft ons:

- Server-side rendering en API-routes in één project (geen aparte backend nodig).
- Ingebouwde middleware voor route-beveiliging.
- Snelle ontwikkelervaring met hot-reload.

**Tailwind CSS** is toegevoegd voor styling: utility-classes zorgen voor een consistent ontwerp zonder een apart CSS-bestand per component te hoeven bijhouden.

---

### 2. Database & gegevensmodel (Prisma)

De database is opgezet met **Prisma 5** (ORM) en **SQLite** als lokale database. In productie kan `DATABASE_URL` eenvoudig worden omgezet naar een PostgreSQL-verbinding zonder code te wijzigen.

Er zijn drie modellen aangemaakt in `prisma/schema.prisma`:

| Model | Doel |
|---|---|
| `User` | Gebruikersaccount met naam, e-mail, gehashed wachtwoord en rol (`user` / `admin`). |
| `Site` | Een fysieke locatie (bijv. een gebouw of installatie) die toebehoort aan één gebruiker. |
| `EnergyReading` | Een meting per uur: verbruik (kWh), zonne-energie (kWh) en netverbruik (kWh). Gekoppeld aan een gebruiker én optioneel aan een locatie. |

De relaties zorgen ervoor dat als een gebruiker wordt verwijderd, ook al zijn locaties en metingen automatisch worden verwijderd (`onDelete: Cascade`).

---

### 3. Authenticatie (NextAuth.js)

Inloggen werkt via **NextAuth.js v4** met een `CredentialsProvider` (e-mail + wachtwoord). De keuze hiervoor:

- Volledig zelf in beheer (geen externe OAuth-provider vereist).
- Wachtwoorden worden opgeslagen als **bcrypt-hash** (kostfactor 12) — nooit in platte tekst.
- Na een succesvolle login wordt een **JWT-token** aangemaakt. Dit token bevat het gebruikers-ID en de rol, zodat de server bij elk verzoek weet wie er is ingelogd zonder een database-query.

De configuratie staat in `src/lib/auth.ts`. De NextAuth-route handler bevindt zich in `src/app/api/auth/[...nextauth]/route.ts`.

---

### 4. Routebeveiliging (Middleware)

`src/middleware.ts` bevat één regel: alle routes die beginnen met `/dashboard` vereisen een actieve sessie. Bezoekers zonder sessie worden automatisch doorgestuurd naar `/login`. Dit gebeurt op het niveau van de Next.js middleware, vóórdat de pagina wordt geladen — de browser ontvangt dus nooit dashboard-HTML als iemand niet is ingelogd.

---

### 5. Login-pagina (`/login`)

Een eenvoudig formulier met e-mailadres en wachtwoord. Bij een fout (onbekend e-mailadres of verkeerd wachtwoord) verschijnt een foutmelding. Bij succes wordt de gebruiker doorgestuurd naar het dashboard. De pagina is volledig Nederlandstalig en responsief (werkt op desktop en mobiel).

---

### 6. Dashboard (`/dashboard`)

Het dashboard is het hoofdscherm na inloggen. Het bestaat uit:

#### Statistiekenkaarten (4 stuks)
Elke kaart toont één getal voor de gekozen periode:

| Kaart | Wat het toont |
|---|---|
| **Totaal verbruik** | Totale energieconsumptie in kWh |
| **Zonne-energie** | Totale opgewekte zonne-energie in kWh |
| **Netverbruik** | Energie afgenomen van het elektriciteitsnet in kWh |
| **Zelfvoorzienend** | Percentage van het verbruik dat gedekt werd door zonne-energie |

#### Staafdiagram
Een **Canvas-gebaseerde grafiek** (geen externe chart-bibliotheek, om het project licht te houden) die per dag twee staven toont: verbruik (blauw) en zonne-energie (groen). De uurlijkse metingen worden in de browser samengevoegd tot dagelijkse totalen.

#### Periodefilter
De gebruiker kan kiezen tussen **7, 14 of 30 dagen** via een knoppengroep. De data wordt opnieuw opgehaald bij elke wijziging.

#### Locatiefilter
Als een gebruiker meerdere locaties heeft, verschijnt er een dropdown om op één locatie te filteren.

#### Locatietabel
Onderaan het dashboard staat een tabel met alle locaties van de ingelogde gebruiker (naam en adres).

---

### 7. API (`/api/energy`)

De GET-endpoint `src/app/api/energy/route.ts` levert de data voor het dashboard. Belangrijke beveiligingsmaatregel: de query filtert altijd op `userId: session.user.id`. Dit betekent dat een ingelogde gebruiker **nooit** data van een andere gebruiker kan opvragen — zelfs niet als hij of zij een ander gebruikers-ID in de URL probeert in te vullen.

De response bevat:
- Een lijst met ruwe metingen (`readings`)
- De locaties van de gebruiker (`sites`)
- Een samenvatting (`summary`) met totalen en zelfvoorzieningspercentage

---

### 8. Demo-data (`/api/seed`)

De POST-endpoint `src/app/api/seed/route.ts` maakt twee demo-gebruikers aan en genereert **14 dagen × 24 uur = 336 uurlijkse metingen** met realistische waarden:

- Het zonneprofiel volgt een sinusgolf (piek rond het middaguur, nul 's nachts).
- Verbruik is willekeurig maar binnen een realistisch bereik.
- Netverbruik = max(0, verbruik − zonne-energie).

Deze endpoint is **uitgeschakeld in productie** (`NODE_ENV === "production"` controle).

---

### 9. Beveiligingspatch (Next.js upgrade)

De initieel geïnstalleerde versie Next.js 14.2.35 bleek kwetsbaar voor een **Denial-of-Service aanval via HTTP-request deserialisatie** bij gebruik van React Server Components. Dit is opgelost door te upgraden naar **Next.js 15.5.13** — de eerste patchreeks die deze kwetsbaarheid verhelpt. Tegelijkertijd zijn React en react-dom bijgewerkt naar versie 19 (vereist door Next.js 15) en is `eslint-config-next` gesynchroniseerd.

---

### 10. Projectstructuur

```
energy-portal/
├── prisma/
│   └── schema.prisma          # Databasemodellen (User, Site, EnergyReading)
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── auth/[...nextauth]/route.ts   # NextAuth handler
│   │   │   ├── energy/route.ts               # Data-API (beveiligd)
│   │   │   └── seed/route.ts                 # Demo-data (alleen dev)
│   │   ├── dashboard/
│   │   │   └── page.tsx       # Dashboard-pagina
│   │   ├── login/
│   │   │   └── page.tsx       # Login-pagina
│   │   ├── layout.tsx         # Root layout met SessionProvider
│   │   ├── page.tsx           # Redirect / → /dashboard
│   │   └── providers.tsx      # Client-side SessionProvider wrapper
│   ├── components/
│   │   ├── EnergyChart.tsx    # Canvas staafdiagram
│   │   ├── Navbar.tsx         # Navigatiebalk met uitlogknop
│   │   └── StatCard.tsx       # Statistiekenkaart
│   ├── lib/
│   │   ├── auth.ts            # NextAuth configuratie
│   │   └── prisma.ts          # Prisma Client singleton
│   ├── middleware.ts           # Routebeveiliging
│   └── types/
│       └── next-auth.d.ts     # TypeScript type-uitbreidingen voor sessie
├── .env.example               # Voorbeeld omgevingsvariabelen
└── README.md                  # Deze documentatie
```

---

## Technologieoverzicht

| Laag | Keuze | Reden |
|---|---|---|
| Framework | Next.js 15 (App Router) | Full-stack in één project, snelle iteratie |
| Taal | TypeScript | Type-veiligheid, betere onderhoudbaarheid |
| Styling | Tailwind CSS | Snel, consistent, geen CSS-bestanden |
| Database | PostgreSQL (Neon / Supabase free tier) | Werkt zowel lokaal als op Netlify serverless |
| ORM | Prisma 5 | Type-veilige queries, eenvoudige migraties |
| Authenticatie | NextAuth.js v4 | Volledige controle, geen externe dienst nodig |
| Wachtwoord-hashing | bcryptjs (factor 12) | Industriestandaard, beschermt bij een datalek |
| Grafiek | HTML Canvas (eigen code) | Geen extra afhankelijkheden, licht en flexibel |

---

## Aan de slag (lokaal)

### 1. Afhankelijkheden installeren

```bash
npm install
```

### 2. Omgevingsvariabelen instellen

```bash
cp .env.example .env
```

Vul `.env` in met een PostgreSQL-verbinding (zie `.env.example` voor voorbeelden). Je kunt gratis gebruik maken van [Neon](https://neon.tech) of [Supabase](https://supabase.com) voor een cloud Postgres-database.

```env
DATABASE_URL="postgresql://user:password@host:5432/energy_portal?sslmode=require"
NEXTAUTH_SECRET="<willekeurig geheim — genereer met: openssl rand -base64 32>"
NEXTAUTH_URL="http://localhost:3000"
```

### 3. Database aanmaken

```bash
npx prisma db push
```

### 4. Demo-data laden (optioneel)

Start de server (`npm run dev`) en roep dan aan:

```bash
curl -X POST http://localhost:3000/api/seed
```

Demo-accounts (alleen lokaal development):

| E-mail | Wachtwoord | Rol |
|---|---|---|
| demo@brouwer-ems.nl | D3m0#Br0uw3r!2024 | user |
| admin@brouwer-ems.nl | D3m0#Br0uw3r!2024 | admin |

> ⚠️ **Let op:** Gebruik deze accounts nooit in een productieomgeving.

### 5. Starten

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) — je wordt automatisch doorgestuurd naar de loginpagina.

---

## Deployen naar Netlify

Het project is geconfigureerd voor Netlify via `netlify.toml`. De build-stap voert automatisch `prisma generate` uit en bouwt daarna de Next.js-applicatie. Netlify's **Essential Next.js Plugin** (`@netlify/plugin-nextjs`) zorgt ervoor dat server-side routes, API-routes en middleware correct werken op Netlify's serverless-infrastructuur.

> ⚠️ **SQLite werkt niet op Netlify.** Het bestandssysteem van Netlify is tijdelijk en read-only bij serverless functions. Gebruik altijd een cloud PostgreSQL-database (zie stap 2 hieronder).

### Stap-voor-stap

#### 1. Maak een gratis PostgreSQL-database aan

Gebruik een van de volgende gratis opties:

- **[Neon](https://neon.tech)** — Serverless Postgres, gratis tier beschikbaar. Kopieer de connection string (formaat: `postgresql://...`).
- **[Supabase](https://supabase.com)** — Open-source Firebase alternatief met gratis Postgres. Kopieer de "Connection string" uit de Database-instellingen.

#### 2. Voer de eerste migratie uit

Verbind tijdelijk met de productiedatabase via een `.env` bestand en voer uit:

```bash
DATABASE_URL="postgresql://..." npx prisma db push
```

#### 3. Verbind de GitHub-repository met Netlify

1. Ga naar [app.netlify.com](https://app.netlify.com) → **Add new site** → **Import an existing project**.
2. Kies **GitHub** en selecteer de `OlivierB18/energy-portal` repository.
3. Netlify detecteert automatisch het `netlify.toml` bestand — de build-instellingen zijn al correct ingevuld.

#### 4. Stel omgevingsvariabelen in

Ga in Netlify naar **Site configuration → Environment variables** en voeg toe:

| Variabele | Waarde |
|---|---|
| `DATABASE_URL` | Je PostgreSQL connection string |
| `NEXTAUTH_SECRET` | Willekeurig geheim (`openssl rand -base64 32`) |
| `NEXTAUTH_URL` | De Netlify-URL van je site, bijv. `https://jouw-site.netlify.app` |

#### 5. Deploy

Klik op **Deploy site**. Iedere push naar de `main`-branch triggert vanaf nu automatisch een nieuwe deploy.

### Structuur van `netlify.toml`

```toml
[build]
  command   = "npx prisma generate && npm run build"
  publish   = ".next"

[build.environment]
  NODE_VERSION            = "20"
  NEXT_TELEMETRY_DISABLED = "1"

[[plugins]]
  package = "@netlify/plugin-nextjs"
```

- **`command`** — Genereert eerst de Prisma-client (nodig voor de build), daarna de Next.js-productie-build.
- **`publish`** — De `.next`-map bevat de build-output die Netlify serveert.
- **`@netlify/plugin-nextjs`** — Zorgt voor juiste verwerking van App Router server components, API-routes en middleware.

---

## Beveiliging

- Alle `/dashboard/*`-routes zijn beveiligd via Next.js middleware (redirect naar `/login` zonder sessie).
- De `/api/energy`-route filtert altijd op `userId` uit de sessie — gebruikers kunnen nooit elkaars data inzien.
- Wachtwoorden worden opgeslagen als bcrypt-hash (kostfactor 12).
- De seed-route is geblokkeerd in productie.
- Next.js is bijgewerkt naar 15.5.13 om een bekende DoS-kwetsbaarheid te verhelpen.
