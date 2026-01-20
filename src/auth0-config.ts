export const auth0Config = {
  domain: "your-auth0-domain.auth0.com", // Replace with your Auth0 domain
  clientId: "your-client-id", // Replace with your Auth0 client ID
  authorizationParams: {
    redirect_uri: window.location.origin,
  },
};