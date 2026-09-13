// Canna Leaf HQ -- runs once a day via Vercel Cron (see vercel.json) at 11:35 Spain time to check
// today's schedule for anyone 5+ minutes late who hasn't clocked in yet, log it, and push a
// "you're running late" notification straight to their own phone.
//
// This is the server-side counterpart to the client-side late-shift detector already built into
// index.html (which only notices while an admin/manager device has the app open) -- this one
// runs on Vercel's own clock, so it works even with the app fully closed everywhere. It writes to
// the exact same "lateLog" collection the app already reads, so anything this catches shows up in
// the app's "Late for shift" history exactly like anything the in-app detector catches.
//
// Required Vercel environment variables (Project Settings -> Environment Variables):
//   CRON_SECRET               -- any random string. Set it here AND Vercel automatically signs
//                                its own cron requests with it (Authorization: Bearer <value>) --
//                                no extra setup needed once the env var exists. This stops anyone
//                                else from triggering the check by hitting the URL directly.
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
//                              -- already set from the push notification setup; reused as-is.
//
// If you ever add another club location, add its location id to this list too -- it must match
// the id used in index.html's DEFAULT_LOCATIONS.
const LOCATION_IDS = ["kush-house", "house-of-genetics"];

const webpush = require("web-push");

function genId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

function parseShiftStartMinutes(timeRange) {
  var m = /^\s*(\d{1,2}):(\d{2})/.exec(timeRange || "");
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function spainNow() {
  var parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(new Date());
  var map = {};
  parts.forEach(function (p) { map[p.type] = p.value; });
  return {
    dateIso: map.year + "-" + map.month + "-" + map.day,
    minutes: parseInt(map.hour, 10) * 60 + parseInt(map.minute, 10)
  };
}

function spainDateOf(isoString) {
  if (!isoString) return null;
  var d = new Date(isoString);
  if (isNaN(d.getTime())) return null;
  var parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(d);
  var map = {};
  parts.forEach(function (p) { map[p.type] = p.value; });
  return map.year + "-" + map.month + "-" + map.day;
}

async function supaGet(path) {
  const res = await fetch(process.env.SUPABASE_URL + path, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY
    }
  });
  if (!res.ok) throw new Error("Supabase GET failed: " + res.status + " " + path);
  return res.json();
}

async function supaInsert(collection, docId, data) {
  const res = await fetch(process.env.SUPABASE_URL + "/rest/v1/documents", {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({ collection: collection, doc_id: docId, data: data, updated_at: new Date().toISOString() })
  });
  if (!res.ok) throw new Error("Supabase insert failed: " + res.status);
}

module.exports = async function handler(req, res) {
  if (process.env.CRON_SECRET) {
    var auth = req.headers["authorization"] || "";
    if (auth !== "Bearer " + process.env.CRON_SECRET) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
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

  var now = spainNow();
  var report = [];

  for (const locationId of LOCATION_IDS) {
    try {
      const [schedule, timeEntries, subs] = await Promise.all([
        supaGet("/rest/v1/documents?collection=eq." + encodeURIComponent(locationId + "__schedule") + "&select=doc_id,data"),
        supaGet("/rest/v1/documents?collection=eq." + encodeURIComponent(locationId + "__timeEntries") + "&select=doc_id,data"),
        supaGet("/rest/v1/documents?collection=eq." + encodeURIComponent(locationId + "__pushSubscriptions") + "&select=doc_id,data")
      ]);

      const scheduleToday = schedule
        .map(function (r) { return r.data || {}; })
        .filter(function (s) { return s.date === now.dateIso && s.employee; });

      const clockedInToday = {};
      timeEntries.forEach(function (r) {
        var t = r.data || {};
        if (t.employee && spainDateOf(t.clockIn) === now.dateIso) clockedInToday[t.employee] = true;
      });

      const subsByEmployee = {};
      subs.forEach(function (r) {
        var s = r.data || {};
        if (!s.recipientName || !s.endpoint || !s.keys) return;
        if (!subsByEmployee[s.recipientName]) subsByEmployee[s.recipientName] = [];
        subsByEmployee[s.recipientName].push(s);
      });

      for (const entry of scheduleToday) {
        var startMinutes = parseShiftStartMinutes(entry.time);
        if (startMinutes == null) continue;
        var lateBy = now.minutes - startMinutes;
        if (lateBy < 5) continue;
        if (clockedInToday[entry.employee]) continue;

        var startLabel = (entry.time || "").split(/[–-]/)[0].trim();
        var logId = genId();
        try {
          await supaInsert(locationId + "__lateLog", logId, {
            employee: entry.employee,
            date: now.dateIso,
            shiftTime: startLabel,
            minutesLate: lateBy,
            timestamp: new Date().toISOString()
          });
        } catch (err) {
          report.push({ location: locationId, employee: entry.employee, ok: false, step: "log", error: String(err) });
          continue;
        }

        var mySubs = subsByEmployee[entry.employee] || [];
        var payload = JSON.stringify({
          title: "Running late",
          body: "You're " + lateBy + " min late for your " + startLabel + " shift, clock in when you can.",
          tag: "late-shift",
          url: "/"
        });
        var sent = 0;
        for (const sub of mySubs) {
          try {
            await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
            sent++;
          } catch (err) {
          }
        }
        report.push({ location: locationId, employee: entry.employee, lateBy: lateBy, devicesPushed: sent, loggedId: logId });
      }
    } catch (err) {
      report.push({ location: locationId, ok: false, error: String(err) });
    }
  }

  res.status(200).json({ checkedAtSpainTime: now, report: report });
};

