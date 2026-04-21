import { createRemoteJWKSet, jwtVerify } from 'jose'
import { createServiceSupabaseClient } from './_supabase.js'

const getEnv = (key) => {
  const value = process.env[key]
  if (!value) throw new Error(`Missing ${key}`)
  return value
}

const verifyAuth = async (event) => {
  const authHeader = event.headers.authorization || event.headers.Authorization
  if (!authHeader?.startsWith('Bearer ')) {
    const error = new Error('Missing token')
    error.statusCode = 401
    throw error
  }

  const token = authHeader.replace('Bearer ', '')
  const domain = getEnv('AUTH0_DOMAIN')
  const jwks = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, jwks, { issuer: `https://${domain}/` })
  const emailValue = payload.email || payload['https://brouwer-ems/email']
  return typeof emailValue === 'string' ? emailValue.toLowerCase() : ''
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  try {
    const requestedBy = await verifyAuth(event)
    const body = JSON.parse(event.body || '{}')

    const environmentId = String(body.environmentId || '').trim()
    const entityId = String(body.entityId || '').trim()
    const service = String(body.service || '').trim()
    const commandType = String(body.commandType || 'call_service').trim()
    const serviceData = body.serviceData && typeof body.serviceData === 'object' ? body.serviceData : {}

    if (!environmentId || !entityId || !service) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing environmentId, entityId or service' }) }
    }

    const [domain, action] = service.includes('.') ? service.split('.', 2) : ['', '']
    if (!domain || !action) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid service format. Expected domain.action' }) }
    }

    const supabase = createServiceSupabaseClient()
    const { data: environment, error: environmentError } = await supabase
      .from('environments')
      .select('id,ha_base_url,ha_api_token,is_active')
      .eq('id', environmentId)
      .eq('is_active', true)
      .maybeSingle()

    if (environmentError) throw environmentError
    if (!environment) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Environment not found' }) }
    }

    const commandInsert = {
      environment_id: environmentId,
      command_type: commandType,
      entity_id: entityId,
      service,
      service_data: serviceData,
      status: 'pending',
      requested_by: requestedBy || null,
    }

    const { data: command, error: commandError } = await supabase
      .from('ha_commands')
      .insert(commandInsert)
      .select('*')
      .single()

    if (commandError) throw commandError

    try {
      const response = await fetch(`${String(environment.ha_base_url).replace(/\/+$/, '')}/api/services/${domain}/${action}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${environment.ha_api_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ entity_id: entityId, ...serviceData }),
      })

      const responseText = await response.text()
      const responseJson = (() => {
        try {
          return JSON.parse(responseText)
        } catch {
          return { raw: responseText }
        }
      })()

      if (!response.ok) {
        await supabase
          .from('ha_commands')
          .update({
            status: 'failed',
            executed_at: new Date().toISOString(),
            error: `Home Assistant response ${response.status}`,
            response: responseJson,
          })
          .eq('id', command.id)

        return {
          statusCode: 502,
          body: JSON.stringify({
            error: `Home Assistant response ${response.status}`,
            commandId: command.id,
            response: responseJson,
          }),
        }
      }

      await supabase
        .from('ha_commands')
        .update({
          status: 'success',
          executed_at: new Date().toISOString(),
          response: responseJson,
        })
        .eq('id', command.id)

      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, commandId: command.id, response: responseJson }),
      }
    } catch (executionError) {
      await supabase
        .from('ha_commands')
        .update({
          status: 'failed',
          executed_at: new Date().toISOString(),
          error: executionError instanceof Error ? executionError.message : String(executionError),
        })
        .eq('id', command.id)

      throw executionError
    }
  } catch (error) {
    const statusCode = error?.statusCode || 500
    return {
      statusCode,
      body: JSON.stringify({ error: error instanceof Error ? error.message : 'Unable to execute HA command' }),
    }
  }
}
