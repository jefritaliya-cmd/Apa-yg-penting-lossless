/*
 * BitChord module – Lossless Open Sources (v0.1.0)
 *
 * Lossless (FLAC/WAV/ALAC...) search + streaming from legitimate sources:
 *   1. Your own Subsonic-compatible server (Navidrome, Subsonic, Airsonic,
 *      Gonic, Jellyfin via plugin, ...)  -> needs subsonicUrl/User/Password
 *   2. Internet Archive (Live Music Archive, netlabels, open audio)
 *      -> no account needed
 *   3. Wikimedia Commons (freely licensed / public-domain audio)
 *      -> no account needed
 *
 * Settings (all optional; read from context.settings):
 *   subsonicUrl, subsonicUser, subsonicPassword
 *   subsonicLosslessOnly   ("true" default; "false" also returns lossy tracks)
 *   enableArchive          ("true" default)
 *   archiveCollections     (comma list, e.g. "etree,netlabels"; empty = all audio)
 *   enableCommons          ("true" default)
 *
 * Module contract (BitChord V1.5.2):
 *   module.exports.searchTracks(query, limit, context)       -> { tracks, total }
 *   module.exports.getTrackStreamUrl(id, quality, context)   -> { streamUrl, track }
 */
(function () {

  /* ── Settings helpers ──────────────────────────────────────────────── */

  // BitChord sends context.settings as { "key": { "value": "..." } };
  // accept the unwrapped shape too.
  function setting(context, key) {
    if (!context || !context.settings) return "";
    var entry = context.settings[key];
    if (entry == null) return "";
    if (typeof entry === "object" && entry.value != null) return String(entry.value);
    if (typeof entry === "string") return entry;
    if (typeof entry === "boolean" || typeof entry === "number") return String(entry);
    return "";
  }

  function flag(context, key, def) {
    var v = setting(context, key).trim();
    if (v === "") return def;
    return !/^(0|false|off|no)$/i.test(v);
  }

  /* ── HTTP helpers ──────────────────────────────────────────────────── */

  async function getJson(url) {
    var response = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!response.ok) throw new Error("HTTP " + response.status);
    var body;
    if (response.json) {
      body = response.json();
    } else {
      var t = response.text();
      if (t && typeof t.then === "function") t = await t;
      body = JSON.parse(t);
    }
    if (body && typeof body.then === "function") body = await body;
    return body;
  }

  function stripHtml(s) {
    return String(s || "").replace(/<[^>]*>/g, "").replace(/&amp;/g, "&")
      .replace(/&quot;/g, "\"").replace(/&#0?39;/g, "'").replace(/\s+/g, " ").trim();
  }

  function toSeconds(v) {
    if (v == null || v === "") return 0;
    var s = String(v);
    if (s.indexOf(":") >= 0) {
      var parts = s.split(":");
      var total = 0;
      for (var i = 0; i < parts.length; i++) total = total * 60 + (parseFloat(parts[i]) || 0);
      return Math.round(total);
    }
    return Math.round(parseFloat(s) || 0);
  }

  function emptyStream(id) {
    return { streamUrl: null, track: { id: String(id), audioQuality: "LOSSLESS" } };
  }

  /* ══════════════════════════════════════════════════════════════════════
   *  Source 1: Subsonic / Navidrome
   * ══════════════════════════════════════════════════════════════════════ */

  var LOSSLESS_EXT = { flac: 1, alac: 1, wav: 1, aiff: 1, aif: 1, ape: 1, wv: 1 };

  function hex(str) {
    var enc = encodeURIComponent(str);
    var out = "";
    for (var i = 0; i < enc.length; i++) {
      var ch = enc.charAt(i);
      if (ch === "%") {
        out += enc.substr(i + 1, 2).toLowerCase();
        i += 2;
      } else {
        var h = ch.charCodeAt(0).toString(16);
        out += (h.length < 2 ? "0" : "") + h;
      }
    }
    return out;
  }

  function subBase(context) {
    var u = setting(context, "subsonicUrl").trim().replace(/\/+$/, "");
    if (!u) return "";
    if (!/\/rest$/.test(u)) u += "/rest";
    return u;
  }

  function subConfigured(context) {
    return !!(subBase(context) && setting(context, "subsonicUser") &&
              setting(context, "subsonicPassword"));
  }

  // Legacy hex-encoded password auth (Subsonic API >= 1.13, supported by Navidrome).
  function subAuth(context) {
    return "u=" + encodeURIComponent(setting(context, "subsonicUser")) +
      "&p=enc:" + hex(setting(context, "subsonicPassword")) +
      "&v=1.16.1&c=bitchord";
  }

  async function searchSubsonic(query, limit, context) {
    var base = subBase(context);
    var auth = subAuth(context);
    var losslessOnly = flag(context, "subsonicLosslessOnly", true);
    var url = base + "/search3?" + auth + "&f=json&artistCount=0&albumCount=0" +
      "&songCount=" + (limit * 2) + "&query=" + encodeURIComponent(query);

    var root = await getJson(url);
    var res = root && root["subsonic-response"];
    if (!res || res.status !== "ok") return [];
    var songs = (res.searchResult3 && res.searchResult3.song) || [];

    var tracks = [];
    for (var i = 0; i < songs.length && tracks.length < limit; i++) {
      var s = songs[i];
      var ext = String(s.suffix || "").toLowerCase();
      if (losslessOnly && !LOSSLESS_EXT[ext]) continue;
      tracks.push({
        id: "sub:" + s.id,
        title: s.title || "Unknown",
        artist: s.artist || "Unknown Artist",
        album: s.album || "",
        albumCover: s.coverArt
          ? base + "/getCoverArt?" + auth + "&size=600&id=" + encodeURIComponent(s.coverArt)
          : null,
        duration: s.duration || 0,
        trackNumber: s.track || 0,
        audioQuality: LOSSLESS_EXT[ext] ? "LOSSLESS" : "HIGH",
        format: ext || "flac",
        availableQualities: ["LOSSLESS"]
      });
    }
    return tracks;
  }

  function streamSubsonic(rawId, context) {
    if (!subConfigured(context)) return null;
    // format=raw -> original file, no transcoding.
    return subBase(context) + "/stream?" + subAuth(context) +
      "&format=raw&id=" + encodeURIComponent(rawId);
  }

  /* ══════════════════════════════════════════════════════════════════════
   *  Source 2: Internet Archive
   * ══════════════════════════════════════════════════════════════════════ */

  function archiveDownloadUrl(identifier, filename) {
    return "https://archive.org/download/" + encodeURIComponent(identifier) + "/" +
      filename.split("/").map(encodeURIComponent).join("/");
  }

  function isFlacFile(f) {
    var fmt = String(f.format || "").toLowerCase();
    var name = String(f.name || "").toLowerCase();
    return fmt.indexOf("flac") >= 0 || /\.flac$/.test(name);
  }

  async function searchArchive(query, limit, context) {
    var clean = query.replace(/[\"():\[\]{}\^~*?\\\/!&|+\-]/g, " ").replace(/\s+/g, " ").trim();
    if (!clean) return [];

    var q = "(" + clean + ") AND mediatype:audio";
    var cols = setting(context, "archiveCollections").split(",")
      .map(function (c) { return c.trim(); }).filter(Boolean);
    if (cols.length) {
      q += " AND (" + cols.map(function (c) { return "collection:" + c; }).join(" OR ") + ")";
    }

    var url = "https://archive.org/advancedsearch.php?q=" + encodeURIComponent(q) +
      "&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=creator" +
      "&sort%5B%5D=downloads+desc&rows=4&page=1&output=json";

    var root = await getJson(url);
    var docs = (root && root.response && root.response.docs) || [];

    var metas = await Promise.all(docs.map(function (d) {
      return getJson("https://archive.org/metadata/" + encodeURIComponent(d.identifier))
        .catch(function () { return null; });
    }));

    var tracks = [];
    for (var i = 0; i < metas.length; i++) {
      var m = metas[i];
      if (!m || !m.files || m.is_dark) continue;
      var md = m.metadata || {};
      var identifier = docs[i].identifier;
      var albumTitle = stripHtml(Array.isArray(md.title) ? md.title[0] : md.title);
      var itemArtist = stripHtml(Array.isArray(md.creator) ? md.creator.join(", ") : md.creator);
      var cover = "https://archive.org/services/img/" + encodeURIComponent(identifier);

      var n = 0;
      for (var j = 0; j < m.files.length; j++) {
        var f = m.files[j];
        if (!isFlacFile(f)) continue;
        n++;
        var fallbackTitle = String(f.name).replace(/^.*\//, "").replace(/\.flac$/i, "");
        tracks.push({
          id: "ia:" + identifier + "/" + f.name,
          title: stripHtml(f.title) || fallbackTitle,
          artist: stripHtml(f.creator) || itemArtist || "Unknown Artist",
          album: stripHtml(f.album) || albumTitle,
          albumCover: cover,
          duration: toSeconds(f.length),
          trackNumber: parseInt(f.track, 10) || n,
          audioQuality: "LOSSLESS",
          format: "flac",
          availableQualities: ["LOSSLESS"]
        });
      }
    }
    return tracks.slice(0, limit);
  }

  function streamArchive(rawId) {
    var slash = rawId.indexOf("/");
    if (slash <= 0) return null;
    return archiveDownloadUrl(rawId.substring(0, slash), rawId.substring(slash + 1));
  }

  /* ══════════════════════════════════════════════════════════════════════
   *  Source 3: Wikimedia Commons
   * ══════════════════════════════════════════════════════════════════════ */

  var COMMONS_LOSSLESS_MIME = {
    "audio/flac": 1, "audio/x-flac": 1,
    "audio/wav": 1, "audio/x-wav": 1, "audio/wave": 1
  };

  async function searchCommons(query, limit, context) {
    var url = "https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*" +
      "&generator=search&gsrnamespace=6&gsrlimit=" + Math.min(limit * 2, 50) +
      "&gsrsearch=" + encodeURIComponent("filetype:audio " + query) +
      "&prop=imageinfo&iiprop=" + encodeURIComponent("url|mime|extmetadata") +
      "&iiextmetadatafilter=" + encodeURIComponent("Artist|ObjectName");

    var root = await getJson(url);
    var pages = (root && root.query && root.query.pages) || {};
    var keys = Object.keys(pages);

    var items = keys.map(function (k) { return pages[k]; })
      .sort(function (a, b) { return (a.index || 0) - (b.index || 0); });

    var tracks = [];
    for (var i = 0; i < items.length && tracks.length < limit; i++) {
      var p = items[i];
      var info = p.imageinfo && p.imageinfo[0];
      if (!info || !COMMONS_LOSSLESS_MIME[String(info.mime).toLowerCase()]) continue;
      var ext = (info.url.match(/\.([a-z0-9]+)$/i) || [])[1] || "flac";
      var meta = info.extmetadata || {};
      var title = stripHtml(meta.ObjectName && meta.ObjectName.value) ||
        String(p.title || "").replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, "").replace(/_/g, " ");
      tracks.push({
        id: "wm:" + info.url,
        title: title || "Unknown",
        artist: stripHtml(meta.Artist && meta.Artist.value) || "Wikimedia Commons",
        album: "Wikimedia Commons",
        albumCover: null,
        duration: 0,
        trackNumber: 0,
        audioQuality: "LOSSLESS",
        format: ext.toLowerCase(),
        availableQualities: ["LOSSLESS"]
      });
    }
    return tracks;
  }

  function streamCommons(rawId) {
    // Only hand back URLs that really point at Wikimedia's upload host.
    return /^https:\/\/upload\.wikimedia\.org\//.test(rawId) ? rawId : null;
  }

  /* ── Public API ────────────────────────────────────────────────────── */

  function interleave(lists) {
    var out = [];
    var max = 0;
    lists.forEach(function (l) { if (l.length > max) max = l.length; });
    for (var i = 0; i < max; i++) {
      for (var j = 0; j < lists.length; j++) {
        if (i < lists[j].length) out.push(lists[j][i]);
      }
    }
    return out;
  }

  module.exports.searchTracks = async function (query, limit, context) {
    query = String(query || "").trim();
    limit = limit || 25;
    if (!query) return { tracks: [], total: 0 };

    var jobs = [];
    if (subConfigured(context)) {
      jobs.push(searchSubsonic(query, limit, context).catch(function () { return []; }));
    }
    if (flag(context, "enableArchive", true)) {
      jobs.push(searchArchive(query, limit, context).catch(function () { return []; }));
    }
    if (flag(context, "enableCommons", true)) {
      jobs.push(searchCommons(query, limit, context).catch(function () { return []; }));
    }

    var lists = await Promise.all(jobs);
    var tracks = interleave(lists).slice(0, limit);
    return { tracks: tracks, total: tracks.length };
  };

  module.exports.getTrackStreamUrl = async function (id, quality, context) {
    id = String(id);
    var url = null;
    var mime = "audio/flac";

    if (id.indexOf("sub:") === 0) {
      url = streamSubsonic(id.substring(4), context);
      mime = null; // original file type; let the player sniff it
    } else if (id.indexOf("ia:") === 0) {
      url = streamArchive(id.substring(3));
    } else if (id.indexOf("wm:") === 0) {
      url = streamCommons(id.substring(3));
      if (/\.wav$/i.test(id)) mime = "audio/wav";
    }

    if (!url) return emptyStream(id);

    return {
      streamUrl: url,
      track: {
        id: id,
        audioQuality: "LOSSLESS",
        mimeType: mime,
        bitDepth: null,
        sampleRate: null,
        bitrate: null
      }
    };
  };

}());
