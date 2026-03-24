import type { ViewerRole } from '../../types/installation'
import { Eye, Settings } from 'lucide-react'

interface RoleSwitcherProps {
  role: ViewerRole
  onChange: (role: ViewerRole) => void
}

export default function RoleSwitcher({ role, onChange }: RoleSwitcherProps) {
  return (
    <div className="flex items-center gap-1 bg-dark-2 bg-opacity-50 rounded-lg p-1">
      <button
        type="button"
        onClick={() => onChange('user')}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
          role === 'user'
            ? 'bg-brand-2 text-dark-1'
            : 'text-light-1 hover:text-light-2'
        }`}
        aria-pressed={role === 'user'}
        title="User view"
      >
        <Eye className="w-3.5 h-3.5" />
        View
      </button>
      <button
        type="button"
        onClick={() => onChange('admin')}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
          role === 'admin'
            ? 'bg-amber-500 text-dark-1'
            : 'text-light-1 hover:text-light-2'
        }`}
        aria-pressed={role === 'admin'}
        title="Admin mode"
      >
        <Settings className="w-3.5 h-3.5" />
        Admin
      </button>
    </div>
  )
}
