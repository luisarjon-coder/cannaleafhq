// Canna Leaf HQ -- sends a real push notification (reaches a phone even if the app
// isn't open) whenever a new product request is added. Supabase calls this via a
// Database Webhook on every INSERT into the "documents" table; this function ignores
// anything that isn't a product request and only acts on those rows.
//
// Required Vercel environment variables (Project Settings -> Environment Variables):
//   VAPID_PUBLIC_KEY          -- same value as VAPID_PUBLIC_KEY in index.html
//   VAPID_PRIVATE_KEY         -- the matching PRIVATE half (never put this in index.html)
//   VAPID_SUBJECT             -- "mailto:you@example.com" (any contact address; required by the push spec)
//   SUPABASE_URL              -- https://aldpemrueejmefqcfgqh.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY -- the Supabase project's SERVICE ROLE key (Settings -> API in Supabase --
//                                NOT the publishable key already in index.html; keep this one secret)
//   PUSH_TRIGGER_SECRET       -- any random string you make up; must match the header the
//                                Supabase webhook sends, so random internet traffic can't trigger pushes
//
// This file needs the "web-push" package -- see package.json alongside it. Vercel installs it
// automatically on deploy; nothing to run by hand.

const webpush = require("web-push");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  // Shared-secret check so this endpoint can't be triggered by random internet traffic.
  const gotSecret = req.headers["x-push-secret"];
  if (!process.env.PUSH_TRIGGER_SECRET || gotSecret !== process.env.PUSH_TRIGGER_SECRET) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const body = req.body || {};
  const record = body.record || {};
  const collection = record.collection || "";

  // The webhook fires for every insert into the shared "documents" table (members, promoters,
  // everything) -- silently ignore anything that isn't a brand-new product request.
  if (!/__productRequests$/.test(collection)) {
    res.status(200).json({ skipped: true, reason: "not a productRequests row" });
    return;
  }

  const locationId = collection.replace(/__productRequests$/, "");
  const data = record.data || {};

  const stockLabel = data.stock === "out" ? "OUT OF STOCK" : data.stock === "almost_out" ? "almost out" : "requested";
  const title = "Product request: " + (data.item || "an item");
  var bodyLines = [stockLabel];
  if (data.employee) bodyLines.push("by " + data.employee);
  if (data.notes) bodyLines.push(data.notes);
  const pushBody = bodyLines.join(" — ");

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: "server misconfigured (missing Supabase env vars)" });
    return;
  }
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_SUBJECT) {
    res.status(500).json({ error: "server misconfigured (missing VAPID env vars)" });
    return;
  }

  webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

  const subsCollection = locationId + "__pushSubscriptions";
  const restUrl =
    process.env.SUPABASE_URL +
    "/rest/v1/documents?collection=eq." +
    encodeURIComponent(subsCollection) +
    "&select=doc_id,data";

  let rows = [];
  try {
    const supaRes = await fetch(restUrl, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY
      }
    });
    if (!supaRes.ok) throw new Error("Supabase read failed: " + supaRes.status);
    rows = await supaRes.json();
  } catch (err) {
    res.status(502).json({ error: "could not read subscriptions", detail: String(err) });
    return;
  }

  const payload = JSON.stringify({ title: title, body: pushBody, tag: "product-request", url: "/" });
  const results = await Promise.all(
    (rows || []).map(async function (row) {
      const sub = row.data || {};
      if (!sub.endpoint || !sub.keys) return { docId: row.doc_id, ok: false, reason: "malformed subscription" };
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
        return { docId: row.doc_id, ok: true };
      } catch (err) {
        // 404/410 means the browser/OS has permanently dropped this subscription (uninstalled,
        // notifications revoked, etc.) -- delete the dead row so we stop trying it every time.
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          try {
            await fetch(
              process.env.SUPABASE_URL +
                "/rest/v1/documents?collection=eq." +
                encodeURIComponent(subsCollection) +
                "&doc_id=eq." +
                encodeURIComponent(row.doc_id),
              {
                method: "DELETE",
                headers: {
                  apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
                  Authorization: "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY
                }
              }
            );
          } catch (cleanupErr) {
            // best-effort cleanup; not worth failing the request over
          }
          return { docId: row.doc_id, ok: false, reason: "expired, removed" };
        }
        return { docId: row.doc_id, ok: false, reason: String(err) };
      }
    })
  );

  res.status(200).json({ sent: results.filter(function (r) { return r.ok; }).length, total: results.length, results: results });
};
