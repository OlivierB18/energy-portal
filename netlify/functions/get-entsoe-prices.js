const handler = async (event) => {
  const apiKey = process.env.ENTSOE_API_KEY
  const biddingZone = process.env.ENTSOE_BIDDING_ZONE || '10YNL----------L'

  if (!apiKey || apiKey === 'your_entsoe_api_key_here') {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'ENTSOE_API_KEY not configured' }),
    }
  }

  try {
    const now = new Date()
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000)
    
    // ENTSOE requires dates in format YYYYMMDDHHMM
    const startTime = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}0000`
    const endTime = `${tomorrow.getFullYear()}${String(tomorrow.getMonth() + 1).padStart(2, '0')}${String(tomorrow.getDate()).padStart(2, '0')}0000`
    
    const url = new URL('https://web-api.tp.entsoe.eu/api')
    url.searchParams.append('securityToken', apiKey)
    url.searchParams.append('documentType', 'A44') // Day-ahead prices
    url.searchParams.append('in_Domain', biddingZone)
    url.searchParams.append('out_Domain', biddingZone)
    url.searchParams.append('periodStart', startTime)
    url.searchParams.append('periodEnd', endTime)

    // eslint-disable-next-line no-console
    console.log('[ENTSOE] Fetching prices for', biddingZone, startTime, '-', endTime)

    const response = await fetch(url.toString())
    if (!response.ok) {
      const text = await response.text()
      // eslint-disable-next-line no-console
      console.error('[ENTSOE] Error:', response.status, text)
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: 'Failed to fetch ENTSOE prices', details: text }),
      }
    }

    // Parse XML response (basic parsing)
    const xml = await response.text()
    const prices = parseENTSOEXML(xml)

    // eslint-disable-next-line no-console
    console.log('[ENTSOE] Got', prices.length, 'price points')

    return {
      statusCode: 200,
      body: JSON.stringify({
        prices,
        currency: 'EUR',
        unit: 'MWh',
        biddingZone,
        timestamp: new Date().toISOString(),
      }),
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[ENTSOE] Fetch error:', error)
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Unable to fetch ENTSOE prices',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
    }
  }
}

function parseENTSOEXML(xml) {
  const prices = []
  
  // Simple XML parsing for price points
  // Format: <price>12345</price> (in 0.1 EUR/MWh, so divide by 10 for EUR/MWh)
  const regex = /<price>(\d+(?:\.\d+)?)<\/price>/g
  const timeSeriesRegex = /<TimeSeries>([\s\S]*?)<\/TimeSeries>/g
  
  let timeSeriesMatch
  let timeIndex = 0
  
  while ((timeSeriesMatch = timeSeriesRegex.exec(xml)) !== null) {
    const timeSeries = timeSeriesMatch[1]
    const startMatch = timeSeries.match(/<start>(.*?)<\/start>/)
    const startTime = startMatch ? new Date(startMatch[1]) : null
    
    let priceMatch
    let periodIndex = 0
    while ((priceMatch = regex.exec(timeSeries)) !== null) {
      if (startTime && periodIndex < 24) {
        const priceTime = new Date(startTime.getTime() + periodIndex * 60 * 60 * 1000)
        const priceValue = parseFloat(priceMatch[1]) / 10 // Convert from 0.1 EUR/MWh to EUR/MWh
        prices.push({
          time: priceTime.toISOString(),
          hour: periodIndex,
          price: parseFloat(priceValue.toFixed(2)),
        })
      }
      periodIndex++
    }
  }

  return prices
}

exports.handler = handler
