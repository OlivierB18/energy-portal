import { createRemoteJWKSet, jwtVerify } from 'jose'

const getEnv = (key) => {
  const value = process.env[key]
  if (!value) {
    throw new Error(`Missing ${key}`)
  }
  return value
}

const getTagValue = (xml, tagName) => {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'i')
  const match = xml.match(regex)
  return match ? String(match[1]).trim() : ''
}

const parseEntsoeReasonText = (xml) => {
  if (!xml || typeof xml !== 'string') {
    return ''
  }

  const reasonCode = getTagValue(xml, 'code')
  const reasonText = getTagValue(xml, 'text')
  if (!reasonCode && !reasonText) {
    return ''
  }

  return [reasonCode ? `code ${reasonCode}` : '', reasonText].filter(Boolean).join(': ')
}

const parseResolutionMinutes = (resolutionRaw) => {
  const source = String(resolutionRaw || '').trim()
  const match = source.match(/^PT(?:(\d+)H)?(?:(\d+)M)?$/i)
  if (!match) {
    return 60
  }

  const hours = Number(match[1] || 0)
  const minutes = Number(match[2] || 0)
  const total = (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0)
  return total > 0 ? total : 60
}

const round = (value, decimals) => {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

const parseENTSOEXML = (xml) => {
  const periodRegex = /<Period>([\s\S]*?)<\/Period>/gi
  const pointRegex = /<Point>([\s\S]*?)<\/Point>/gi
  const byTime = new Map()
  const resolutions = new Set()

  let periodMatch
  while ((periodMatch = periodRegex.exec(xml)) !== null) {
    const periodXml = periodMatch[1]
    const startRaw = getTagValue(periodXml, 'start')
    const startDate = new Date(startRaw)
    if (Number.isNaN(startDate.getTime())) {
      continue
    }

    const resolutionRaw = getTagValue(periodXml, 'resolution')
    const resolutionMinutes = parseResolutionMinutes(resolutionRaw)
    if (resolutionRaw) {
      resolutions.add(resolutionRaw)
    }
    let pointMatch
    while ((pointMatch = pointRegex.exec(periodXml)) !== null) {
      const pointXml = pointMatch[1]
      const position = Number(getTagValue(pointXml, 'position'))
      const rawPrice = getTagValue(pointXml, 'price.amount') || getTagValue(pointXml, 'price')
      const eurPerMWh = Number(rawPrice)

      if (!Number.isFinite(position) || position < 1 || !Number.isFinite(eurPerMWh)) {
        continue
      }

      const timestamp = new Date(startDate.getTime() + (position - 1) * resolutionMinutes * 60_000)
      const time = timestamp.toISOString()

      byTime.set(time, {
        time,
        hour: timestamp.getUTCHours(),
        price: round(eurPerMWh, 2),
        eurPerKwh: round(eurPerMWh / 1000, 5),
      })
    }
  }

  const prices = Array.from(byTime.values()).sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
  return {
    prices,
    resolutions: Array.from(resolutions),
  }
}

const pickCurrentPrice = (prices) => {
  if (!Array.isArray(prices) || prices.length === 0) {
    return null
  }

  const now = Date.now()
  for (let index = 0; index < prices.length; index += 1) {
    const current = prices[index]
    const currentStart = Date.parse(current.time)
    const nextStart = index + 1 < prices.length
      ? Date.parse(prices[index + 1].time)
      : currentStart + 60 * 60 * 1000

    if (!Number.isFinite(currentStart) || !Number.isFinite(nextStart)) {
      continue
    }

    if (now >= currentStart && now < nextStart) {
      return current
    }
  }

  const past = prices.filter((entry) => Date.parse(entry.time) <= now)
  if (past.length > 0) {
    return past[past.length - 1]
  }

  return prices[0]
}

const verifyAuth = async (event) => {
  const authHeader = event.headers.authorization || event.headers.Authorization
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Missing token')
  }

  const token = authHeader.replace('Bearer ', '')
  const domain = getEnv('AUTH0_DOMAIN')
  const jwks = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`))
  await jwtVerify(token, jwks, { issuer: `https://${domain}/` })
}

const formatEntsoeTimestamp = (date) => {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  const hours = String(date.getUTCHours()).padStart(2, '0')
  const minutes = String(date.getUTCMinutes()).padStart(2, '0')
  return `${year}${month}${day}${hours}${minutes}`
}

const parseHoursAhead = (event) => {
  const raw = Number(event.queryStringParameters?.hoursAhead || 48)
  if (!Number.isFinite(raw)) {
    return 48
  }

  const rounded = Math.round(raw)
  return Math.min(168, Math.max(24, rounded))
}

export const handler = async (event) => {
  try {
    if (event.httpMethod !== 'GET') {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: 'Method not allowed' }),
      }
    }

    await verifyAuth(event)

    const apiKey = getEnv('ENTSOE_API_KEY')
    const biddingZone = process.env.ENTSOE_BIDDING_ZONE || '10YNL----------L'
    const hoursAhead = parseHoursAhead(event)
    const now = new Date()
    const startUtc = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0,
      0,
      0,
      0,
    ))
    const endUtc = new Date(startUtc.getTime() + hoursAhead * 60 * 60 * 1000)

    const startTime = formatEntsoeTimestamp(startUtc)
    const endTime = formatEntsoeTimestamp(endUtc)

    const url = new URL('https://web-api.tp.entsoe.eu/api')
    url.searchParams.append('securityToken', apiKey)
    url.searchParams.append('documentType', 'A44')
    url.searchParams.append('in_Domain', biddingZone)
    url.searchParams.append('out_Domain', biddingZone)
    url.searchParams.append('periodStart', startTime)
    url.searchParams.append('periodEnd', endTime)

    const response = await fetch(url.toString())
    if (!response.ok) {
      const text = await response.text()
      const reason = parseEntsoeReasonText(text)
      return {
        statusCode: response.status,
        body: JSON.stringify({
          error: 'Failed to fetch ENTSOE prices',
          message: reason || `ENTSOE responded with HTTP ${response.status}`,
          details: text,
        }),
      }
    }

    const xml = await response.text()
    const parsed = parseENTSOEXML(xml)
    const prices = parsed.prices
    const current = pickCurrentPrice(prices)

    if (prices.length === 0) {
      const reason = parseEntsoeReasonText(xml)
      return {
        statusCode: 502,
        body: JSON.stringify({
          error: 'No ENTSOE prices found for requested period',
          message: reason || 'ENTSOE returned no price points',
        }),
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        prices,
        current: current
          ? {
            time: current.time,
            eurPerMWh: current.price,
            eurPerKwh: current.eurPerKwh,
          }
          : null,
        currency: 'EUR',
        unit: 'MWh',
        biddingZone,
        resolutions: parsed.resolutions,
        pricePoints: prices.length,
        hoursAhead,
        periodStart: startUtc.toISOString(),
        periodEnd: endUtc.toISOString(),
        timestamp: new Date().toISOString(),
      }),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    const statusCode = message === 'Missing token' ? 401 : 500
    const isMissingConfig = /^Missing\s+/i.test(message)
    return {
      statusCode,
      body: JSON.stringify({
        error: isMissingConfig ? `Configuration error: ${message}` : 'Unable to fetch ENTSOE prices',
        message,
      }),
    }
  }
}
