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
  ReferenceLine,
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

const smoothLineData = (
  points: Array<{ time: string; power: number | null }>,
  windowSize: number,
): Array<{ time: string; power: number | null }> => {
  if (windowSize < 2 || points.length < 3) {
    return points
  }

  const radius = Math.floor(windowSize / 2)

  return points.map((point, index) => {
    if (typeof point.power !== 'number') {
      return point
    }

    let sum = 0
    let count = 0
    for (let offset = -radius; offset <= radius; offset += 1) {
      const neighbor = points[index + offset]
      if (neighbor && typeof neighbor.power === 'number') {
        sum += neighbor.power
        count += 1
      }
    }

    if (count === 0) {
      return point
    }

    return {
      ...point,
      power: Number((sum / count).toFixed(3)),
    }
  })
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
    power: number | null
  }>
  timeRange: 'today' | 'week' | 'month'
  unit?: string
  seriesLabel?: string
  rangeLabel?: string
  chartType?: 'line' | 'bar'
  lineType?: 'monotone' | 'linear' | 'step'
  signed?: boolean
}

export default function EnergyChart({
  data,
  timeRange,
  unit = 'kW',
  seriesLabel = 'Power',
  rangeLabel,
  chartType = 'line',
  lineType = 'monotone',
  signed = false,
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

    return Number.MAX_SAFE_INTEGER
  }, [chartType, isMobile, timeRange])

  const displayData = useMemo(
    () => chartType === 'line' ? data : sampleChartData(data, targetPointCount),
    [chartType, data, targetPointCount],
  )

  const smoothingWindow = useMemo(() => {
    if (chartType !== 'line') return 1
    if (signed) return 1
    if (timeRange === 'today') return 3
    if (timeRange === 'week') return 5
    return 5
  }, [chartType, signed, timeRange])

  const lineDisplayData = useMemo(
    () => (chartType === 'line' ? smoothLineData(displayData, smoothingWindow) : displayData),
    [chartType, displayData, smoothingWindow],
  )

  const signedDisplayData = useMemo(() => {
    if (!signed) return lineDisplayData

    const splitSeries = lineDisplayData.map((point) => {
      const value = typeof point.power === 'number' ? point.power : null
      return {
        ...point,
        powerPos: value !== null && value > 0 ? value : null,
        powerNeg: value !== null && value < 0 ? value : null,
      }
    })

    // Bridge sign changes through y=0 so green/yellow lines visually connect.
    for (let index = 1; index < splitSeries.length; index += 1) {
      const previous = splitSeries[index - 1]
      const current = splitSeries[index]

      const previousValue = typeof previous.power === 'number' ? previous.power : null
      const currentValue = typeof current.power === 'number' ? current.power : null

      if (previousValue === null || currentValue === null) {
        continue
      }

      if (previousValue > 0 && currentValue < 0) {
        previous.powerNeg = 0
        current.powerPos = 0
      } else if (previousValue < 0 && currentValue > 0) {
        previous.powerPos = 0
        current.powerNeg = 0
      }
    }

    return splitSeries
  }, [lineDisplayData, signed])

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
    formatter: (value: unknown, name: string) => {
      const numericValue = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(numericValue)) {
        return ['-', seriesLabel]
      }
      if (name === 'powerPos') return [`${numericValue.toFixed(decimals)} ${unit}`, 'Verbruik']
      if (name === 'powerNeg') return [`${numericValue.toFixed(decimals)} ${unit}`, 'Teruglevering']
      return [`${numericValue.toFixed(decimals)} ${unit}`, seriesLabel]
    },
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
          <LineChart data={signedDisplayData} margin={{ top: 8, right: isMobile ? 2 : 14, left: isMobile ? -8 : 4, bottom: 56 }}>
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
            {signed ? (
              <>
                <ReferenceLine y={0} stroke="rgba(255, 255, 255, 0.25)" strokeDasharray="4 4" />
                <Line
                  type={lineType}
                  dataKey="powerPos"
                  stroke="rgb(2, 125, 94)"
                  strokeWidth={isMobile ? 2.8 : 3.2}
                  dot={false}
                  activeDot={{ r: isMobile ? 4.5 : 6.5, fill: 'rgb(2, 125, 94)' }}
                  isAnimationActive={false}
                  connectNulls={false}
                />
                <Line
                  type="monotone"
                  dataKey="powerNeg"
                  stroke="rgb(250, 204, 21)"
                  strokeWidth={isMobile ? 2.8 : 3.2}
                  strokeOpacity={0.95}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  dot={false}
                  activeDot={{ r: isMobile ? 4.5 : 6.5, fill: 'rgb(250, 204, 21)' }}
                  isAnimationActive={false}
                  connectNulls={false}
                />
              </>
            ) : (
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
            )}
          </LineChart>
        )}
      </ResponsiveContainer>
      <p className="text-center text-light-1 text-sm mt-4">
        {seriesLabel} for {timeRange === 'today' ? 'day' : timeRange === 'week' ? 'week' : 'month'}{rangeLabel ? ` (${rangeLabel})` : ''}
      </p>
    </div>
  )
}
