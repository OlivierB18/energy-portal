# Energy Portal

A modern web portal for monitoring energy consumption, inspired by HomeWizard energy app.

## Features

- **Real-time Power Monitoring**: Display current power usage with live updates
- **Energy Charts**: Interactive charts showing consumption trends
- **Multiple Time Ranges**: View data for today, this week, or this month
- **Cost Calculation**: See estimated costs for energy consumption
- **Responsive Design**: Beautiful UI that works on desktop and mobile
- **HomeWizard Style**: Modern, clean interface inspired by HomeWizard

## Tech Stack

- **React 18**: UI framework
- **Vite**: Fast build tool and dev server
- **TypeScript**: Type safety
- **Tailwind CSS**: Styling
- **Recharts**: Data visualization
- **Lucide Icons**: Beautiful icons

## Getting Started

### Prerequisites

- Node.js 16+ and npm

### Installation

1. Install dependencies:
```bash
npm install
```

2. Start the development server:
```bash
npm run dev
```

This starts Netlify Dev (frontend + `/.netlify/functions/*`).

If you only need the Vite UI server, use:
```bash
npm run dev:vite
```

3. Open your browser and go to `http://localhost:5173`

### Building for Production

```bash
npm run build
```

The build output will be in the `dist` folder.

## Recommended Workflow (Local + GitHub Agents)

Use this setup so your work is always backed up on GitHub and agent changes stay easy to merge.

1. Sync your local repo with the default branch before starting:
```bash
npm run git:sync
```

2. Start a feature branch for your work:
```bash
npm run git:start -- feature/short-description
```

3. Commit and push small changes frequently:
```bash
git add -A
git commit -m "feat: short description"
git push -u origin feature/short-description
```

4. Let GitHub agents work in separate branches and open Pull Requests.

5. Merge via Pull Request, then sync local again:
```bash
npm run git:sync
```

Rules of thumb:
- Keep your own work and agent work on different branches.
- Do not work directly on `master`.
- Merge everything through Pull Requests.
- Never commit `.env` files.

## Project Structure

```
src/
├── components/       # Reusable React components
│   ├── EnergyCard.tsx
│   └── EnergyChart.tsx
├── pages/           # Page components
│   └── Dashboard.tsx
├── services/        # API services (for future Home Assistant integration)
├── App.tsx          # Main app component
├── main.tsx         # Entry point
└── index.css        # Global styles
```

## Future Integrations

- Home Assistant API connection for real-time data
- User authentication
- Multiple home support
- Detailed device breakdown
- Prediction and recommendations
- Mobile app support

## License

MIT
