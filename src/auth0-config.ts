const domain = (import.meta.env.VITE_AUTH0_DOMAIN as string | undefined) ?? ''
const clientId = (import.meta.env.VITE_AUTH0_CLIENT_ID as string | undefined) ?? ''

export const auth0Config = {
  domain,
  clientId,
  authorizationParams: {
    redirect_uri: window.location.origin,
  },
}