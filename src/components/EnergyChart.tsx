import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'

interface EnergyChartProps {
  data: Array<{
    time: string
    power: number
  }>
  timeRange: 'today' | 'week' | 'month'
}

export default function EnergyChart({ data, timeRange }: EnergyChartProps) {
  return (
    <div className="w-full h-96">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 5, right: 30, left: 0, bottom: 5 }}>
          <defs>
            <linearGradient id="colorPower" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="rgb(2, 125, 94)" stopOpacity={0.8} />
              <stop offset="95%" stopColor="rgb(2, 125, 94)" stopOpacity={0.1} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255, 255, 255, 0.08)" />
          <XAxis
            dataKey="time"
            stroke="rgb(234, 233, 229)"
            style={{ fontSize: '0.875rem' }}
          />
          <YAxis
            stroke="rgb(234, 233, 229)"
            label={{ value: 'kW', angle: -90, position: 'insideLeft' }}
            style={{ fontSize: '0.875rem' }}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: 'rgba(10, 10, 10, 0.95)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: '0.5rem',
              boxShadow: '0 10px 25px rgba(0, 0, 0, 0.4)',
            }}
            formatter={(value: number) => [`${value.toFixed(2)} kW`, 'Power']}
            labelStyle={{ color: 'rgb(234, 233, 229)' }}
          />
          <Line
            type="monotone"
            dataKey="power"
            stroke="rgb(2, 125, 94)"
            strokeWidth={3}
            dot={{ fill: 'rgb(2, 125, 94)', r: 5 }}
            activeDot={{ r: 7 }}
            fillOpacity={1}
            fill="url(#colorPower)"
            isAnimationActive={true}
          />
        </LineChart>
      </ResponsiveContainer>
      <p className="text-center text-light-1 text-sm mt-4">
        Energy consumption for {timeRange === 'today' ? 'today' : timeRange === 'week' ? 'this week' : 'this month'}
      </p>
    </div>
  )
}
