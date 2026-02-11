import { createRemoteJWKSet, jwtVerify } from 'jose'

const getEnv = (key) => {
  const value = process.env[key]
  if (!value) {
    throw new Error(`Missing ${key}`)
  }
  return value
}

const mask = (value) => {
  if (!value) {
    return ''
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`
}

const getManagementToken = async (domain) => {
  const response = await fetch(`https://${domain}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: getEnv('AUTH0_M2M_CLIENT_ID'),
      client_secret: getEnv('AUTH0_M2M_CLIENT_SECRET'),
      audience: `https://${domain}/api/v2/`,
      grant_type: 'client_credentials',
    }),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Management token failed (${response.status}) ${detail}`)
  }

  const data = await response.json()
  return data.access_token
}

const getClientMetadata = async (domain, token) => {
  const clientId = getEnv('AUTH0_APP_CLIENT_ID')
  const response = await fetch(`https://${domain}/api/v2/clients/${encodeURIComponent(clientId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Client metadata fetch failed (${response.status}) ${detail}`)
  }

  const client = await response.json()
  return client.client_metadata || {}
}

const verifyToken = async (event) => {
  const authHeader = event.headers.authorization || event.headers.Authorization
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Missing token')
  }

  const token = authHeader.replace('Bearer ', '')
  const domain = getEnv('AUTH0_DOMAIN')
  const jwks = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, jwks, { issuer: `https://${domain}/` })
  return payload
}

export const handler = async (event) => {
  try {
    if (event.httpMethod !== 'GET') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
    }

    const envCheck = {
      AUTH0_DOMAIN: !!process.env.AUTH0_DOMAIN,
      AUTH0_M2M_CLIENT_ID: !!process.env.AUTH0_M2M_CLIENT_ID,
      AUTH0_M2M_CLIENT_SECRET: !!process.env.AUTH0_M2M_CLIENT_SECRET,
      AUTH0_APP_CLIENT_ID: !!process.env.AUTH0_APP_CLIENT_ID,
    }

    const payload = await verifyToken(event)
    const domain = getEnv('AUTH0_DOMAIN')
    const managementToken = await getManagementToken(domain)
    const metadata = await getClientMetadata(domain, managementToken)

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        envCheck,
        tokenSub: payload.sub || null,
        appClientId: mask(getEnv('AUTH0_APP_CLIENT_ID')),
        m2mClientId: mask(getEnv('AUTH0_M2M_CLIENT_ID')),
        metadataKeys: Object.keys(metadata || {}),
      }),
    }
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : 'Server error',
      }),
    }
  }
}
