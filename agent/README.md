# HomeWizard Data Collection Agent

This agent continuously collects energy data from your HomeWizard P1 meter and stores it in Supabase.

## Why You Need This

The dashboard now pulls historical data from Supabase to:
- ✅ Show accurate kWh calculations (no more gaps!)
- ✅ Display data even when your browser is closed
- ✅ Keep 24/7 continuous monitoring

## Setup

### 1. Copy Environment Variables

```bash
cp .env.example .env
```

### 2. Fill in Your Settings

Edit the `.env` file with your values:

```env
# Your HomeWizard P1 Meter IP address
HOMEWIZARD_IP=192.168.1.xxx

# HomeWizard API token (if required, leave empty if not)
HOMEWIZARD_TOKEN=

# Your environment ID from the main app
HOMEWIZARD_ENVIRONMENT_ID=your-environment-id

# How often to collect data (in milliseconds, default 10000 = 10 seconds)
HOMEWIZARD_POLL_MS=10000

# Netlify function URL (use your deployed site URL)
INGEST_URL=https://brouwerems.netlify.app/.netlify/functions/ingest-device-data

# API key for ingesting data (get this from your Netlify environment variables)
INGEST_API_KEY=your-ingest-api-key
```

### 3. Install Dependencies

```bash
npm install
```

### 4. Start the Agent

```bash
npm start
```

## Running 24/7

To keep the agent running continuously, you have several options:

### Option A: Keep PowerShell Window Open
Just run `npm start` and minimize the window. **Important:** Don't close it!

### Option B: Run as Background Process (Windows)
Use PM2 or similar process manager:

```bash
npm install -g pm2
pm2 start homewizard-agent.js --name energy-agent
pm2 save
pm2 startup
```

### Option C: Run on Raspberry Pi / Server
Copy this folder to a Raspberry Pi or server that runs 24/7 and follow the same steps.

## Checking if it's Working

You should see console output every 10 seconds:
```
[agent] sent data for your-environment-id (serial-number)
```

Check your dashboard - the data gaps should be gone and kWh calculations should be accurate!

## Troubleshooting

- **"Missing HOMEWIZARD_IP"**: Make sure you created the `.env` file and filled in all values
- **"Request failed 401"**: Check your INGEST_API_KEY is correct
- **"ECONNREFUSED"**: Check your HomeWizard IP address is correct and reachable
