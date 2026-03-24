import type { InstallationManifest } from '../../types/installation'
import { ChevronDown } from 'lucide-react'

interface ModelSwitcherProps {
  manifests: InstallationManifest[]
  currentId: string
  onChange: (id: string) => void
}

export default function ModelSwitcher({ manifests, currentId, onChange }: ModelSwitcherProps) {
  if (manifests.length <= 1) {
    return null
  }

  return (
    <div className="relative inline-block">
      <select
        value={currentId}
        onChange={(e) => onChange(e.target.value)}
        className="appearance-none bg-dark-2 bg-opacity-70 text-light-2 border border-light-2 border-opacity-30 rounded-lg pl-3 pr-8 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-2 cursor-pointer"
        aria-label="Select installation model"
      >
        {manifests.map((m) => (
          <option key={m.id} value={m.id} className="bg-dark-1 text-light-2">
            {m.name}
          </option>
        ))}
      </select>
      <div className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-light-1">
        <ChevronDown className="w-4 h-4" />
      </div>
    </div>
  )
}
