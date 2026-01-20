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

3. Open your browser and go to `http://localhost:5173`

### Building for Production

```bash
npm run build
```

The build output will be in the `dist` folder.

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
