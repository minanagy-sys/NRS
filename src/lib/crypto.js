/* AES-256-GCM for the MCP access token at rest.
   The token grants read of all Odoo data, so it never sits in the database in
   clear text and never reaches the browser. Rotating TOKEN_KEY invalidates every
   stored token, which signs everyone out — that is the intended behaviour. */

const crypto = require('crypto');

function key() {
  const hex = process.env.TOKEN_KEY || '';
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error('TOKEN_KEY must be 32 bytes of hex. Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  return Buffer.from(hex, 'hex');
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  // iv.tag.ciphertext — everything needed to decrypt except the key.
  return [iv.toString('base64url'), c.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

function decrypt(packed) {
  const [iv, tag, body] = String(packed).split('.');
  if (!iv || !tag || !body) throw new Error('Stored token is malformed.');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
}

const randomId = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

module.exports = { encrypt, decrypt, randomId };
