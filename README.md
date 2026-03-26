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

Current repository convention:
- Canonical branch for this project is `master`.
- Open Pull Requests into `master`.

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

6. Verify that the PR branch or commit is really in `master`:
```bash
# By branch name (origin/<branch>)
npm run git:verify-merge -- -Branch copilot/fix-empty-electricity-usage-chart

# Or by commit SHA
npm run git:verify-merge -- -Commit 2e63e7b
```

Rules of thumb:
- Keep your own work and agent work on different branches.
- Do not work directly on `master`.
- Merge everything through Pull Requests.
- Never commit `.env` files.

## Step-by-Step Daily Workflow (Netjes + Fast)

Use this sequence every time to avoid mixed changes and VS Code slowdown.

1. Start from a clean repository:
```bash
npm run git:sync
git status
```

2. Create a dedicated Copilot task worktree:
```bash
# Example task name: fix-chart-loading
npm run git:wt:start -- -Name fix-chart-loading
```

3. Open the new task folder in a new VS Code window:
```bash
code -n ../energy-portal.worktrees/fix-chart-loading
```

4. Do implementation only in that new window.
	- Keep commits small.
	- Commit and push to the task branch.

5. Create a Pull Request to `master`.
	- Use VS Code GitHub Pull Requests extension or GitHub web UI.

6. After merge, clean local task workspace:
```bash
npm run git:wt:clean -- -Name fix-chart-loading -DeleteLocalBranch
npm run git:sync
```

## Agent Collaboration Flow

1. You create one task worktree.
2. You ask Copilot in that worktree to implement the task.
3. Copilot edits only task files in that branch.
4. You review, test, commit, push.
5. You create PR and handle review comments in the same branch.
6. After merge, remove worktree and start the next task fresh.

## Fix VS Code Freezes (10s wait)

If VS Code still hangs:

1. Open only one active task folder at a time.
2. Stop extra terminals running watchers/servers.
3. Run `Developer: Reload Window`.
4. Keep the main repo and worktrees out of the same open multi-root workspace.
5. Prefer storing active repos outside OneDrive for best file watcher performance.

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
