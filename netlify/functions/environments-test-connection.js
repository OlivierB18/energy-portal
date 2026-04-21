import { handler as environmentsHandler } from './environments.js'

export const handler = async (event, context) => {
  const body = (() => {
    try {
      return JSON.parse(event.body || '{}')
    } catch {
      return {}
    }
  })()

  return environmentsHandler(
    {
      ...event,
      httpMethod: 'POST',
      body: JSON.stringify({ ...body, action: 'test-connection' }),
    },
    context,
  )
}
