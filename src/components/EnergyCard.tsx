import { Zap, Calendar, Activity } from 'lucide-react'

interface EnergyCardProps {
  title: string
  value: string | number
  unit: string
  cost: number | null
  icon: 'zap' | 'calendar' | 'activity'
}

export default function EnergyCard({ title, value, unit, cost, icon }: EnergyCardProps) {
  const getIcon = () => {
    switch (icon) {
      case 'zap':
        return <Zap className="w-8 h-8 text-brand-2" />
      case 'calendar':
        return <Calendar className="w-8 h-8 text-brand-3" />
      case 'activity':
        return <Activity className="w-8 h-8 text-brand-4" />
      default:
        return null
    }
  }

  return (
    <div className="glass-card rounded-2xl p-6 shadow-lg hover:shadow-xl transition-all">
      <div className="flex items-start justify-between mb-4">
        <div>
          <p className="text-light-1 text-sm font-medium mb-2">{title}</p>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-heavy text-light-2">{value}</span>
            {unit && <span className="text-light-1 font-medium">{unit}</span>}
          </div>
        </div>
        <div className="bg-gradient-to-br from-brand-2 to-brand-3 p-3 rounded-xl">{getIcon()}</div>
      </div>
      {cost !== null && (
        <div className="pt-4 border-t border-dark-2 border-opacity-10">
          <p className="text-light-1 text-sm">Estimated cost</p>
          <p className="text-xl font-heavy text-light-2">€{cost.toFixed(2)}</p>
        </div>
      )}
    </div>
  )
}
