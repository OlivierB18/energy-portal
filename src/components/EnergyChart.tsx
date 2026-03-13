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
import { useEffect, useMemo, useState } from 'react'

const sampleChartData = <T,>(points: T[], maxPoints: number): T[] => {
  if (points.length <= maxPoints || maxPoints < 2) {
    return points
  }

  const result: T[] = []
  const step = (points.length - 1) / (maxPoints - 1)
  let previousIndex = -1

  for (let i = 0; i < maxPoints; i += 1) {
    const index = Math.round(i * step)
    if (index !== previousIndex && points[index] !== undefined) {
      result.push(points[index])
      previousIndex = index
    }
  }

  const lastPoint = points[points.length - 1]
  if (result[result.length - 1] !== lastPoint) {
    result.push(lastPoint)
  }

  return result
}

// Custom tick component for multiline labels (handles "time\ndate" format)
function CustomTick(props: any) {
  const { x, y, payload } = props
  const label = payload?.value || ''
  const lines = String(label).split('\n').slice(0, 2)
  const tickY = typeof y === 'number' ? y + 8 : y
  
  if (lines.length === 1) {
    return (
      <text x={x} y={tickY} textAnchor="middle" fill="rgb(234, 233, 229)" fontSize="0.78rem">
        {label}
      </text>
    )
  }

  return (
    <text x={x} y={tickY} textAnchor="middle" fill="rgb(234, 233, 229)" fontSize="0.76rem">
      {lines.map((line: string, index: number) => (
        <tspan key={index} x={x} dy={index === 0 ? 0 : '1.1em'}>
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
  lineType?: 'monotone' | 'linear' | 'step'
}

export default function EnergyChart({
  data,
  timeRange,
  unit = 'kW',
  seriesLabel = 'Power',
  rangeLabel,
  chartType = 'line',
  lineType = 'monotone',
}: EnergyChartProps) {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 640 : false,
  )

  useEffect(() => {
    const updateViewport = () => {
      setIsMobile(window.innerWidth < 640)
    }

    updateViewport()
    window.addEventListener('resize', updateViewport)
    return () => window.removeEventListener('resize', updateViewport)
  }, [])

  const decimals = 2
  const targetPointCount = useMemo(() => {
    if (chartType === 'bar') {
      if (timeRange === 'month') {
        return isMobile ? 24 : 36
      }
      if (timeRange === 'week') {
        return isMobile ? 20 : 30
      }
      return isMobile ? 16 : 24
    }

    if (timeRange === 'month') {
      return isMobile ? 32 : 52
    }
    if (timeRange === 'week') {
      return isMobile ? 28 : 44
    }
    return isMobile ? 24 : 36
  }, [chartType, isMobile, timeRange])

  const displayData = useMemo(
    () => sampleChartData(data, targetPointCount),
    [data, targetPointCount],
  )

  const xTickInterval = useMemo(() => {
    if (displayData.length <= 7) {
      return 0
    }

    const targetTickCount = isMobile ? 3 : 6
    return Math.max(1, Math.floor(displayData.length / targetTickCount))
  }, [displayData.length, isMobile])

  const chartHeight = isMobile ? 360 : 430

  const commonAxisProps = {
    stroke: 'rgb(234, 233, 229)',
    style: { fontSize: isMobile ? '0.72rem' : '0.84rem' },
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
    <div className="w-full" style={{ height: `${chartHeight}px` }}>
      <ResponsiveContainer width="100%" height="100%">
        {chartType === 'bar' ? (
          <BarChart
            data={displayData}
            margin={{ top: 8, right: isMobile ? 2 : 14, left: isMobile ? -8 : 4, bottom: 56 }}
            barCategoryGap={isMobile ? '28%' : '20%'}
          >
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
              interval={xTickInterval}
              minTickGap={isMobile ? 26 : 18}
              tickMargin={9}
              height={62}
            />
            <YAxis
              {...commonAxisProps}
              width={isMobile ? 36 : 44}
              label={isMobile ? undefined : { value: unit, angle: -90, position: 'insideLeft' }}
            />
            <Tooltip {...commonTooltipProps} />
            <Bar
              dataKey="power"
              fill="url(#colorGas)"
              maxBarSize={isMobile ? 14 : 20}
              radius={[8, 8, 0, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        ) : (
          <LineChart data={displayData} margin={{ top: 8, right: isMobile ? 2 : 14, left: isMobile ? -8 : 4, bottom: 56 }}>
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
              interval={xTickInterval}
              minTickGap={isMobile ? 26 : 18}
              tickMargin={9}
              height={62}
            />
            <YAxis
              {...commonAxisProps}
              width={isMobile ? 36 : 44}
              label={isMobile ? undefined : { value: unit, angle: -90, position: 'insideLeft' }}
            />
            <Tooltip {...commonTooltipProps} />
            <Line
              type={lineType}
              dataKey="power"
              stroke="rgb(2, 125, 94)"
              strokeWidth={isMobile ? 2.8 : 3.2}
              dot={false}
              activeDot={{ r: isMobile ? 4.5 : 6.5 }}
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
