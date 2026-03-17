# Brouwer EMS — Energy Portal

Een Energy Management Systeem (EMS) gebouwd met Next.js, Prisma en NextAuth.

## Functies

- 🔒 **Veilige authenticatie** — Inloggen met e-mail & wachtwoord (JWT-sessies)
- 📊 **Energie dashboard** — Verbruik, zonne-energie, netverbruik en zelfvoorzieningsgraad
- 🏠 **Multi-locatie** — Beheer meerdere meetpunten per gebruiker
- 🔐 **Dataisolatie** — Gebruikers zien uitsluitend hun eigen data
- 📱 **Responsief** — Werkt op desktop en mobiel

## Technologie

| Laag | Keuze |
|------|-------|
| Framework | Next.js 14 (App Router) |
| Taal | TypeScript |
| Styling | Tailwind CSS |
| Database | SQLite (dev) / PostgreSQL (prod) |
| ORM | Prisma |
| Authenticatie | NextAuth.js v4 |

## Aan de slag

### 1. Installeer afhankelijkheden

```bash
npm install
```

### 2. Omgevingsvariabelen instellen

```bash
cp .env.example .env
```

Pas `.env` aan:

```env
DATABASE_URL="file:./dev.db"
NEXTAUTH_SECRET="<random geheim — genereer met: openssl rand -base64 32>"
NEXTAUTH_URL="http://localhost:3000"
```

### 3. Database initialiseren

```bash
npx prisma db push
```

### 4. (Optioneel) Demo-data laden

```bash
curl -X POST http://localhost:3000/api/seed
```

Demo-accounts (alleen lokaal development):

| E-mail | Wachtwoord | Rol |
|--------|-----------|-----|
| demo@brouwer-ems.nl | D3m0#Br0uw3r!2024 | user |
| admin@brouwer-ems.nl | D3m0#Br0uw3r!2024 | admin |

> ⚠️ **Let op:** Gebruik deze accounts nooit in een productieomgeving.

### 5. Starten

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Beveiliging

- Alle `/dashboard/*`-routes zijn beveiligd via Next.js middleware
- De `/api/energy`-route valideert de sessie en filtert op `userId`
- Wachtwoorden worden opgeslagen als bcrypt-hash (kostfactor 12)
- De seed-route is alleen beschikbaar buiten productie
