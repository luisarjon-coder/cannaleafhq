// Canna Leaf HQ -- sends a real push notification (reaches a phone even if the app
// isn't open) whenever a new product request, task, or announcement is added.
// Supabase calls this via a Database Webhook on every INSERT into the "documents"
// table; this function ignores anything it doesn't recognize and only acts on those
// three kinds of rows. Tasks and announcements go out to EVERY device that has
// notifications turned on for that location (no recipient picking, unlike product
// requests) -- that's the whole team and every admin.
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
  const data = record.data || {};

  // The webhook fires for every insert into the shared "documents" table (members, promoters,
  // everything) -- work out which of the three pushable kinds this is, and build the
  // notification for it. Anything else is silently ignored.
  let locationId, title, pushBody, tag;

  if (/__productRequests$/.test(collection)) {
    locationId = collection.replace(/__productRequests$/, "");
    const stockLabel = data.stock === "out" ? "OUT OF STOCK" : data.stock === "almost_out" ? "almost out" : "requested";
    title = "Product request: " + (data.item || "an item");
    var reqLines = [stockLabel];
    if (data.employee) reqLines.push("by " + data.employee);
    if (data.notes) reqLines.push(data.notes);
    pushBody = reqLines.join(" — ");
    tag = "product-request";
  } else if (/__tasks$/.test(collection)) {
    locationId = collection.replace(/__tasks$/, "");
    title = "📋 New task";
    var taskLines = [data.text || "New task"];
    if (data.assignee) taskLines.push("assigned to " + data.assignee);
    pushBody = taskLines.join(" — ");
    tag = "task";
  } else if (/__announcements$/.test(collection)) {
    locationId = collection.replace(/__announcements$/, "");
    title = "📣 Announcement";
    var annLines = [data.text || ""];
    if (data.author) annLines.push(data.author);
    pushBody = annLines.join(" — ");
    tag = "announcement";
  } else {
    res.status(200).json({ skipped: true, reason: "not a pushable row" });
    return;
  }

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

  const payload = JSON.stringify({ title: title, body: pushBody, tag: tag, url: "/" });
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
