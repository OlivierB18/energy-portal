import { useState, useEffect } from 'react'
import { X, Download } from 'lucide-react'
import { EnergyPricingConfig, EnergyPricingType } from '../types'

interface EnergyPriceModalProps {
  environmentId: string
  onClose: () => void
  onSave: (config: EnergyPricingConfig) => void
  getAuthToken?: () => Promise<string>
}

export default function EnergyPriceModal({
  environmentId,
  onClose,
  onSave,
  getAuthToken,
}: EnergyPriceModalProps) {
  const normalizePricingConfig = (input: unknown): EnergyPricingConfig | null => {
    if (!input || typeof input !== 'object') {
      return null
    }

    const value = input as Record<string, unknown>
    const parseNumber = (raw: unknown, fallback: number) => {
      const parsed = Number(raw)
      return Number.isFinite(parsed) ? parsed : fallback
    }

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
    setProducerPrice((config.producerPrice || 0.10).toString())
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

  const handleFetchENTSOE = async () => {
    if (!getAuthToken) {
      setError('No auth function available')
      return
    }

    setEntsoeLoading(true)
    setError(null)

    try {
      const token = await getAuthToken()
      const response = await fetch('/.netlify/functions/get-entsoe-prices', {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!response.ok) {
        const data = await response.json().catch(() => null)
        throw new Error(data?.error || 'Failed to fetch ENTSOE prices')
      }

      const data = await response.json()
      // eslint-disable-next-line no-console
      console.log('[EnergyPrice] ENTSOE prices:', data)

      if (data.prices && data.prices.length > 0) {
        setPricingType('dynamic')
        // For now, show average price
        const avgPrice = (data.prices.reduce((sum: number, p: any) => sum + p.price, 0) / data.prices.length) / 1000 // Convert MWh to kWh
        setConsumerPrice(avgPrice.toFixed(4))
        // eslint-disable-next-line no-console
        console.log('[EnergyPrice] Set consumer price to:', avgPrice.toFixed(4), '€/kWh')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch ENTSOE prices')
    } finally {
      setEntsoeLoading(false)
    }
  }

  const handleSave = async () => {
    setLoading(true)
    setError(null)

    try {
      const config: EnergyPricingConfig = {
        type: pricingType,
        consumerPrice: parseFloat(consumerPrice),
        producerPrice: parseFloat(producerPrice),
        consumerMargin: parseFloat(consumerMargin),
        producerMargin: parseFloat(producerMargin),
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
      <div className="glass-panel rounded-2xl shadow-2xl max-w-2xl w-full max-h-96 overflow-y-auto">
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
              <p className="text-xs text-light-1 opacity-70 mt-1">Reduced from payout</p>
            </div>
          </div>

          {/* ENTSOE Button */}
          {pricingType === 'dynamic' && (
            <button
              onClick={handleFetchENTSOE}
              disabled={entsoeLoading}
              className="w-full flex items-center justify-center gap-2 py-2 px-4 bg-brand-2 hover:bg-brand-3 text-light-2 rounded-lg font-medium transition-all disabled:opacity-60"
            >
              <Download className="w-4 h-4" />
              {entsoeLoading ? 'Loading...' : 'Fetch ENTSOE Day-Ahead Prices'}
            </button>
          )}

          {/* Summary */}
          <div className="bg-dark-2 bg-opacity-50 rounded-lg p-4 text-sm text-light-1">
            <p className="font-medium mb-2">Summary:</p>
            <p>
              Consumer: €{parseFloat(consumerPrice).toFixed(4)}/kWh + €{parseFloat(consumerMargin).toFixed(4)}/kWh margin
            </p>
            <p>
              Producer: €{parseFloat(producerPrice).toFixed(4)}/kWh - €{parseFloat(producerMargin).toFixed(4)}/kWh margin
            </p>
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
