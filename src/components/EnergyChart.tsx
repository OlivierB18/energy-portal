import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'

// Custom tick component for multiline labels (handles "time\ndate" format)
function CustomTick(props: any) {
  const { x, y, payload } = props
  const label = payload?.value || ''
  
  // Split on newline
  const lines = label.split('\n')
  
  if (lines.length === 1) {
    // Single line - use default rendering
    return (
      <text x={x} y={y} textAnchor="end" fill="rgb(234, 233, 229)" fontSize="0.875rem">
        {label}
      </text>
    )
  }
  
  // Multiple lines - render each on separate y position
  return (
    <text x={x} textAnchor="end" fill="rgb(234, 233, 229)" fontSize="0.875rem">
      {lines.map((line: string, index: number) => (
        <tspan key={index} x={x} dy={index === 0 ? 0 : '1.2em'}>
          {line}
        </tspan>
      ))}
    </text>
  )
}

interface EnergyChartProps {
  data: Array<{
    time: string
    power: number
  }>
  timeRange: 'today' | 'week' | 'month'
  unit?: string
  seriesLabel?: string
  rangeLabel?: string
  chartType?: 'line' | 'bar'
}

export default function EnergyChart({
  data,
  timeRange,
  unit = 'kW',
  seriesLabel = 'Power',
  rangeLabel,
  chartType = 'line',
}: EnergyChartProps) {
  const decimals = 2

  const commonAxisProps = {
    stroke: "rgb(234, 233, 229)",
    style: { fontSize: '0.875rem' },
  }

  const commonTooltipProps = {
    contentStyle: {
      backgroundColor: 'rgba(10, 10, 10, 0.95)',
      border: '1px solid rgba(255, 255, 255, 0.08)',
      borderRadius: '0.5rem',
      boxShadow: '0 10px 25px rgba(0, 0, 0, 0.4)',
    },
    formatter: (value: number) => [`${value.toFixed(decimals)} ${unit}`, seriesLabel],
    labelStyle: { color: 'rgb(234, 233, 229)' },
  }

  return (
    <div className="w-full" style={{ height: '380px' }}>
      <ResponsiveContainer width="100%" height="100%">
        {chartType === 'bar' ? (
          <BarChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 50 }}>
            <defs>
              <linearGradient id="colorGas" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="rgb(234, 88, 12)" stopOpacity={0.8} />
                <stop offset="95%" stopColor="rgb(234, 88, 12)" stopOpacity={0.3} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255, 255, 255, 0.08)" />
            <XAxis
              dataKey="time"
              {...commonAxisProps}
              tick={<CustomTick />}
              angle={-45}
              textAnchor="end"
              height={70}
            />
            <YAxis
              {...commonAxisProps}
              label={{ value: unit, angle: -90, position: 'insideLeft' }}
            />
            <Tooltip {...commonTooltipProps} />
            <Bar
              dataKey="power"
              fill="url(#colorGas)"
              radius={[8, 8, 0, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        ) : (
          <LineChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 50 }}>
            <defs>
              <linearGradient id="colorPower" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="rgb(2, 125, 94)" stopOpacity={0.8} />
                <stop offset="95%" stopColor="rgb(2, 125, 94)" stopOpacity={0.1} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255, 255, 255, 0.08)" />
            <XAxis
              dataKey="time"
              {...commonAxisProps}
              tick={<CustomTick />}
              angle={-45}
              textAnchor="end"
              height={70}
            />
            <YAxis
              {...commonAxisProps}
              label={{ value: unit, angle: -90, position: 'insideLeft' }}
            />
            <Tooltip {...commonTooltipProps} />
            <Line
              type="monotone"
              dataKey="power"
              stroke="rgb(2, 125, 94)"
              strokeWidth={3}
              dot={{ fill: 'rgb(2, 125, 94)', r: 5 }}
              activeDot={{ r: 7 }}
              fillOpacity={1}
              fill="url(#colorPower)"
              isAnimationActive={false}
            />
          </LineChart>
        )}
      </ResponsiveContainer>
      <p className="text-center text-light-1 text-sm mt-4">
        {seriesLabel} for {timeRange === 'today' ? 'day' : timeRange === 'week' ? 'week' : 'month'}{rangeLabel ? ` (${rangeLabel})` : ''}
      </p>
    </div>
  )
}
