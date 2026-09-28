const { GoogleAuth } = require('google-auth-library');

let auth = null;

// Lazy so the env is read after dotenv; the library caches and refreshes the token itself.
function obtenerGoogleAuth() {
  if (!auth) {
    auth = new GoogleAuth({
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
  }
  return auth;
}

async function obtenerAccessToken() {
  const client = await obtenerGoogleAuth().getClient();
  const { token } = await client.getAccessToken();
  return token;
}

module.exports = { obtenerGoogleAuth, obtenerAccessToken };
