# InsideOut Agent

This is the Plan Foxtrot gateway agent for continuous energy data ingestion into Supabase.

## Why You Need This

The dashboard pulls historical data from Supabase to:
- ✅ Show accurate kWh calculations (no more gaps!)
- ✅ Display data even when your browser is closed
- ✅ Keep 24/7 continuous monitoring

The InsideOut Agent handles the gateway polling and forwards readings to your ingest endpoint.

## Setup

### 1. Copy Environment Variables

```bash
cp .env.example .env
```

### 2. Fill in Your Settings

Edit the `.env` file with your values:

```env
# Optional direct HA override (if set, Auth0 metadata lookup is skipped)
HA_URL=http://192.168.1.xxx:8123
HA_TOKEN=

# Environment and authentication
ENVIRONMENT_ID=your-environment-id
DEVICE_TOKEN=

# Polling and aggregation intervals
POLL_INTERVAL_MS=10000
AGGREGATE_INTERVAL_MS=900000

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
pm2 start insideout-agent.js --name insideout-agent
pm2 save
pm2 startup
```

### Option C: Run on Raspberry Pi / Server
Copy this folder to a Raspberry Pi or server that runs 24/7 and follow the same steps.

## Checking if it's Working

You should see console output every 10 seconds:
```
[insideout-agent] sent data for your-environment-id (home-assistant)
```

Check your dashboard - the data gaps should be gone and kWh calculations should be accurate!

## Troubleshooting

- **"Missing ENVIRONMENT_ID"**: Make sure you created the `.env` file and filled in required values
- **"Request failed 401"**: Check your INGEST_API_KEY is correct
- **"ECONNREFUSED"**: Check your HA_URL or Auth0 environment configuration is correct and reachable
