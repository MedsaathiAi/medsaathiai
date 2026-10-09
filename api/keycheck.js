// TEMPORARY check file — delete from GitHub after use.
// Shows only non-secret info about the Firebase key Vercel is using.
const admin = require("firebase-admin");

module.exports = async (req, res) => {
  const out = {};
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || "";
  out.value_length = raw.length;

  let sa;
  try {
    sa = JSON.parse(raw);
    out.json_read = "OK";
  } catch (e) {
    out.json_read = "FAIL: " + e.message;
    return res.status(200).json(out);
  }

  out.key_id_first6 = String(sa.private_key_id || "").slice(0, 6);
  out.client_email = sa.client_email;
  out.project_id = sa.project_id;
  out.database_url = process.env.FIREBASE_DATABASE_URL || "MISSING";

  try {
    const token = await admin.credential.cert(sa).getAccessToken();
    out.google_login = token && token.access_token ? "OK" : "NO TOKEN";
  } catch (e) {
    out.google_login = "FAIL: " + e.message;
  }

  return res.status(200).json(out);
};
