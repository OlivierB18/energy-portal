import { useState, useEffect, useMemo } from 'react'
import { X } from 'lucide-react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { EnergyPricingConfig, EnergyPricingType } from '../types'

interface EnergyPriceModalProps {
  environmentId: string
  onClose: () => void
  onSave: (config: EnergyPricingConfig) => void
  getAuthToken?: () => Promise<string>
}

interface EntsoePricePoint {
  time: string
  eurPerKwh: number
  isForecast: boolean
}

interface EntsoeChartPoint {
  time: string
  fullTime: string
  price: number
  currentPrice: number | null
  forecastPrice: number | null
  fixedConsumerPrice: number | null
  fixedProducerPrice: number | null
}

const DYNAMIC_PRICE_CHART_EVENT = 'energy-dynamic-chart-visibility-changed'

export default function EnergyPriceModal({
  environmentId,
  onClose,
  onSave,
  getAuthToken,
}: EnergyPriceModalProps) {
  const dynamicChartPreferenceKey = `energy_dynamic_chart_visible_${environmentId || 'default'}`
  const fixedLinesPreferenceKey = `energy_dynamic_chart_show_fixed_lines_${environmentId || 'default'}`

  const parseNumber = (raw: unknown, fallback: number) => {
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  const emitChartPreferenceChange = (visible: boolean, showFixedLines: boolean) => {
    window.dispatchEvent(new CustomEvent(DYNAMIC_PRICE_CHART_EVENT, {
      detail: { environmentId, visible, showFixedLines },
    }))
  }

  const persistDynamicChartPreference = (visible: boolean, showFixedLines: boolean) => {
    localStorage.setItem(dynamicChartPreferenceKey, JSON.stringify({ visible, updatedAt: new Date().toISOString() }))
    emitChartPreferenceChange(visible, showFixedLines)
  }

  const persistFixedLinesPreference = (showFixedLines: boolean, visible: boolean) => {
    localStorage.setItem(fixedLinesPreferenceKey, JSON.stringify({ visible: showFixedLines, updatedAt: new Date().toISOString() }))
    emitChartPreferenceChange(visible, showFixedLines)
  }

  const normalizeEntsoePoints = (payload: unknown): EntsoePricePoint[] => {
    if (!payload || typeof payload !== 'object') {
      return []
    }

    const value = payload as { prices?: Array<{ time?: unknown; eurPerKwh?: unknown; price?: unknown }> }
    const rows = Array.isArray(value.prices) ? value.prices : []
    const now = Date.now()
    const byTime = new Map<string, EntsoePricePoint>()

    for (const row of rows) {
      const rawTime = String(row?.time || '').trim()
      const parsedTime = Date.parse(rawTime)
      if (!rawTime || Number.isNaN(parsedTime)) {
        continue
      }

      const directPrice = Number(row?.eurPerKwh)
      const convertedPrice = Number(row?.price) / 1000
      const eurPerKwh = Number.isFinite(directPrice)
        ? directPrice
        : convertedPrice

      if (!Number.isFinite(eurPerKwh)) {
        continue
      }

      const normalizedTime = new Date(parsedTime).toISOString()
      byTime.set(normalizedTime, {
        time: normalizedTime,
        eurPerKwh,
        isForecast: parsedTime > now,
      })
    }

    return Array.from(byTime.values()).sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
  }

  const normalizePricingConfig = (input: unknown): EnergyPricingConfig | null => {
    if (!input || typeof input !== 'object') {
      return null
    }

    const value = input as Record<string, unknown>

    return {
      type: value.type === 'dynamic' ? 'dynamic' : 'fixed',
      consumerPrice: parseNumber(value.consumerPrice, 0.30),
      producerPrice: parseNumber(value.producerPrice, 0.10),
      consumerMargin: parseNumber(value.consumerMargin, 0.05),
      producerMargin: parseNumber(value.producerMargin, 0.02),
    }
  }

  const applyPricingConfig = (config: EnergyPricingConfig) => {
    setPricingType(config.type || 'fixed')
    setConsumerPrice((config.consumerPrice || 0.30).toString())
    setProducerPrice((config.producerPrice ?? config.consumerPrice ?? 0.10).toString())
    setConsumerMargin((config.consumerMargin || 0.05).toString())
    setProducerMargin((config.producerMargin || 0.02).toString())
  }

  const [pricingType, setPricingType] = useState<EnergyPricingType>('fixed')
  const [consumerPrice, setConsumerPrice] = useState<string>('0.30')
  const [producerPrice, setProducerPrice] = useState<string>('0.10')
  const [consumerMargin, setConsumerMargin] = useState<string>('0.05')
  const [producerMargin, setProducerMargin] = useState<string>('0.02')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [entsoeLoading, setEntsoeLoading] = useState(false)
  const [showDynamicChart, setShowDynamicChart] = useState(false)
  const [showFixedPriceLines, setShowFixedPriceLines] = useState(true)
  const [entsoePoints, setEntsoePoints] = useState<EntsoePricePoint[]>([])
  const [entsoeUpdatedAt, setEntsoeUpdatedAt] = useState<string | null>(null)

  const entsoeChartData = useMemo<EntsoeChartPoint[]>(() => {
    const fixedConsumerLine = showFixedPriceLines && pricingType === 'fixed'
      ? Number((parseNumber(consumerPrice, 0.30) + parseNumber(consumerMargin, 0.05)).toFixed(4))
      : null
    const fixedProducerLine = showFixedPriceLines && pricingType === 'fixed'
      ? Number(Math.max(0, parseNumber(producerPrice, 0.10) - parseNumber(producerMargin, 0.02)).toFixed(4))
      : null

    return entsoePoints.map((point) => {
      const date = new Date(point.time)
      const time = date.toLocaleString([], {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
      const fullTime = date.toLocaleString([], {
        weekday: 'short',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
      const roundedPrice = Number(point.eurPerKwh.toFixed(4))

      return {
        time,
        fullTime,
        price: roundedPrice,
        currentPrice: point.isForecast ? null : roundedPrice,
        forecastPrice: point.isForecast ? roundedPrice : null,
        fixedConsumerPrice: fixedConsumerLine,
        fixedProducerPrice: fixedProducerLine,
      }
    })
  }, [consumerMargin, consumerPrice, entsoePoints, pricingType, producerMargin, producerPrice, showFixedPriceLines])

  useEffect(() => {
    let isMounted = true

    const loadSavedPricing = () => {
      try {
        const key = `energy_pricing_${environmentId}`
        const saved = localStorage.getItem(key)
        if (saved) {
          const config = normalizePricingConfig(JSON.parse(saved))
          if (config && isMounted) {
            applyPricingConfig(config)
          }
        }
      } catch {
        setError('Failed to load saved pricing')
      }
    }

    const loadServerPricing = async () => {
      if (!getAuthToken) {
        return
      }

      try {
        const token = await getAuthToken()
        const response = await fetch(`/.netlify/functions/get-energy-pricing?environmentId=${encodeURIComponent(environmentId)}`, {
          headers: { Authorization: `Bearer ${token}` },
        })

        if (!response.ok) {
          return
        }

        const data = await response.json()
        const config = normalizePricingConfig(data?.config)
        if (!config || !isMounted) {
          return
        }

        applyPricingConfig(config)
        const key = `energy_pricing_${environmentId}`
        localStorage.setItem(key, JSON.stringify(config))
      } catch {
        // Keep local fallback when server config cannot be loaded.
      }
    }

    loadSavedPricing()
    void loadServerPricing()

    return () => {
      isMounted = false
    }
  }, [environmentId, getAuthToken])

  useEffect(() => {
    try {
      const chartStored = localStorage.getItem(dynamicChartPreferenceKey)
      if (chartStored) {
        const parsed = JSON.parse(chartStored)
        if (typeof parsed?.visible === 'boolean') {
          setShowDynamicChart(parsed.visible)
        }
      }

      const fixedLinesStored = localStorage.getItem(fixedLinesPreferenceKey)
      if (fixedLinesStored) {
        const parsed = JSON.parse(fixedLinesStored)
        if (typeof parsed?.visible === 'boolean') {
          setShowFixedPriceLines(parsed.visible)
        }
      }
    } catch {
      // Ignore malformed preference data.
    }
  }, [dynamicChartPreferenceKey, fixedLinesPreferenceKey])

  const fetchENTSOE = async (hoursAhead: number) => {
    if (!getAuthToken) {
      throw new Error('No auth function available')
    }

    const token = await getAuthToken()
    const response = await fetch(`/.netlify/functions/get-entsoe-prices?hoursAhead=${encodeURIComponent(String(hoursAhead))}`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!response.ok) {
      const data = await response.json().catch(() => null)
      throw new Error(data?.message || data?.error || 'Failed to fetch ENTSOE prices')
    }

    const data = await response.json()
    const points = normalizeEntsoePoints(data)
    setEntsoePoints(points)
    setEntsoeUpdatedAt(typeof data?.timestamp === 'string' ? data.timestamp : new Date().toISOString())
    return { data, points }
  }

  useEffect(() => {
    if (!showDynamicChart) {
      setEntsoeLoading(false)
      return
    }

    let isMounted = true

    const refreshDynamicData = async () => {
      if (isMounted) {
        setEntsoeLoading(true)
        setError(null)
      }

      try {
        const { data, points } = await fetchENTSOE(120)
        if (!isMounted) {
          return
        }

        if (points.length === 0) {
          const resolutionInfo = Array.isArray(data?.resolutions) && data.resolutions.length > 0
            ? ` (resolution: ${data.resolutions.join(', ')})`
            : ''
          throw new Error(`No ENTSOE prices available for the selected horizon${resolutionInfo}`)
        }

        const currentPrice = parseNumber(data?.current?.eurPerKwh, NaN)
        const averagePrice = points.reduce((sum, point) => sum + point.eurPerKwh, 0) / points.length

        const nextBasePrice = Number.isFinite(currentPrice)
          ? currentPrice
          : Number.isFinite(averagePrice)
            ? averagePrice
            : NaN

        if (!Number.isFinite(nextBasePrice)) {
          throw new Error('No valid ENTSOE price returned')
        }

        if (pricingType === 'dynamic') {
          setConsumerPrice(nextBasePrice.toFixed(4))
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : 'Failed to fetch ENTSOE prices')
        }
      } finally {
        if (isMounted) {
          setEntsoeLoading(false)
        }
      }
    }

    void refreshDynamicData()
    const intervalId = window.setInterval(() => {
      void refreshDynamicData()
    }, 15 * 60 * 1000)

    return () => {
      isMounted = false
      window.clearInterval(intervalId)
    }
  }, [getAuthToken, pricingType, showDynamicChart])

  const handleShowChartOnUiChange = (visible: boolean) => {
    setShowDynamicChart(visible)
    persistDynamicChartPreference(visible, showFixedPriceLines)
  }

  const handleShowFixedLinesChange = (visible: boolean) => {
    setShowFixedPriceLines(visible)
    persistFixedLinesPreference(visible, showDynamicChart)
  }

  const handleSave = async () => {
    setLoading(true)
    setError(null)

    try {
      const dynamicBasePrice = parseNumber(consumerPrice, 0.30)
      const config: EnergyPricingConfig = {
        type: pricingType,
        consumerPrice: pricingType === 'dynamic'
          ? dynamicBasePrice
          : parseNumber(consumerPrice, 0.30),
        producerPrice: pricingType === 'dynamic'
          ? dynamicBasePrice
          : parseNumber(producerPrice, 0.10),
        consumerMargin: parseNumber(consumerMargin, 0.05),
        producerMargin: parseNumber(producerMargin, 0.02),
      }

      const key = `energy_pricing_${environmentId}`
      localStorage.setItem(key, JSON.stringify(config))

      if (getAuthToken) {
        const token = await getAuthToken()
        const response = await fetch('/.netlify/functions/save-energy-pricing', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            environmentId,
            config,
          }),
        })

        if (!response.ok) {
          const data = await response.json().catch(() => null)
          throw new Error(data?.error || 'Failed to save pricing to server')
        }
      }

      // eslint-disable-next-line no-console
      console.log('[EnergyPrice] Saved pricing config:', config)

      onSave(config)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save pricing')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
      <div className="glass-panel rounded-2xl shadow-2xl max-w-3xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-light-2 border-opacity-10">
          <h2 className="text-2xl font-heavy text-dark-1">Energy Price Settings</h2>
          <button
            onClick={onClose}
            className="p-2 hover:bg-light-2 hover:bg-opacity-10 rounded-lg transition-all"
          >
            <X className="w-5 h-5 text-light-2" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {error && <p className="text-red-300 text-sm">{error}</p>}

          {entsoeLoading && showDynamicChart && (
            <p className="text-light-1 text-xs opacity-80">Updating dynamic prices in background...</p>
          )}

          {/* Pricing Type Toggle */}
          <div>
            <label className="block text-light-1 text-sm font-medium mb-3">Pricing Type</label>
            <div className="flex gap-4">
              <button
                onClick={() => setPricingType('fixed')}
                className={`flex-1 py-2 px-4 rounded-lg font-medium transition-all ${
                  pricingType === 'fixed'
                    ? 'glass-button'
                    : 'bg-dark-2 bg-opacity-70 text-light-1 hover:bg-opacity-90'
                }`}
              >
                Fixed Price
              </button>
              <button
                onClick={() => setPricingType('dynamic')}
                className={`flex-1 py-2 px-4 rounded-lg font-medium transition-all ${
                  pricingType === 'dynamic'
                    ? 'glass-button'
                    : 'bg-dark-2 bg-opacity-70 text-light-1 hover:bg-opacity-90'
                }`}
              >
                Dynamic Price
              </button>
            </div>
          </div>

          {/* Pricing Fields */}
          {pricingType === 'fixed' ? (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-light-1 text-sm font-medium mb-2">Consumer Price (€/kWh)</label>
                <input
                  type="number"
                  step="0.001"
                  value={consumerPrice}
                  onChange={(e) => setConsumerPrice(e.target.value)}
                  className="w-full px-3 py-2 bg-dark-2 bg-opacity-50 text-light-2 border border-light-2 border-opacity-20 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-2"
                />
                <p className="text-xs text-light-1 opacity-70 mt-1">What you pay when consuming</p>
              </div>
              <div>
                <label className="block text-light-1 text-sm font-medium mb-2">Producer Price (€/kWh)</label>
                <input
                  type="number"
                  step="0.001"
                  value={producerPrice}
                  onChange={(e) => setProducerPrice(e.target.value)}
                  className="w-full px-3 py-2 bg-dark-2 bg-opacity-50 text-light-2 border border-light-2 border-opacity-20 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-2"
                />
                <p className="text-xs text-light-1 opacity-70 mt-1">What you get when producing</p>
              </div>
            </div>
          ) : (
            <div className="bg-dark-2 bg-opacity-50 rounded-lg p-4 text-sm text-light-1">
              <p className="font-medium text-light-2">Dynamic base price is automatic</p>
              <p className="text-xs opacity-80 mt-1">
                Active dynamic base price: €{parseNumber(consumerPrice, 0.30).toFixed(4)}/kWh
              </p>
              <p className="text-xs opacity-70 mt-2">
                Consumer and producer both use the current dynamic price as base.
              </p>
            </div>
          )}

          {/* Margin Fields */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-light-1 text-sm font-medium mb-2">Consumer Margin (€/kWh)</label>
              <input
                type="number"
                step="0.001"
                value={consumerMargin}
                onChange={(e) => setConsumerMargin(e.target.value)}
                className="w-full px-3 py-2 bg-dark-2 bg-opacity-50 text-light-2 border border-light-2 border-opacity-20 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-2"
              />
              <p className="text-xs text-light-1 opacity-70 mt-1">Extra charge on top</p>
            </div>
            <div>
              <label className="block text-light-1 text-sm font-medium mb-2">Producer Margin (€/kWh)</label>
              <input
                type="number"
                step="0.001"
                value={producerMargin}
                onChange={(e) => setProducerMargin(e.target.value)}
                className="w-full px-3 py-2 bg-dark-2 bg-opacity-50 text-light-2 border border-light-2 border-opacity-20 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-2"
              />
              <p className="text-xs text-light-1 opacity-70 mt-1">Added on top of dynamic producer base</p>
            </div>
          </div>

          {/* Dynamic Chart Toggles */}
          <div className="space-y-3">
            <label className="flex items-center gap-3 rounded-lg border border-light-2 border-opacity-20 bg-dark-2 bg-opacity-50 px-4 py-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showDynamicChart}
                onChange={(event) => handleShowChartOnUiChange(event.target.checked)}
                className="h-4 w-4 accent-emerald-500"
              />
              <div>
                <p className="text-light-2 text-sm font-medium">Show chart on UI</p>
                <p className="text-xs text-light-1 opacity-75">
                  Fetches dynamic market prices in background only when enabled.
                </p>
              </div>
            </label>

            {showDynamicChart && pricingType === 'fixed' && (
              <label className="flex items-center gap-3 rounded-lg border border-light-2 border-opacity-20 bg-dark-2 bg-opacity-50 px-4 py-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showFixedPriceLines}
                  onChange={(event) => handleShowFixedLinesChange(event.target.checked)}
                  className="h-4 w-4 accent-emerald-500"
                />
                <div>
                  <p className="text-light-2 text-sm font-medium">Show fixed prices in chart</p>
                  <p className="text-xs text-light-1 opacity-75">
                    Adds your fixed consumer/producer rates as comparison lines.
                  </p>
                </div>
              </label>
            )}
          </div>

          {showDynamicChart && (
            <div className="bg-dark-2 bg-opacity-50 rounded-lg p-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-3">
                <p className="text-light-2 text-sm font-medium">
                  Dynamic Price Chart (Today + Forecast)
                </p>
                {entsoeUpdatedAt && (
                  <p className="text-xs text-light-1 opacity-80">
                    Updated: {new Date(entsoeUpdatedAt).toLocaleString()}
                  </p>
                )}
              </div>

              {entsoeChartData.length === 0 ? (
                <p className="text-xs text-light-1 opacity-80">
                  {entsoeLoading
                    ? 'Loading dynamic prices in the background...'
                    : 'No dynamic prices available yet.'}
                </p>
              ) : (
                <>
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={entsoeChartData} margin={{ top: 12, right: 16, left: 0, bottom: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.12)" />
                        <XAxis
                          dataKey="time"
                          tick={{ fill: 'rgba(255,255,255,0.75)', fontSize: 11 }}
                          minTickGap={24}
                        />
                        <YAxis
                          tick={{ fill: 'rgba(255,255,255,0.75)', fontSize: 11 }}
                          tickFormatter={(value: number) => `EUR ${Number(value).toFixed(3)}`}
                          width={84}
                        />
                        <Tooltip
                          labelFormatter={(label, payload) => {
                            const first = Array.isArray(payload) && payload.length > 0
                              ? payload[0]
                              : null
                            return typeof first?.payload?.fullTime === 'string' ? first.payload.fullTime : String(label)
                          }}
                          formatter={(value: number | string) => {
                            const numericValue = Number(value)
                            return [`EUR ${numericValue.toFixed(4)} /kWh`, 'Price']
                          }}
                          contentStyle={{
                            background: 'rgba(15, 23, 42, 0.95)',
                            border: '1px solid rgba(255,255,255,0.15)',
                            borderRadius: '0.75rem',
                            color: '#f8fafc',
                          }}
                          itemStyle={{ color: '#f8fafc' }}
                          labelStyle={{ color: '#f8fafc' }}
                        />
                        <Line
                          type="monotone"
                          dataKey="currentPrice"
                          stroke="#34d399"
                          strokeWidth={2}
                          dot={false}
                          connectNulls
                          name="Current"
                        />
                        <Line
                          type="monotone"
                          dataKey="forecastPrice"
                          stroke="#f59e0b"
                          strokeWidth={2}
                          strokeDasharray="6 4"
                          dot={false}
                          connectNulls
                          name="Forecast"
                        />
                        {showFixedPriceLines && pricingType === 'fixed' && (
                          <Line
                            type="linear"
                            dataKey="fixedConsumerPrice"
                            stroke="#60a5fa"
                            strokeWidth={2}
                            dot={false}
                            connectNulls
                            name="Fixed Consumer (incl. margin)"
                          />
                        )}
                        {showFixedPriceLines && pricingType === 'fixed' && (
                          <Line
                            type="linear"
                            dataKey="fixedProducerPrice"
                            stroke="#a78bfa"
                            strokeWidth={2}
                            strokeDasharray="4 4"
                            dot={false}
                            connectNulls
                            name="Fixed Producer (after margin)"
                          />
                        )}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <p className="text-xs text-light-1 opacity-75 mt-3">
                    The chart shows ENTSOE prices as far ahead as currently available from the API.
                  </p>
                  <p className="text-xs text-light-1 opacity-75 mt-1">
                    When enabled, this chart is also shown below the Gas Chart on the dashboard.
                  </p>
                </>
              )}
            </div>
          )}

          {/* Summary */}
          <div className="bg-dark-2 bg-opacity-50 rounded-lg p-4 text-sm text-light-1">
            <p className="font-medium mb-2">Summary:</p>
            {pricingType === 'dynamic' && (
              <p className="mb-2 text-xs text-light-1 opacity-80">
                Dynamic mode uses ENTSOE base price; supplier margin is added on top.
              </p>
            )}
            {pricingType === 'dynamic' ? (
              <>
                <p>
                  Consumer: dynamic base €{parseNumber(consumerPrice, 0.30).toFixed(4)}/kWh + €{parseNumber(consumerMargin, 0.05).toFixed(4)}/kWh margin
                </p>
                <p>
                  Producer: dynamic base €{parseNumber(consumerPrice, 0.30).toFixed(4)}/kWh + €{parseNumber(producerMargin, 0.02).toFixed(4)}/kWh margin
                </p>
              </>
            ) : (
              <>
                <p>
                  Consumer: €{parseNumber(consumerPrice, 0.30).toFixed(4)}/kWh + €{parseNumber(consumerMargin, 0.05).toFixed(4)}/kWh margin
                </p>
                <p>
                  Producer: €{parseNumber(producerPrice, 0.10).toFixed(4)}/kWh - €{parseNumber(producerMargin, 0.02).toFixed(4)}/kWh margin
                </p>
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-6 border-t border-light-2 border-opacity-10">
          <button
            onClick={onClose}
            className="flex-1 py-2 px-4 bg-dark-2 bg-opacity-70 text-light-1 hover:bg-opacity-90 rounded-lg font-medium transition-all"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={loading}
            className="flex-1 py-2 px-4 glass-button rounded-lg font-medium transition-all disabled:opacity-60"
          >
            {loading ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
