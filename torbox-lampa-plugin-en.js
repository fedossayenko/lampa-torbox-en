/* TorBox Lampa Plugin — Reliability Refactor
 * ---------------------------------------------------------------------
 * Goals met:
 *  - Robust magnet/BTIH parsing (hex & RFC4648 base32 → lower-case hex)
 *  - Full network hardening (proxy required, API key scoped only to TorBox,
 *    timeouts, abort propagation, retries, actionable Noty errors)
 *  - LRU cache with TTL (no cross-title bleed, stale eviction)
 *  - Filters/sort persistence, deduped lists, stable sort, cached-only toggle
 *  - Episodes: mkv/mp4/avi filter, natural sort, watched persist, continue panel
 *  - Safe storage parsing, JSON fallbacks, idempotent style injection
 *  - UX/Sec: API key masked; Authorization never forwarded to proxy; validations
 *  - Performance: minimal DOM thrash; style injected once; result caps & dedup
 *  - Compatibility: public surface (component id, templates, settings keys)
 * --------------------------------------------------------------------- */

try {
  console.log('[TorBox] boot strap', '51.2.14');
  (function () {
  'use strict';

  // ───────────────────────────── Guard (idempotent load) ─────────────────────────────
  const PLUGIN_FLAG = 'torbox_lampa_plugin_integrated_v2';
  if (window[PLUGIN_FLAG]) return;
  window[PLUGIN_FLAG] = true;

  // ───────────────────────────── Constants / Config ─────────────────────────────
  const VERSION = '51.2.14-en';

  const CONST = {
    CACHE_LIMIT: 128,
    CACHE_TTL_MS: 10 * 60 * 1000, // 10 minutes
    TORBOX_API_TIMEOUT_MS: 20 * 1000, // 20 seconds
    PUBLIC_PARSER_TIMEOUT_MS: 5 * 1000, // 5 seconds
    PARSER_COOLDOWN_MS: 15 * 60 * 1000, // 15 minutes
    TRACKING_POLL_INTERVAL_MS: 10 * 1000, // 10 seconds
    MAX_DRAW_ITEMS: 300, // Guard against very large result sets
    RAW_CACHE_HASH_LIMIT: 64,
    MAX_WATCHED_EPISODES: 250,
    MAX_SNAPSHOT_BYTES: 4096,
    TRACK_RETRIES_MIN: 3,
    TRACK_RETRIES_MAX: 120,
    TRACK_INTERVAL_MIN_MS: 3000,
    TRACK_INTERVAL_MAX_MS: 60000,
  };

  const DEFAULT_VIDEO_EXTENSIONS = 'mkv,mp4,avi,ts,m4v,webm';

  const PUBLIC_PARSERS = [
    // These are TorBox-compatible tracker indexer gateways frequently used by Lampa plugins.
    // If one is down, the next will be tried.
    { name: 'MaxVol', url: 'jr.maxvol.pro', key: '' },
    { name: 'Jacred', url: 'jacred.xyz', key: '' },
  ];

  const ICON =
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" ' +
    'xmlns="http://www.w3.org/2000/svg"><path d="M3 7L12 2L21 7V17L12 22L3 17V7Z" stroke="currentColor" stroke-width="2"/>' +
    '<path d="M12 22V12" stroke="currentColor" stroke-width="2"/>' +
    '<path d="M21 7L12 12L3 7" stroke="currentColor" stroke-width="2"/></svg>';

  // ───────────────────────────── Safe Storage wrapper ─────────────────────────────
  const safeStorage = (() => {
    try {
      localStorage.setItem('__torbox_test__', '1');
      localStorage.removeItem('__torbox_test__');
      return localStorage;
    } catch (_) {
      const mem = {};
      return {
        getItem: (k) => (k in mem ? mem[k] : null),
        setItem: (k, v) => (mem[k] = String(v)),
        removeItem: (k) => delete mem[k],
        clear: () => Object.keys(mem).forEach((k) => delete mem[k]),
      };
    }
  })();

  const Store = {
    get(key, def = null) {
      try {
        const v = safeStorage.getItem(key);
        return v !== null ? v : def;
      } catch {
        return def;
      }
    },
    set(key, val) {
      try {
        safeStorage.setItem(key, String(val));
      } catch {
        /* ignore storage errors (private mode, etc.) */
      }
    },
  };

  const DebugTelemetry = {
    logs: [],
    lastError: null,
    parserAttempts: [],
    selectedParser: null,
  };

  const pushDebugLog = (level, args) => {
    try {
      const msg = args
        .map((a) => {
          if (typeof a === 'string') return a;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(' ');
      DebugTelemetry.logs.push({
        ts: new Date().toISOString(),
        level,
        msg,
      });
      if (DebugTelemetry.logs.length > 50) {
        DebugTelemetry.logs = DebugTelemetry.logs.slice(-50);
      }
    } catch {
      /* ignore telemetry errors */
    }
  };

  const parseBoolean = (value, fallback = false) => {
    if (value === true || value === false) return value;
    const normalized = String(value ?? '').trim().toLowerCase();
    if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
    if (['0', 'false', 'off', 'no'].includes(normalized)) return false;
    return fallback;
  };

  // User-entered connection values (stored below) always take precedence.
  const DEFAULT_PROXY_URL = 'https://my-torbox-proxy.slonce70.workers.dev';

  const Config = {
    get debug() {
      return Store.get('torbox_debug', '0') === '1';
    },
    set debug(v) {
      if (typeof v === 'string') {
        const normalized = v.trim().toLowerCase();
        if (['0', 'false', 'off', 'no'].includes(normalized)) v = false;
        else if (['1', 'true', 'on', 'yes'].includes(normalized)) v = true;
      }
      Store.set('torbox_debug', v ? '1' : '0');
    },
    get proxyUrl() {
      return Store.get('torbox_proxy_url', '') || DEFAULT_PROXY_URL;
    },
    set proxyUrl(v) {
      const normalized = String(v || '')
        .replace(/[\r\n]+/g, '')
        .trim();
      Store.set('torbox_proxy_url', normalized);
    },
    get apiKey() {
      // Masked at rest via base64 to avoid casual shoulder‑surfing in devtools.
      const b64 = Store.get('torbox_api_key_b64', '');
      if (!b64) return '';
      try {
        return atob(b64);
      } catch {
        Store.set('torbox_api_key_b64', '');
        return '';
      }
    },
    set apiKey(v) {
      const normalized = String(v || '')
        .replace(/[\r\n]+/g, '')
        .trim();
      Store.set('torbox_api_key_b64', normalized ? btoa(normalized) : '');
    },
  };
  const LOG = (...args) => {
    pushDebugLog('log', args);
    if (Config.debug) console.log('[TorBox]', ...args);
  };

  const translate = (key) => {
    try {
      if (window.Lampa && Lampa.Lang && typeof Lampa.Lang.translate === 'function') {
        const value = Lampa.Lang.translate(key);
        if (value !== undefined) return value;
      }
    } catch (err) {
      LOG('Translate error', err);
    }
    return key;
  };

  const translateWithParams = (key, params = {}) => {
    const base = translate(key) || '';
    return base.replace(/\{(\w+)\}/g, (match, p1) => (p1 in params ? params[p1] : match));
  };

  // ───────────────────────────── Utilities ─────────────────────────────
  const Utils = {
    escapeHtml(str = '') {
      const div = document.createElement('div');
      div.textContent = String(str);
      return div.innerHTML;
    },
    formatBytes(bytes = 0, speed = false) {
      const B = Number(bytes) || 0;
      const k = 1024;
      const units = speed
        ? ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s']
        : ['B', 'KB', 'MB', 'GB', 'TB'];
      if (B <= 0) return speed ? '0 KB/s' : '0 B';
      const i = Math.min(Math.floor(Math.log(B) / Math.log(k)), units.length - 1);
      return (B / Math.pow(k, i)).toFixed(2) + ' ' + units[i];
    },
    formatTime(sec = 0) {
      const s = Math.max(0, Math.floor(Number(sec) || 0));
      if (!isFinite(s) || s > 30 * 24 * 3600) return translate('torbox_time_infinite');
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const r = s % 60;
      const parts = [];
      if (h) parts.push(translateWithParams('torbox_time_hours_short', { value: h }));
      if (m) parts.push(translateWithParams('torbox_time_minutes_short', { value: m }));
      parts.push(translateWithParams('torbox_time_seconds_short', { value: r }));
      return parts.filter(Boolean).join(' ');
    },
    formatAge(iso) {
      if (!iso) return translate('torbox_not_available');
      const d = new Date(iso);
      if (isNaN(d)) return translate('torbox_not_available');
      const diff = Math.floor((Date.now() - d.getTime()) / 1000);
      const m = Math.floor(diff / 60);
      const h = Math.floor(m / 60);
      const days = Math.floor(h / 24);
      if (diff < 60) return translateWithParams('torbox_age_seconds', { value: diff });
      if (m < 60) return translateWithParams('torbox_age_minutes', { value: m });
      if (h < 24) return translateWithParams('torbox_age_hours', { value: h });
      return translateWithParams('torbox_age_days', { value: days });
    },
    getQualityLabel(title = '', raw) {
      if (raw?.info?.quality) {
        const normalized = String(raw.info.quality)
          .replace(/[^0-9a-z.+-]/gi, '')
          .toUpperCase();
        if (normalized) {
          if (normalized === 'UHD' || normalized === '4K') return '4K';
          const px = /^(\d{3,4})P?$/.test(normalized) ? parseInt(normalized, 10) : 0;
          if (px) return px >= 2160 ? '4K' : px >= 1080 ? 'FHD' : px >= 720 ? 'HD' : 'SD';
          if (['FHD', 'HD', 'SD'].includes(normalized)) return normalized;
        }
      }
      if (/2160p|4k|uhd/i.test(title)) return '4K';
      if (/1080p|fhd/i.test(title)) return 'FHD';
      if (/720p|hd/i.test(title)) return 'HD';
      return 'SD';
    },
    naturalEpisodeSort(a, b) {
      // Stable, natural sort by file name with numeric segments and then by original index
      const chunk = /(\d+)/g;
      const aa = a.name.split(chunk);
      const bb = b.name.split(chunk);
      for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
        if (i % 2) {
          const d = Number(aa[i]) - Number(bb[i]);
          if (d) return d;
        } else {
          const d = aa[i].localeCompare(bb[i]);
          if (d) return d;
        }
      }
      // Tie-breaker by original index for stable sort
      return (a.__idx ?? 0) - (b.__idx ?? 0);
    },
    clamp(v, min, max) {
      return Math.max(min, Math.min(max, v));
    },
    normalizeProgress(p) {
      const n = Number(p);
      if (!isFinite(n) || n < 0) return 0;
      if (n <= 1) return Utils.clamp(n * 100, 0, 100);
      return Utils.clamp(n, 0, 100);
    },
    // Classify a TorBox torrent record into a UI phase:
    //  - 'ready'       : finished AND has files -> can start playback
    //  - 'finalizing'  : downloaded but not yet playable (TorBox is caching/
    //                    preparing files) -> show a "preparing" message, NOT a
    //                    stale download ETA/speed
    //  - 'downloading' : still downloading -> show progress + ETA
    downloadPhase(d) {
      if (!d || typeof d !== 'object') return 'downloading';
      const finished =
        d.download_state === 'completed' ||
        d.download_state === 'uploading' ||
        !!d.download_finished;
      const hasFiles = Array.isArray(d.files) && d.files.length > 0;
      if (finished && hasFiles) return 'ready';
      const downloadDone =
        finished || Utils.normalizeProgress(d.progress) >= 100 || d.download_state === 'cached';
      return downloadDone ? 'finalizing' : 'downloading';
    },
    sanitizeTokenList(value, { uppercase = false } = {}) {
      const items = String(Array.isArray(value) ? value.join(',') : value || '')
        .split(',')
        .map((item) => String(item || '').replace(/[\r\n]+/g, '').trim())
        .filter(Boolean)
        .map((item) => (uppercase ? item.toUpperCase() : item));
      return Array.from(new Set(items));
    },
    safeClassSelector(str = '') {
      return String(str || '')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 4)
        .map((part) => part.replace(/[^\w-]/g, ''))
        .filter(Boolean)
        .map((part) => `.${part}`)
        .join('');
    },

    // ─── BTIH helpers ─────────────────────────────────────────────────
    isHex40(s) {
      return typeof s === 'string' && /^[a-fA-F0-9]{40}$/.test(s);
    },
    isBase32Btih(s) {
      return typeof s === 'string' && /^[A-Z2-7]{32}$/.test(s);
    },
    base32ToHex(b32) {
      // RFC 4648 base32 (uppercase, no padding)
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      let bits = '';
      for (const c of b32) {
        const val = alphabet.indexOf(c);
        if (val < 0) throw new Error('Invalid base32 char');
        bits += val.toString(2).padStart(5, '0');
      }
      const out = [];
      for (let i = 0; i + 4 <= bits.length; i += 4) {
        out.push(parseInt(bits.slice(i, i + 4), 2).toString(16));
      }
      const hex = out.join('').toLowerCase();
      // BTIH is exactly 20 bytes = 40 hex chars
      return hex.length >= 40 ? hex.slice(0, 40) : hex.padEnd(40, '0');
    },
    btihFromMagnetOrFields(obj) {
      // Try fields first (case-insensitive variants)
      const direct =
        obj.InfoHash ||
        obj.infoHash ||
        obj.Hash ||
        obj.hash ||
        null;

      const tryNormalize = (raw) => {
        if (!raw) return null;
        const s = String(raw).trim();
        if (Utils.isHex40(s)) return s.toLowerCase();
        const upper = s.toUpperCase();
        if (Utils.isBase32Btih(upper)) return Utils.base32ToHex(upper);
        return null;
      };

      let normalized = tryNormalize(direct);
      if (normalized) return normalized;

      // Magnet parsing:
      const magnet = obj.MagnetUri || obj.magnet || obj.magnetUri || '';
      if (!magnet || typeof magnet !== 'string') return null;

      // Extract xt=urn:btih:VALUE (VALUE may be hex or base32).
      // Hybrid/v2 magnets carry multiple xt params (urn:btih + urn:btmh) in any
      // order, so pick the btih-bearing one explicitly instead of trusting position.
      const q = magnet.split('?')[1] || '';
      const params = new URLSearchParams(q);
      const xt = (params.getAll('xt') || []).find((v) => /^urn:btih:/i.test(v)) || '';
      const raw = xt.replace(/^urn:btih:/i, '');
      // URLSearchParams already decodes once; a second decode of a malformed
      // sequence (e.g. a stray %) throws URIError and would discard the whole
      // parser response, so fall back to the undecoded value.
      let val;
      try {
        val = decodeURIComponent(raw);
      } catch {
        val = raw;
      }

      normalized = tryNormalize(val);
      return normalized;
    },
  };

  const sanitizeExtensions = (value) => {
    const parts = String(Array.isArray(value) ? value.join(',') : value || '')
      .split(/[,\s]+/)
      .map((ext) => ext.replace(/[^a-z0-9]/gi, '').toLowerCase())
      .filter(Boolean);
    const unique = Array.from(new Set(parts));
    return unique.length ? unique : DEFAULT_VIDEO_EXTENSIONS.split(',');
  };

  const setVideoExtensions = (value) => {
    const sanitized = sanitizeExtensions(value);
    const serialized = sanitized.join(',');
    if (Store.get('torbox_video_extensions', '') !== serialized) {
      Store.set('torbox_video_extensions', serialized);
    }
    return sanitized;
  };

  const getVideoExtensions = () => setVideoExtensions(Store.get('torbox_video_extensions', DEFAULT_VIDEO_EXTENSIONS));

  const normalizeTrackRetries = (value) => {
    const num = Math.round(Number(value));
    return Utils.clamp(Number.isFinite(num) ? num : 24, CONST.TRACK_RETRIES_MIN, CONST.TRACK_RETRIES_MAX);
  };

  const setTrackRetries = (value) => {
    const safe = normalizeTrackRetries(value);
    Store.set('torbox_track_retries', String(safe));
    return safe;
  };

  const getTrackRetries = () => setTrackRetries(Store.get('torbox_track_retries', '24'));

  const normalizeTrackInterval = (value) => {
    const num = Math.round(Number(value));
    return Utils.clamp(
      Number.isFinite(num) ? num : CONST.TRACKING_POLL_INTERVAL_MS,
      CONST.TRACK_INTERVAL_MIN_MS,
      CONST.TRACK_INTERVAL_MAX_MS
    );
  };

  const setTrackIntervalMs = (value) => {
    const safe = normalizeTrackInterval(value);
    Store.set('torbox_track_interval_ms', String(safe));
    return safe;
  };

  const getTrackIntervalMs = () => setTrackIntervalMs(Store.get('torbox_track_interval_ms', CONST.TRACKING_POLL_INTERVAL_MS));

  const setStoredBool = (key, value) => {
    const bool = parseBoolean(value, false);
    Store.set(key, bool ? '1' : '0');
    return bool;
  };
  const getStoredBool = (key, fallback = false) => parseBoolean(Store.get(key, fallback ? '1' : '0'), fallback);

  const setDefaultCachedOnly = (value) => setStoredBool('torbox_default_cached_only', value);
  const getDefaultCachedOnly = () => getStoredBool('torbox_default_cached_only', false);

  const setPreferPermanentLink = (value) => setStoredBool('torbox_requestdl_permanent', value);
  const getPreferPermanentLink = () => getStoredBool('torbox_requestdl_permanent', false);

  const ParserHealth = (() => {
    const STORAGE_KEY = 'torbox_parser_health_v1';
    let cache = null;

    const load = () => {
      if (cache) return cache;
      try {
        const parsed = JSON.parse(Store.get(STORAGE_KEY, '{}'));
        cache = parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        cache = {};
      }
      return cache;
    };

    const save = () => {
      try {
        Store.set(STORAGE_KEY, JSON.stringify(load()));
      } catch {
        /* ignore storage errors */
      }
    };

    const normalizeDomain = (domain) => String(domain || '').trim().toLowerCase();

    const getEntry = (domain) => {
      const key = normalizeDomain(domain);
      if (!key) return {};
      const entry = load()[key];
      return entry && typeof entry === 'object' ? entry : {};
    };

    const updateEntry = (domain, patch) => {
      const key = normalizeDomain(domain);
      if (!key) return {};
      const next = Object.assign({}, getEntry(key), patch || {});
      load()[key] = next;
      save();
      return next;
    };

    const getCooldownUntil = (domain) => {
      const raw = Number(getEntry(domain).cooldownUntil) || 0;
      if (raw > Date.now()) return raw;
      if (raw) updateEntry(domain, { cooldownUntil: 0 });
      return 0;
    };

    return {
      getCooldownUntil,
      isCoolingDown(domain) {
        return getCooldownUntil(domain) > Date.now();
      },
      markFailure(domain, kind) {
        const now = Date.now();
        return updateEntry(domain, {
          lastFailureAt: now,
          lastFailureKind: String(kind || 'failure'),
          cooldownUntil: now + CONST.PARSER_COOLDOWN_MS,
        });
      },
      markSuccess(domain) {
        return updateEntry(domain, {
          lastSuccessAt: Date.now(),
          cooldownUntil: 0,
        });
      },
    };
  })();

  const setDebugOverlayEnabled = (value) => setStoredBool('torbox_debug_overlay', value);
  const getDebugOverlayEnabled = () => getStoredBool('torbox_debug_overlay', false);

  const setAutoPickMovieFile = (value) => setStoredBool('torbox_auto_pick_movie_file', value);
  const getAutoPickMovieFile = () => getStoredBool('torbox_auto_pick_movie_file', true);

  const normalizeQualityOrder = (value) => {
    const allowed = ['4K', 'FHD', 'HD', 'SD'];
    const items = Utils.sanitizeTokenList(value, { uppercase: true }).filter((item) => allowed.includes(item));
    return items.length ? items : allowed;
  };
  const setQualityOrder = (value) => {
    const order = normalizeQualityOrder(value);
    Store.set('torbox_pref_quality_order', order.join(','));
    return order;
  };
  const getQualityOrder = () => setQualityOrder(Store.get('torbox_pref_quality_order', '4K,FHD,HD,SD'));

  const setPreferredAudioLangs = (value) => {
    const langs = Utils.sanitizeTokenList(value, { uppercase: true });
    Store.set('torbox_pref_audio_langs', langs.join(','));
    return langs;
  };
  const getPreferredAudioLangs = () => setPreferredAudioLangs(Store.get('torbox_pref_audio_langs', ''));

  const setPreferredVideoCodecs = (value) => {
    const codecs = Utils.sanitizeTokenList(value, { uppercase: true });
    Store.set('torbox_pref_video_codecs', codecs.join(','));
    return codecs;
  };
  const getPreferredVideoCodecs = () => setPreferredVideoCodecs(Store.get('torbox_pref_video_codecs', ''));

  const setExcludedTrackers = (value) => {
    const trackers = Utils.sanitizeTokenList(value, { uppercase: false });
    Store.set('torbox_excluded_trackers', trackers.join(','));
    return trackers;
  };
  const getExcludedTrackers = () => setExcludedTrackers(Store.get('torbox_excluded_trackers', ''));

  const isCachedFlagTrue = (flag) => {
    if (flag === true || flag === 'true') return true;
    if (flag === false || flag === 'false') return false;
    if (typeof flag === 'number') return flag > 0;
    if (typeof flag === 'string') {
      const norm = flag.toLowerCase();
      if (['1', 'true', 'cached', 'ready', 'available', 'complete', 'completed'].includes(norm)) return true;
      if (['0', 'false', 'missing', 'not_cached'].includes(norm)) return false;
    }
    if (flag && typeof flag === 'object') {
      if ('cached' in flag) return isCachedFlagTrue(flag.cached);
      if ('ready' in flag) return isCachedFlagTrue(flag.ready);
      if ('status' in flag) return isCachedFlagTrue(flag.status);
      if ('available' in flag) return isCachedFlagTrue(flag.available);
      return Object.values(flag).some(isCachedFlagTrue);
    }
    return false;
  };

  // ───────────────────────────── In-memory LRU cache with TTL ─────────────────────────────
  const Cache = (() => {
    const map = new Map(); // k -> {ts, val}
    return {
      get(k) {
        if (!map.has(k)) return null;
        const entry = map.get(k);
        if (Date.now() - entry.ts > CONST.CACHE_TTL_MS) {
          map.delete(k);
          return null;
        }
        // LRU promote
        map.delete(k);
        map.set(k, entry);
        return entry.val;
      },
      set(k, v) {
        if (map.has(k)) map.delete(k);
        map.set(k, { ts: Date.now(), val: v });
        // Evict oldest
        if (map.size > CONST.CACHE_LIMIT) {
          const oldestKey = map.keys().next().value;
          map.delete(oldestKey);
        }
      },
      clear() {
        map.clear();
      },
    };
  })();

  // ───────────────────────────── Networking (via CORS proxy only) ─────────────────────────────
  const Api = (() => {
    const TB_MAIN = 'https://api.torbox.app/v1/api';

    function requireProxy() {
      if (!Config.proxyUrl || !String(Config.proxyUrl).trim()) {
        const err = { type: 'validation', message: translate('torbox_error_cors_missing') };
        throw err;
      }
    }

    function requireApiKey() {
      if (!Config.apiKey) {
        const err = { type: 'validation', message: translate('torbox_error_api_key_missing') };
        throw err;
      }
    }

    function parseJsonSafe(text) {
      try {
        return typeof text === 'string' ? JSON.parse(text) : text;
      } catch {
        return null;
      }
    }

    function extractApiDetail(json, text) {
      const direct =
        json?.detail ||
        json?.message ||
        json?.error ||
        json?.data?.detail ||
        json?.data?.message ||
        '';
      const normalized = String(direct || '').replace(/\s+/g, ' ').trim();
      if (normalized) return Utils.escapeHtml(normalized);

      const plain = String(text || '').trim();
      if (plain && plain.length <= 180 && !/^</.test(plain)) return Utils.escapeHtml(plain);
      return '';
    }

    function buildProxyUrl(base, target) {
      const raw = String(base || '').trim();
      if (!raw) return raw;

      try {
        const proxyUrl = new URL(raw);
        proxyUrl.searchParams.set('url', target);
        return proxyUrl.toString();
      } catch (_) {
        if (raw.includes('{url}')) {
          return raw.replace('{url}', encodeURIComponent(target));
        }
        if (raw.includes('%s')) {
          return raw.replace('%s', encodeURIComponent(target));
        }

        const hasQuery = raw.includes('?');
        const endsWithJoin = /[?&]$/.test(raw);
        if (/[?&]url=/.test(raw)) {
          return raw.replace(/([?&]url=)[^&#]*/i, (_, prefix) => `${prefix}${encodeURIComponent(target)}`);
        }
        const joiner = hasQuery ? (endsWithJoin ? '' : '&') : '?';
        return `${raw}${joiner}url=${encodeURIComponent(target)}`;
      }
    }

    async function request(url, opt = {}, outerSignal) {
      requireProxy();

      const { timeoutMs: optTimeoutMs, is_torbox_api: isTorBoxApiFlag, ...fetchOptions } = opt;
      const isTorBox = isTorBoxApiFlag !== false; // default true (only TorBox gets X-Api-Key)
      if (isTorBox) requireApiKey();

      const controller = new AbortController();
      const timeoutMs = Math.max(1, Number(optTimeoutMs) || CONST.TORBOX_API_TIMEOUT_MS);
      const t = setTimeout(() => controller.abort(), timeoutMs);
      const onOuterAbort = () => controller.abort();
      if (outerSignal) outerSignal.addEventListener('abort', onOuterAbort, { once: true });

      const headers = Object.assign({}, fetchOptions.headers || {});
      delete headers.Authorization; // never forward auth headers through proxy
      if (isTorBox) headers['X-Api-Key'] = Config.apiKey;

      // Always go through CORS proxy
      const proxied = buildProxyUrl(Config.proxyUrl, url);

      try {
        const res = await fetch(proxied, { ...fetchOptions, headers, signal: controller.signal });
        const status = res.status;
        const text = await res.text();
        const json = parseJsonSafe(text);
        const detail = extractApiDetail(json, text);
        const withDetail = (base) => (detail ? `${base}: ${detail}` : base);

        // Common error mapping
        if (status === 401) throw { type: 'auth', status, message: withDetail(translate('torbox_error_401')) };
        if (status === 403) throw { type: 'auth', status, message: withDetail(translate('torbox_error_403')) };
        if (status === 404) throw { type: 'api', status, message: withDetail(translate('torbox_error_404')) };
        if (status === 429) throw { type: 'network', status, message: withDetail(translate('torbox_error_429')) };
        if (status >= 500) throw { type: 'network', status, message: withDetail(translateWithParams('torbox_error_server', { status })) };
        if (status >= 400) throw { type: 'network', status, message: withDetail(translateWithParams('torbox_error_request', { status })) };

        // Direct URL (some TorBox endpoints may return a plain link)
        if (text.startsWith('http')) return { success: true, url: text };

        if (!json) throw { type: 'api', message: translate('torbox_error_bad_json') };

        if (json.success === false) {
          // Escape the server/proxy-supplied detail like every other error path
          // (extractApiDetail) — it ends up rendered by Lampa.Noty.
          const apiDetail = Utils.escapeHtml(String(json.detail || json.message || ''));
          throw { type: 'api', message: apiDetail || translate('torbox_error_api') };
        }
        return json;
      } catch (e) {
        if (e.name === 'AbortError') {
          // Distinguish timeout vs. external abort
          if (!outerSignal || !outerSignal.aborted) {
            throw {
              type: 'network',
              message: translateWithParams('torbox_error_timeout', {
                seconds: timeoutMs / 1000,
              }),
              timeoutMs,
            };
          }
          throw e; // external abort
        }
        if (e.type) throw e;
        throw { type: 'network', message: e && e.message ? e.message : translate('torbox_error_network') };
      } finally {
        clearTimeout(t);
        if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
      }
    }

    function normalizeParserResults(rawResults = []) {
      const items = Array.isArray(rawResults) ? rawResults : [];
      const entriesByHash = new Map();
      let invalidCount = 0;

      items.forEach((item) => {
        const hash = Utils.btihFromMagnetOrFields(item);
        if (!hash) {
          invalidCount += 1;
          return;
        }
        if (!entriesByHash.has(hash)) entriesByHash.set(hash, item);
      });

      return {
        rawCount: items.length,
        validCount: entriesByHash.size,
        invalidCount,
        entriesByHash,
      };
    }

    function classifyParserFailure(err = {}) {
      const statusCode = Number(err?.status) || 0;
      const message = String(err?.message || '');
      const lower = message.toLowerCase();

      if (Number(err?.timeoutMs) > 0 || /timeout|timed out|time out/i.test(message)) {
        return { status: 'timeout', cooldown: true, reason: message || 'timeout', statusCode };
      }
      if (statusCode >= 500) {
        return { status: 'http_error', cooldown: true, reason: `http_${statusCode}`, statusCode };
      }
      if (statusCode >= 400) {
        return { status: 'http_error', cooldown: false, reason: `http_${statusCode}`, statusCode };
      }
      if (
        /err_connection_closed|ssl|tls|handshake|fetch failed|network|econnreset|connection closed|connection reset/.test(lower)
      ) {
        return { status: 'network', cooldown: true, reason: message || 'network', statusCode };
      }
      return { status: 'network', cooldown: true, reason: message || 'network', statusCode };
    }

    async function searchPublicTrackers(movie, signal) {
      // Try parsers sequentially until we get valid results (Failover strategy).
      // TMDB TV cards carry the title in .name/.original_name and the date in
      // .first_air_date, not .title/.year — mirror generateSearchCombinations so
      // series searches are not degraded to a year-only/empty query.
      const searchTitle = (movie.title || movie.name || '').trim();
      const searchOriginal = (movie.original_title || movie.original_name || '').trim();
      const yearRaw = (movie.year || movie.release_date || movie.first_air_date || '').toString();
      const searchYear = yearRaw ? yearRaw.slice(0, 4) : '';
      const queryBase = `${searchTitle} ${searchYear}`.trim();
      const qsCommon = {
        Query: queryBase,
        title: searchTitle,
        title_original: searchOriginal,
        Category: '2000,5000', // Movies + TV
      };

      // Merge custom parsers
      const customStr = Store.get('torbox_custom_parsers', '').trim();
      const customParsers = customStr
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s && s.length > 3)
        .map((entry, i) => {
          // Normalize through URL() so a pasted full URL (path/query/fragment) or
          // an invalid host does not produce a garbled request URL.
          try {
            const u = new URL(/^https?:\/\//i.test(entry) ? entry : `https://${entry}`);
            const host = `${u.host}${u.pathname.replace(/\/+$/, '')}`;
            return host ? { name: `Custom ${i + 1}`, url: host, key: '' } : null;
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      const parsers = [...customParsers, ...PUBLIC_PARSERS];
      const parserAttempts = [];
      let selectedParser = null;

      const setParserTelemetry = (attempts, parserMeta) => {
        DebugTelemetry.parserAttempts = attempts.slice(-20);
        DebugTelemetry.selectedParser = parserMeta
          ? {
              name: parserMeta.name,
              domain: parserMeta.domain,
              valid_count: parserMeta.valid_count,
              raw_count: parserMeta.raw_count,
            }
          : null;
      };

      const activeParsers = parsers.filter((parser) => !ParserHealth.isCoolingDown(parser.url));
      const useCooldownAwarePass = activeParsers.length > 0;
      const passParsers = useCooldownAwarePass ? activeParsers : parsers;

      if (useCooldownAwarePass) {
        parsers
          .filter((parser) => ParserHealth.isCoolingDown(parser.url))
          .forEach((parser) => {
            const cooldownUntil = ParserHealth.getCooldownUntil(parser.url);
            parserAttempts.push({
              name: parser.name,
              domain: parser.url,
              elapsed_ms: 0,
              status: 'cooldown_skip',
              raw_count: 0,
              valid_count: 0,
              invalid_count: 0,
              cooldown_until: cooldownUntil ? new Date(cooldownUntil).toISOString() : null,
              reason: 'cooldown_active',
            });
          });
      }

      for (const p of passParsers) {
        if (signal.aborted) break;
        const qs = new URLSearchParams(qsCommon);
        if (p.key) qs.set('apikey', p.key);
        if (searchYear) qs.set('year', searchYear);
        const url = `https://${p.url}/api/v2.0/indexers/all/results?${qs.toString()}`;
        const startedAt = Date.now();

        try {
          LOG('Parser try:', p.name, url);
          const json = await request(
            url,
            { method: 'GET', is_torbox_api: false, timeoutMs: CONST.PUBLIC_PARSER_TIMEOUT_MS },
            signal
          );
          const list = Array.isArray(json?.Results) ? json.Results : [];
          const normalized = normalizeParserResults(list);
          const attempt = {
            name: p.name,
            domain: p.url,
            elapsed_ms: Date.now() - startedAt,
            status: normalized.validCount > 0 ? 'success' : normalized.rawCount > 0 ? 'invalid_payload' : 'empty',
            raw_count: normalized.rawCount,
            valid_count: normalized.validCount,
            invalid_count: normalized.invalidCount,
            cooldown_until: null,
            reason: normalized.validCount > 0 ? 'valid_hashes' : normalized.rawCount > 0 ? 'no_valid_hashes' : 'no_results',
          };
          parserAttempts.push(attempt);
          LOG('Parser result:', p.name, {
            raw: normalized.rawCount,
            valid: normalized.validCount,
            invalid: normalized.invalidCount,
            status: attempt.status,
          });

          if (normalized.validCount > 0) {
            ParserHealth.markSuccess(p.url);
            selectedParser = {
              name: p.name,
              domain: p.url,
              valid_count: normalized.validCount,
              raw_count: normalized.rawCount,
            };
            setParserTelemetry(parserAttempts, selectedParser);
            return {
              parser: selectedParser,
              entriesByHash: normalized.entriesByHash,
              diagnostics: parserAttempts.slice(),
            };
          }

          if (attempt.status === 'invalid_payload') {
            const health = ParserHealth.markFailure(p.url, attempt.status);
            attempt.cooldown_until = health?.cooldownUntil ? new Date(health.cooldownUntil).toISOString() : null;
          }
        } catch (e) {
          const failure = classifyParserFailure(e);
          const attempt = {
            name: p.name,
            domain: p.url,
            elapsed_ms: Date.now() - startedAt,
            status: failure.status,
            raw_count: 0,
            valid_count: 0,
            invalid_count: 0,
            cooldown_until: null,
            reason: failure.reason,
            status_code: failure.statusCode || null,
          };
          if (failure.cooldown) {
            const health = ParserHealth.markFailure(p.url, failure.status);
            attempt.cooldown_until = health?.cooldownUntil ? new Date(health.cooldownUntil).toISOString() : null;
          }
          parserAttempts.push(attempt);
          LOG('Parser failed:', p.name, e.message || e);
        } finally {
          setParserTelemetry(parserAttempts, selectedParser);
        }
      }

      const hadInvalidPayload = parserAttempts.some((attempt) => attempt.status === 'invalid_payload');
      setParserTelemetry(parserAttempts, selectedParser);
      throw hadInvalidPayload
        ? { type: 'api', message: translate('torbox_error_public_parsers_invalid') }
        : { type: 'api', message: translate('torbox_error_public_parsers_empty') };
    }

    async function checkCached(hashes, signal) {
      // TorBox accepts up to 100 hashes per call. Returns { data: { [hashHexLower]: true/false } }
      if (!Array.isArray(hashes) || !hashes.length) return {};
      const acc = {};
      for (let i = 0; i < hashes.length; i += 100) {
        if (signal?.aborted) break; // stop issuing chunk requests once cancelled
        const chunk = hashes.slice(i, i + 100);
        const qs = new URLSearchParams();
        chunk.forEach((h) => qs.append('hash', h));
        qs.set('format', 'object');
        qs.set('list_files', 'false');
        try {
          const r = await request(
            `${TB_MAIN}/torrents/checkcached?${qs.toString()}`,
            { method: 'GET', timeoutMs: CONST.TORBOX_API_TIMEOUT_MS },
            signal
          );
          if (r?.data) Object.assign(acc, r.data);
        } catch (e) {
          LOG('checkCached error:', e.message || e);
        }
      }
      return acc;
    }

    function addMagnet(magnet, signal) {
      const fd = new FormData();
      fd.append('magnet', magnet);
      fd.append('seed', '3');
      return request(
        `${TB_MAIN}/torrents/createtorrent`,
        { method: 'POST', body: fd, timeoutMs: CONST.TORBOX_API_TIMEOUT_MS },
        signal
      );
    }

    async function myList(id, signal) {
      const json = await request(
        `${TB_MAIN}/torrents/mylist?id=${encodeURIComponent(id)}&bypass_cache=true`,
        { method: 'GET', timeoutMs: CONST.TORBOX_API_TIMEOUT_MS },
        signal
      );
      if (json && json.data && !Array.isArray(json.data)) json.data = [json.data];
      return json;
    }

    async function requestDl(tid, fid, signal) {
      // TorBox API expects token query parameter alongside X-Api-Key header.
      // Optional permanent-link mode can be enabled; if it fails, we fallback to classic request.
      const base = `${TB_MAIN}/torrents/requestdl?torrent_id=${encodeURIComponent(tid)}&file_id=${encodeURIComponent(fid)}&token=${encodeURIComponent(Config.apiKey)}`;
      if (!getPreferPermanentLink()) {
        return request(base, { method: 'GET', timeoutMs: CONST.TORBOX_API_TIMEOUT_MS }, signal);
      }

      try {
        const preferred = await request(
          `${base}&redirect=true`,
          { method: 'GET', timeoutMs: CONST.TORBOX_API_TIMEOUT_MS },
          signal
        );
        const preferredUrl = preferred?.url || preferred?.data;
        if (typeof preferredUrl === 'string' && /^https?:\/\//i.test(preferredUrl)) return preferred;
      } catch (e) {
        LOG('Permanent requestdl failed, fallback to classic', e?.message || e);
      }

      return request(base, { method: 'GET', timeoutMs: CONST.TORBOX_API_TIMEOUT_MS }, signal);
    }

    // English source: Torrentio (CORS *, keyed by IMDb id). Merged with the RU parsers.
    // ponytail: series queries S<season|1>E1 only (season packs + that episode); per-episode lookup if needed.
    async function searchTorrentio(movie, signal) {
      const isTv = !!(movie.name || movie.first_air_date || movie.number_of_seasons);
      let imdb = movie.imdb_id;
      if (!imdb && movie.id) {
        // TMDB tv details carry no imdb_id; ask external_ids via Lampa's TMDB proxy.
        try {
          const url = Lampa.TMDB.api(`${isTv ? 'tv' : 'movie'}/${movie.id}/external_ids?api_key=${Lampa.TMDB.key()}`);
          imdb = (await (await fetch(url, { signal })).json())?.imdb_id;
        } catch (_) {}
      }
      if (!imdb) return new Map();
      const path = isTv ? `series/${imdb}:${movie.season_number || movie.season || 1}:1` : `movie/${imdb}`;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const onAbort = () => ctrl.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const res = await fetch(`https://torrentio.strem.fun/stream/${path}.json`, { signal: ctrl.signal });
        const json = await res.json();
        const map = new Map();
        (json?.streams || []).forEach((st) => {
          const hash = String(st.infoHash || '').toLowerCase();
          if (!Utils.isHex40(hash) || map.has(hash)) return;
          const lines = String(st.title || '').split('\n');
          const meta = String(st.title || '');
          const sz = meta.match(/💾\s*([\d.]+)\s*(TB|GB|MB|KB)/i);
          const mult = { TB: 1e12, GB: 1e9, MB: 1e6, KB: 1e3 };
          map.set(hash, {
            Title: lines[0] || st.behaviorHints?.filename || hash,
            InfoHash: hash,
            MagnetUri: `magnet:?xt=urn:btih:${hash}`,
            Size: sz ? Math.round(parseFloat(sz[1]) * mult[sz[2].toUpperCase()]) : 0,
            Seeders: Number((meta.match(/👤\s*(\d+)/) || [])[1]) || 0,
            Tracker: 'torrentio:' + ((meta.match(/⚙️\s*(.+)/) || [])[1] || '').trim(),
            TorrentioLangs: (meta.match(/⚙️[^\n]*\n([^\n]+)/) || [])[1] || '',
          });
        });
        return map;
      } catch (e) {
        LOG('Torrentio failed:', e?.message || e);
        return new Map();
      } finally {
        clearTimeout(t);
        signal?.removeEventListener('abort', onAbort);
      }
    }

    // RU parsers, made stricter for movie cards: TV-only categories (5xxx) are dropped, and if nothing is
    // left the search is retried without the year (TMDB moves release_date to re-releases, e.g. Hamilton 2020 -> 2025).
    // ponytail: no year match on the retry; a same-name film from another year can still show (its title has the year).
    async function searchRu(movie, signal) {
      const isMovie = !(movie.name || movie.first_air_date || movie.number_of_seasons);
      const tvOnly = (r) => {
        const cats = [].concat(r?.Category || []).map(Number).filter(Boolean);
        return cats.length > 0 && cats.every((n) => n >= 5000 && n < 6000);
      };
      const pick = (res) => {
        if (isMovie) res.entriesByHash.forEach((v, k) => { if (tvOnly(v)) res.entriesByHash.delete(k); });
        return res;
      };
      const first = await searchPublicTrackers(movie, signal).then(pick, (e) => ({ error: e }));
      if (first.entriesByHash?.size) return first;
      if (!(movie.year || movie.release_date || movie.first_air_date)) {
        if (first.error) throw first.error;
        throw { type: 'api', message: translate('torbox_error_public_parsers_empty') };
      }
      const retry = pick(await searchPublicTrackers({ ...movie, year: '', release_date: '', first_air_date: '' }, signal));
      if (!retry.entriesByHash.size) throw { type: 'api', message: translate('torbox_error_public_parsers_empty') };
      return retry;
    }

    async function searchAll(movie, signal) {
      const [ru, en] = await Promise.allSettled([searchRu(movie, signal), searchTorrentio(movie, signal)]);
      const enMap = en.status === 'fulfilled' ? en.value : new Map();
      if (ru.status === 'rejected') {
        if (!enMap.size) throw ru.reason;
        return { parser: { name: 'Torrentio' }, entriesByHash: enMap, diagnostics: [] };
      }
      enMap.forEach((v, k) => { if (!ru.value.entriesByHash.has(k)) ru.value.entriesByHash.set(k, v); });
      return ru.value;
    }

    return { searchPublicTrackers: searchAll, checkCached, addMagnet, myList, requestDl };
  })();

  // ───────────────────────────── Errors → Noty (actionable) ─────────────────────────────
  const ErrorHandler = {
    show(kind, err) {
      const t = kind || err?.type || 'error';
      const msg = err?.message || translate('torbox_error_unknown');
      DebugTelemetry.lastError = {
        ts: new Date().toISOString(),
        type: t,
        message: String(msg),
      };
      const prefix =
        t === 'auth' ? translate('torbox_error_prefix_auth') :
        t === 'validation' ? translate('torbox_error_prefix_validation') :
        t === 'network' ? translate('torbox_error_prefix_network') :
        t === 'api' ? translate('torbox_error_prefix_api') : translate('torbox_error_prefix_generic');
      try {
        Lampa.Noty.show(`${prefix}: ${msg}`, { type: 'error' });
      } catch {
        console.error('[TorBox]', prefix + ': ' + msg);
      }
      LOG('ERR', t, err);
    },
  };

  // ───────────────────────────── Audio language detection (-en fork) ─────────────────────────────
  // Two-letter codes from ffprobe tags, Torrentio flags and release-title keywords.
  // ponytail: keyword heuristics; a title that hides its dub language is reported as its tracker's default.
  const LangDetect = (() => {
    const ISO3 = { rus: 'RU', ukr: 'UK', eng: 'EN', bul: 'BG', pol: 'PL', ger: 'DE', deu: 'DE', fre: 'FR', fra: 'FR', spa: 'ES', ita: 'IT', por: 'PT', jpn: 'JA', kor: 'KO', chi: 'ZH', zho: 'ZH', swe: 'SV', heb: 'HE', hin: 'HI', tur: 'TR', cze: 'CS', ces: 'CS' };
    const COUNTRY = { GB: 'EN', US: 'EN', UA: 'UK', IL: 'HE', JP: 'JA', KR: 'KO', CN: 'ZH', BR: 'PT', MX: 'ES', IN: 'HI', SE: 'SV', DK: 'DA', GR: 'EL', CZ: 'CS', RS: 'SR' };
    const flags = (str) =>
      Array.from(String(str).matchAll(/([\u{1F1E6}-\u{1F1FF}])([\u{1F1E6}-\u{1F1FF}])/gu)).map((m) => {
        const cc = String.fromCharCode(m[1].codePointAt(0) - 0x1f1e6 + 65, m[2].codePointAt(0) - 0x1f1e6 + 65);
        return COUNTRY[cc] || cc;
      });
    const RU_TRACKERS = /rutracker|rutor|kinozal|nnmclub|megapeer|korsars|bitru|baibako|lostfilm|toloka|ultradox|selezen|anilibria/i;
    function detect(raw = {}) {
      const out = new Set();
      const title = String(raw.Title || '');
      const tracker = String(raw.Tracker || '');
      (Array.isArray(raw.ffprobe) ? raw.ffprobe : [])
        .filter((s) => s?.codec_type === 'audio')
        .forEach((s) => {
          const l = String(s?.tags?.language || s?.tags?.LANGUAGE || '').toLowerCase();
          if (l) out.add(ISO3[l] || l.slice(0, 2).toUpperCase());
        });
      flags(raw.TorrentioLangs || '').forEach((l) => out.add(l));
      if (/\bukr\b|укр|ukrainian|\bua\b|toloka/i.test(title + ' ' + tracker)) out.add('UK');
      if (/\bbg[\s._-]?(audio|dub)|бг[\s._-]?аудио|bulgarian|\bbul\b|[\[(]bg[\])]/i.test(title)) out.add('BG');
      if (/\bbg[\s._-]?subs?\b|бг[\s._-]?суб|bgsub/i.test(title)) out.add('BG-SUB');
      if (/\brus\b|russian|\bdub\b|\bmvo\b|\bavo\b|дубляж|(^|[^а-яё])(пм|пд|дб|мво|ммо)([^а-яё]|$)/i.test(title)) out.add('RU');
      if (/\beng\b|english/i.test(title)) out.add('EN');
      if (/original|оригинал/i.test(title)) out.add('ORIG');
      // Russian-tracker releases carry a Russian track unless they say "original only".
      if (!out.has('RU') && (/[а-яё]/i.test(title) || RU_TRACKERS.test(tracker)) && !/^\s*[^/]*\[оригинал\]/i.test(title)) out.add('RU');
      // Torrentio convention: no language line on an international release means English.
      if (!out.size && /^torrentio:/i.test(tracker) && !raw.TorrentioLangs) out.add('EN');
      if (/multi[\s._-]?audio|\bmulti\b/i.test(raw.TorrentioLangs || title)) out.add('MULTI');
      return Array.from(out);
    }
    const matches = (langs, filterValue) => {
      if (filterValue === 'all') return true;
      const want = filterValue === 'RU/UK' ? ['RU', 'UK'] : [filterValue];
      return (langs || []).some((l) => want.includes(l));
    };
    return { detect, matches };
  })();

  // ───────────────────────────── Search helpers ─────────────────────────────
  function generateSearchCombinations(movie = {}) {
    const combosMap = new Map();
    const addCombo = (query, tags = [], label) => {
      const normalized = String(query || '').replace(/\s+/g, ' ').trim();
      if (!normalized) return;
      const key = normalized.toLowerCase();
      const tagSet = new Set(tags.filter(Boolean));
      if (combosMap.has(key)) {
        const existing = combosMap.get(key);
        tagSet.forEach((tag) => existing.tags.add(tag));
        if (label && label.length < existing.label.length) existing.label = label;
        return;
      }
      combosMap.set(key, {
        query: normalized,
        label: label || normalized,
        tags: tagSet,
      });
    };

    const nameMap = new Map();
    const registerName = (value, tags = []) => {
      const normalized = String(value || '').replace(/\s+/g, ' ').trim();
      if (!normalized) return;
      const key = normalized.toLowerCase();
      if (!nameMap.has(key)) {
        nameMap.set(key, { value: normalized, tags: new Set(tags) });
      } else {
        const existing = nameMap.get(key);
        tags.forEach((tag) => existing.tags.add(tag));
      }
    };

    const title = (movie.title || movie.name || '').trim();
    const orig = (movie.original_title || movie.original_name || '').trim();
    const localizedTranslations = Array.isArray(movie.translations)
      ? movie.translations
          .map((t) => (t && t.data ? t.data.title : t?.title || t?.name || ''))
          .filter(Boolean)
      : [];

    if (title) registerName(title, ['base']);
    if (orig && orig.toLowerCase() !== title.toLowerCase()) registerName(orig, ['original']);
    localizedTranslations.forEach((name) => registerName(name, ['translation']));

    const pushDynamicName = (value) => {
      if (!value) return;
      if (typeof value === 'string') registerName(value, ['alt']);
      else if (Array.isArray(value)) value.forEach((item) => pushDynamicName(item));
      else if (value && typeof value === 'object') {
        if (value.title) pushDynamicName(value.title);
        if (value.name) pushDynamicName(value.name);
        if (value.value) pushDynamicName(value.value);
      }
    };

    Object.keys(movie).forEach((key) => {
      if (!/title|name/i.test(key)) return;
      if (['title', 'name', 'original_title', 'original_name'].includes(key)) return;
      pushDynamicName(movie[key]);
    });

    if (Array.isArray(movie?.alternative_titles?.titles)) {
      movie.alternative_titles.titles.forEach((entry) => pushDynamicName(entry?.title));
    }

    const names = Array.from(nameMap.values()).map((entry) => ({
      value: entry.value,
      tags: Array.from(entry.tags),
    }));

    const yearRaw = (movie.release_date || movie.first_air_date || movie.year || '').toString();
    const year = yearRaw ? yearRaw.slice(0, 4) : '';
    const season = movie.season_number || movie.season || null;
    const episode = movie.episode_number || movie.episode || null;

    const keywords = [movie.keywords, movie.tags]
      .flat()
      .filter(Boolean)
      .reduce((acc, item) => {
        if (typeof item === 'string') acc.push(item);
        if (item && typeof item === 'object') {
          if (item.name) acc.push(item.name);
          if (item.title) acc.push(item.title);
        }
        return acc;
      }, []);

    names.forEach((entry) => {
      addCombo(entry.value, entry.tags);
      if (year) addCombo(`${entry.value} ${year}`, [...entry.tags, 'year']);
      if (season) {
        const sNum = String(season).padStart(2, '0');
        addCombo(`${entry.value} S${sNum}`, [...entry.tags, 'season']);
        addCombo(`${entry.value} season ${season}`, [...entry.tags, 'season']);
        if (episode) {
          const eNum = String(episode).padStart(2, '0');
          addCombo(`${entry.value} S${sNum}E${eNum}`, [...entry.tags, 'season', 'episode']);
          addCombo(`${entry.value} ${season} сезон ${episode} серия`, [...entry.tags, 'season', 'episode']);
        }
      }
    });

    if (title && orig && title.toLowerCase() !== orig.toLowerCase()) {
      addCombo(`${title} ${orig}`, ['mix']);
      if (year) addCombo(`${title} ${orig} ${year}`, ['mix', 'year']);
    }

    const primaryNames = names
      .filter((entry) => entry.tags.includes('base') || entry.tags.includes('original') || entry.tags.includes('translation'))
      .slice(0, 3);

    keywords.slice(0, 10).forEach((kw) => {
      primaryNames.forEach((entry) => {
        addCombo(`${entry.value} ${kw}`, [...entry.tags, 'keyword']);
        if (year) addCombo(`${entry.value} ${kw} ${year}`, [...entry.tags, 'keyword', 'year']);
      });
    });

    if (movie.imdb_id) addCombo(movie.imdb_id, ['id']);
    if (movie.tmdb_id || movie.id) addCombo(`tmdb:${movie.tmdb_id || movie.id}`, ['id']);

    const limit = 40;
    const result = Array.from(combosMap.values())
      .map((entry) => ({
        query: entry.query,
        label: entry.label,
        tags: Array.from(entry.tags).filter((tag, idx, arr) => tag !== 'base' && arr.indexOf(tag) === idx),
      }))
      .filter((entry) => entry.query.length)
      .slice(0, limit);

    if (Config.debug) LOG('Search combinations', result);

    return result;
  }

  // ───────────────────────────── Main Component ─────────────────────────────
  function MainComponent(object) {
    /** Internal state */
    let scroll = new Lampa.Scroll({ mask: true, over: true, step: 250 });
    let files = new Lampa.Explorer(object);
    let filter = new Lampa.Filter(object);
    let abort = new AbortController();
    let initialized = false;
    let lastFocused = null;
    let cachedToggleBtn = null;
    let activeTorrentController = null;
    let pendingPlayback = null;

    this.activity = object.activity;
    window.__torbox_active_component = this;

    /** Sorting */
    const sortVariants = [
      { key: 'seeders', labelKey: 'torbox_sort_seeders_desc', field: 'last_known_seeders', reverse: true },
      { key: 'size_desc', labelKey: 'torbox_sort_size_desc', field: 'size', reverse: true },
      { key: 'size_asc', labelKey: 'torbox_sort_size_asc', field: 'size', reverse: false },
      { key: 'age', labelKey: 'torbox_sort_age', field: 'publish_timestamp', reverse: true },
    ];

    const defaultFilters = {
      quality: 'all',
      tracker: 'all',
      video_type: 'all',
      translation: 'all',
      lang: 'RU/UK',
      video_codec: 'all',
      audio_codec: 'all',
    };

    const loadFilters = () => {
      try {
        return JSON.parse(Store.get('torbox_filters_v4', JSON.stringify(defaultFilters)));
      } catch {
        Store.set('torbox_filters_v4', JSON.stringify(defaultFilters));
        return { ...defaultFilters };
      }
    };

    const loadCachedOnly = () => {
      const stored = Store.get('torbox_show_only_cached', null);
      if (stored === null || stored === '') return getDefaultCachedOnly();
      return parseBoolean(stored, false);
    };

    const state = {
      all_torrents: [],
      sort: Store.get('torbox_sort_method', 'seeders'),
      filters: loadFilters(),
      last_hash: null,
      view: 'torrents', // 'torrents' | 'episodes'
      current_torrent_data: null,
      search_query: null,
      show_only_cached: loadCachedOnly(),
    };

    const readPreferenceState = () => ({
      qualityOrder: getQualityOrder(),
      audioLangs: getPreferredAudioLangs(),
      videoCodecs: getPreferredVideoCodecs(),
      excludedTrackers: getExcludedTrackers(),
    });

    const isTrackerExcluded = (torrentTrackers, excludedSet) => {
      if (!excludedSet || !excludedSet.size) return false;
      return (Array.isArray(torrentTrackers) ? torrentTrackers : []).some((tracker) =>
        excludedSet.has(String(tracker || '').toLowerCase())
      );
    };

    const rawTorrentByHash = new Map();
    let debugOverlayEl = null;

    const storeRawTorrent = (hash, raw) => {
      if (!hash || !raw) return;
      rawTorrentByHash.delete(hash);
      rawTorrentByHash.set(hash, raw);
      if (rawTorrentByHash.size > CONST.RAW_CACHE_HASH_LIMIT) {
        const oldest = rawTorrentByHash.keys().next().value;
        rawTorrentByHash.delete(oldest);
      }
    };

    const getRawTorrentByHash = (hash) => (hash ? rawTorrentByHash.get(hash) || null : null);

    const FocusZones = Object.freeze({
      CONTINUE: 'continue',
      LIST: 'list',
      FILTER: 'filter',
      FILE: 'file',
      FILE_DOWNLOAD: 'file_download',
      EMPTY: 'empty',
    });

    const focusState = {
      zone: null,
      index: 0,
    };

    const describeElementForDebug = (element) => {
      if (!element || !element.length) return '-';
      const classes = Utils.safeClassSelector(element.attr('class') || '') || element.prop('tagName') || '-';
      const hash = element.attr('data-hash') || '';
      return hash ? `${classes}[data-hash="${hash}"]` : classes;
    };

    const ensureDebugOverlay = () => {
      const shouldShow = Config.debug && getDebugOverlayEnabled();
      if (!shouldShow) {
        if (debugOverlayEl) {
          debugOverlayEl.remove();
          debugOverlayEl = null;
        }
        return;
      }
      if (debugOverlayEl && debugOverlayEl.length) return;

      debugOverlayEl = $('<div class="torbox-debug-overlay" aria-live="polite"></div>');
      debugOverlayEl.css({
        position: 'fixed',
        right: '1em',
        bottom: '1em',
        zIndex: 99999,
        maxWidth: '36em',
        padding: '.7em .9em',
        borderRadius: '.6em',
        background: 'rgba(0,0,0,.78)',
        color: '#fff',
        fontSize: '.85em',
        lineHeight: '1.35',
        pointerEvents: 'none',
        whiteSpace: 'pre-line',
      });
      $('body').append(debugOverlayEl);
    };

    const updateDebugOverlay = (element) => {
      ensureDebugOverlay();
      if (!debugOverlayEl || !debugOverlayEl.length) return;

      const lines = [
        `TorBox ${VERSION}`,
        `view: ${state.view}`,
        `zone/index: ${focusState.zone || '-'} / ${focusState.index}`,
        `element: ${describeElementForDebug(element)}`,
      ];
      if (DebugTelemetry.selectedParser?.name) {
        lines.push(`parser: ${DebugTelemetry.selectedParser.name} (${DebugTelemetry.selectedParser.valid_count || 0})`);
      }
      debugOverlayEl.text(lines.join('\n'));
    };

    const buildDiagnosticsReport = () => ({
      generated_at: new Date().toISOString(),
      version: VERSION,
      settings: {
        proxy_url: Config.proxyUrl || '',
        debug: !!Config.debug,
        debug_overlay: getDebugOverlayEnabled(),
        prefer_permanent_link: getPreferPermanentLink(),
        default_cached_only: getDefaultCachedOnly(),
        auto_pick_movie_file: getAutoPickMovieFile(),
        quality_order: getQualityOrder(),
        preferred_audio_langs: getPreferredAudioLangs(),
        preferred_video_codecs: getPreferredVideoCodecs(),
        excluded_trackers: getExcludedTrackers(),
        video_extensions: getVideoExtensions(),
      },
      state: {
        view: state.view,
        sort: state.sort,
        show_only_cached: state.show_only_cached,
        focus_zone: focusState.zone,
        focus_index: focusState.index,
        items_total: state.all_torrents.length,
      },
      last_error: DebugTelemetry.lastError,
      selected_parser: DebugTelemetry.selectedParser,
      parser_attempts: DebugTelemetry.parserAttempts.slice(-20),
      logs_tail: DebugTelemetry.logs.slice(-50),
    });

    const isTorrentsView = () => state.view === 'torrents';

    const getFilterFocusItems = () => {
      if (!filter || typeof filter.render !== 'function') return $();
      const container = filter.render();

      // Lampa's built-in filter bar uses `.filter--search/.filter--sort/.filter--filter` buttons.
      // Some builds may use different class naming, so we keep a fallback.
      let items = container.find(
        '.torbox-cached-toggle.selector, .filter--search.selector, .filter--sort.selector, .filter--filter.selector'
      );

      if (!items || !items.length) {
        items = container.find('.filter__item.selector, .selector');
      }

      // Do not allow the optional back button to steal our primary routes.
      items = items.not('.filter--back');

      return items;
    };

    const getFocusCollection = (zone) => {
      if (!scroll || typeof scroll.render !== 'function') return $();
      const root = scroll.render();
      switch (zone) {
        case FocusZones.CONTINUE:
          return root.find('.torbox-watched-item.selector');
        case FocusZones.LIST:
          return root.find('.torbox-item.selector');
        case FocusZones.EMPTY:
          return root.find('.empty.selector');
        case FocusZones.FILTER:
          return getFilterFocusItems();
        case FocusZones.FILE:
          return root.find('.torbox-file-item.selector');
        case FocusZones.FILE_DOWNLOAD:
          return root.find('.torbox-file-download.selector');
        default:
          return $();
      }
    };

    const detectZone = (element) => {
      if (!element || !element.length) return null;
      if (element.hasClass('torbox-item')) return FocusZones.LIST;
      if (element.hasClass('torbox-watched-item')) return FocusZones.CONTINUE;
      if (
        element.hasClass('torbox-cached-toggle') ||
        element.hasClass('filter__item') ||
        element.hasClass('filter--search') ||
        element.hasClass('filter--sort') ||
        element.hasClass('filter--filter') ||
        element.hasClass('filter--back') ||
        element.hasClass('simple-button--filter')
      ) {
        return FocusZones.FILTER;
      }
      if (element.hasClass('torbox-file-download')) return FocusZones.FILE_DOWNLOAD;
      if (element.hasClass('torbox-file-item')) return FocusZones.FILE;
      if (element.hasClass('empty')) return FocusZones.EMPTY;
      return null;
    };

    const updateFocusMetaFromElement = (element) => {
      if (!element || !element.length) return;
      const zone = element.data('torboxZone') || detectZone(element);
      const index = Number(element.data('torboxIndex')) || 0;
      focusState.zone = zone;
      focusState.index = index;
      lastFocused = element[0];
      if (zone === FocusZones.LIST) {
        const hashAttr = element.attr('data-hash');
        if (hashAttr) state.last_hash = hashAttr;
      }
      updateDebugOverlay(element);
    };

    const focusElement = (element) => {
      if (!element || !element.length) return false;
      updateFocusMetaFromElement(element);
      if (scroll && typeof scroll.render === 'function') {
        const focusContainer =
          focusState.zone === FocusZones.FILTER && filter && typeof filter.render === 'function'
            ? filter.render()
            : scroll.render();
        Lampa.Controller.collectionFocus(element[0], focusContainer);
        if (focusState.zone !== FocusZones.FILTER && typeof scroll.update === 'function') {
          scroll.update(element, true);
        }
      }
      return true;
    };

    const focusZone = (zone, index = 0) => {
      const collection = getFocusCollection(zone);
      if (!collection || !collection.length) return false;
      const clamped = Math.min(Math.max(index, 0), collection.length - 1);
      const target = collection.eq(clamped);
      return focusElement(target);
    };

    const focusListByIndex = (index = 0) => focusZone(FocusZones.LIST, index);
    const focusContinueItem = () => focusZone(FocusZones.CONTINUE, 0);
    const focusFilterItem = (index = 0) => focusZone(FocusZones.FILTER, index);
    const focusEmptyMessage = () => focusZone(FocusZones.EMPTY, 0);
    const focusFileItem = (index = 0) => focusZone(FocusZones.FILE, index);
    const focusFileDownload = (index = 0) => focusZone(FocusZones.FILE_DOWNLOAD, index);

    const focusFirstListItem = () => {
      if (!scroll || typeof scroll.render !== 'function') return;
      if (!isTorrentsView()) return;
      if (!focusListByIndex(0)) focusEmptyMessage();
    };

    const focusLastKnownListItem = () => {
      if (!scroll || typeof scroll.render !== 'function') return false;
      if (state.last_hash) {
        const saved = scroll.render().find(`[data-hash="${state.last_hash}"]`).first();
        if (saved.length) return focusElement(saved);
      }
      return focusListByIndex(0);
    };

    const hasContinueItem = () => getFocusCollection(FocusZones.CONTINUE).length > 0;

    const openFilterPanel = () => {
      try {
        const btn = filter && typeof filter.render === 'function' ? filter.render().find('.filter--filter') : null;
        if (btn && btn.length) {
          btn.trigger('hover:enter');
          return true;
        }
      } catch (e) {
        LOG('openFilterPanel trigger error', e);
      }
      try {
        filter.show(Lampa.Lang.translate('title_filter'), 'filter');
      } catch (e) {
        LOG('openFilterPanel show error', e);
      }
      return true;
    };

    const refreshFilterFocusBinding = () => {
      if (!filter || typeof filter.render !== 'function') return;
      const items = getFilterFocusItems();
      if (!items || !items.length) return;
      items.each((idx, el) => {
        const $el = $(el);
        $el
          .data('torboxZone', FocusZones.FILTER)
          .data('torboxIndex', idx)
          .addClass('torbox-filter-focus');
      });
      items.off('hover:focus.torboxNav').on('hover:focus.torboxNav', (e) => {
        updateFocusMetaFromElement($(e.currentTarget));
      });
    };

    const focusPrimaryFilterControl = () => {
      if (!filter || typeof filter.render !== 'function') return false;
      refreshFilterFocusBinding();
      const container = filter.render();

      // Prefer the actual "Filter" button: OK should open the filter list.
      let primary = container.find('.filter--filter.selector').first();
      if (!primary.length) primary = container.find('.filter--filter').first();
      if (primary.length) return focusElement(primary);

      return focusFilterItem(0);
    };

    const focusSearchControl = () => {
      if (!filter || typeof filter.render !== 'function') return false;
      refreshFilterFocusBinding();
      const container = filter.render();

      let searchBtn = container.find('.filter--search.selector').first();
      if (!searchBtn.length) searchBtn = container.find('.filter--search').first();
      if (searchBtn.length) return focusElement(searchBtn);

      return focusFilterItem(0);
    };

    const formatRefineTags = (tags) => {
      if (!Array.isArray(tags) || !tags.length) return '';
      const dictionary = {
        original: translate('torbox_refine_tag_original'),
        translation: translate('torbox_refine_tag_translation'),
        alt: translate('torbox_refine_tag_alt'),
        year: translate('torbox_refine_tag_year'),
        season: translate('torbox_refine_tag_season'),
        episode: translate('torbox_refine_tag_episode'),
        keyword: translate('torbox_refine_tag_keyword'),
        id: translate('torbox_refine_tag_id'),
        mix: translate('torbox_refine_tag_mix'),
      };
      const labels = tags
        .map((tag) => dictionary[tag])
        .filter(Boolean);
      return labels.join(' • ');
    };

    const focusRoutes = {
      [FocusZones.LIST]: {
        up: () => {
          if (focusState.index > 0) return focusListByIndex(focusState.index - 1);
          // Visual order in UI: Filter bar (search/sort/filter) -> Continue -> List.
          // So when user is at the first list item, Up should go to Continue first (if present),
          // and only then to the filter/search controls above it.
          if (hasContinueItem()) return focusContinueItem();
          if (focusSearchControl()) return true;
          Lampa.Controller.toggle('head');
          return true;
        },
        down: () => focusListByIndex(focusState.index + 1) || focusListByIndex(focusState.index),
        left: () => {
          Lampa.Controller.toggle('menu');
          return true;
        },
        right: () => {
          // UX for TV: Right from the list should immediately open the filter list
          // (not just move focus to the top filter button).
          openFilterPanel();
          return true;
        },
      },
      [FocusZones.CONTINUE]: {
        up: () => {
          if (focusSearchControl()) return true;
          Lampa.Controller.toggle('head');
          return true;
        },
        down: () => focusListByIndex(0) || true,
        left: () => {
          Lampa.Controller.toggle('menu');
          return true;
        },
        right: () => {
          // Match list behavior: Right opens filter list immediately.
          openFilterPanel();
          return true;
        },
      },
      [FocusZones.FILTER]: {
        up: () => {
          Lampa.Controller.toggle('head');
          return true;
        },
        down: () => (hasContinueItem() ? focusContinueItem() : focusLastKnownListItem() || focusListByIndex(0) || true),
        left: () => {
          if (focusState.index > 0) return focusFilterItem(focusState.index - 1);
          return focusLastKnownListItem() || focusContinueItem() || true;
        },
        right: () => focusFilterItem(focusState.index + 1) || focusFilterItem(focusState.index),
      },
      [FocusZones.EMPTY]: {
        up: () => {
          if (focusSearchControl()) return true;
          Lampa.Controller.toggle('head');
          return true;
        },
        down: () => true,
        left: () => {
          Lampa.Controller.toggle('menu');
          return true;
        },
        right: () => {
          openFilterPanel();
          return true;
        },
      },
      [FocusZones.FILE]: {
        up: () => focusFileItem(focusState.index - 1) || focusFileItem(focusState.index),
        down: () => focusFileItem(focusState.index + 1) || focusFileItem(focusState.index),
        left: () => {
          Lampa.Controller.toggle('menu');
          return true;
        },
        right: () => focusFileDownload(focusState.index) || true,
      },
      [FocusZones.FILE_DOWNLOAD]: {
        up: () => focusFileDownload(focusState.index - 1) || focusFileDownload(focusState.index),
        down: () => focusFileDownload(focusState.index + 1) || focusFileDownload(focusState.index),
        left: () => focusFileItem(focusState.index) || true,
        right: () => true,
      },
    };

    const ensureFocusExists = () => {
      if (!isTorrentsView()) return;
      if (focusState.zone && lastFocused) return;
      if (focusLastKnownListItem()) return;
      if (focusListByIndex(0)) return;
      if (hasContinueItem() && focusContinueItem()) return;
      if (focusSearchControl()) return;
      if (!focusListByIndex(0)) focusEmptyMessage();
    };

    const handleDirectionalNavigation = (direction) => {
      if (state.view === 'episodes') {
        const zone = focusState.zone || FocusZones.FILE;
        const handler = focusRoutes[zone]?.[direction];
        if (typeof handler === 'function' && handler()) return;
        if (Navigator.canmove(direction)) Navigator.move(direction);
        return;
      }

      if (!isTorrentsView()) {
        if (Navigator.canmove(direction)) Navigator.move(direction);
        return;
      }

      ensureFocusExists();

      const zone = focusState.zone || FocusZones.LIST;
      const handler = focusRoutes[zone]?.[direction];

      if (typeof handler === 'function') {
        const handled = handler();
        if (handled) return;
      }

      if (Navigator.canmove(direction)) Navigator.move(direction);
    };

    const movieStorageKey = () => object.movie.imdb_id || object.movie.id || 'unknown';

    const lastTorrentStorageKey = () => `torbox_last_torrent_data_${movieStorageKey()}`;

    const compactTorrentSnapshot = (src) => {
      if (!src || !src.hash || !src.magnet) return null;
      return {
        hash: src.hash,
        magnet: src.magnet,
        title: src.raw_title || src.title || '',
        size: Number(src.size) || 0,
        last_known_seeders: Number(src.last_known_seeders) || 0,
        last_known_peers: Number(src.last_known_peers) || 0,
        cached: !!src.cached,
        quality: src.quality || null,
        icon: src.icon || '',
      };
    };

    const saveLastTorrentSnapshot = (snapshot) => {
      const key = lastTorrentStorageKey();
      if (snapshot) {
        const normalized = Object.assign({}, snapshot, {
          title: (snapshot.title || '').slice(0, 320),
        });
        let payload = JSON.stringify(normalized);
        if (payload.length > CONST.MAX_SNAPSHOT_BYTES) {
          const minimal = {
            hash: normalized.hash,
            magnet: normalized.magnet,
            title: normalized.title,
            cached: !!normalized.cached,
            quality: normalized.quality || null,
            size: normalized.size || 0,
            last_known_seeders: normalized.last_known_seeders || 0,
            last_known_peers: normalized.last_known_peers || 0,
            icon: normalized.icon || '',
          };
          payload = JSON.stringify(minimal);
        }
        Store.set(key, payload);
      } else {
        Store.set(key, '');
      }
    };

    const loadLastTorrentSnapshot = () => {
      const raw = Store.get(lastTorrentStorageKey(), '');
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        const snapshot = compactTorrentSnapshot(parsed);
        if (snapshot) {
          // Normalize legacy entries without compact fields
          saveLastTorrentSnapshot(snapshot);
          return snapshot;
        }
      } catch (err) {
        LOG('Continue panel parse error', err);
      }
      Store.set(lastTorrentStorageKey(), '');
      return null;
    };

    const buildContinueInfo = (snapshot) => {
      if (!snapshot) return translate('torbox_last_torrent_fallback');
      const icon = snapshot.icon || (snapshot.cached ? '⚡' : '☁️');
      const titleParts = [];
      if (snapshot.quality) titleParts.push(`[${Utils.escapeHtml(String(snapshot.quality))}]`);
      titleParts.push(Utils.escapeHtml(snapshot.title || translate('torbox_no_title')));
      const sizeText = snapshot.size ? Utils.formatBytes(snapshot.size) : translate('torbox_not_available');
      const seeders = snapshot.last_known_seeders ?? 0;
      return translateWithParams('torbox_continue_info_template', {
        icon,
        title: titleParts.join(' '),
        size: sizeText,
        seeders,
      });
    };

    const cancelActiveTorrentFlow = () => {
      if (activeTorrentController) {
        try {
          if (!activeTorrentController.signal.aborted) activeTorrentController.abort();
        } catch (err) {
          LOG('Abort active torrent flow error', err);
        }
      }
      activeTorrentController = null;
      const reverted = revertPendingPlayback();
      if (reverted && state.view === 'torrents') build();
    };

    // ───────────────────────────── Rendering helpers ─────────────────────────────
    this.buildTechBar = (tech, raw) => {
      const tag = (txt, cls) =>
        `<div class="torbox-item__tech-item torbox-item__tech-item--${cls}">${txt}</div>`;

      let html = '';
      if (tech.video_resolution) html += tag(Utils.escapeHtml(tech.video_resolution), 'res');
      if (tech.video_codec) html += tag(Utils.escapeHtml(String(tech.video_codec).toUpperCase()), 'codec');
      if (tech.has_hdr) html += tag('HDR', 'hdr');
      if (tech.has_dv) html += tag('Dolby Vision', 'dv');
      if (tech.audio_langs && tech.audio_langs.length) html += tag(Utils.escapeHtml(tech.audio_langs.join(' · ')), 'lang');

      // Audio streams (resilient: show codec/lang/layout if present; tolerates missing ffprobe)
      const audioStreams = Array.isArray(raw?.ffprobe) ? raw.ffprobe.filter((s) => s?.codec_type === 'audio') : [];
      let voiceIdx = 0;
      audioStreams.forEach((s) => {
        let lang =
          s?.tags?.language?.toUpperCase() ||
          s?.tags?.LANGUAGE?.toUpperCase() ||
          (Array.isArray(raw?.info?.voices) && raw.info.voices[voiceIdx++]) ||
          null;

        const codec = s?.codec_name ? String(s.codec_name).toUpperCase() : '';
        const layout = s?.channel_layout || '';
        const text = [lang, codec, layout].filter(Boolean).join(' ');
        if (text) html += tag(Utils.escapeHtml(text), 'audio');
      });

      return html ? `<div class="torbox-item__tech-bar">${html}</div>` : '';
    };

    const toViewItem = (raw, hashHex, cachedSet) => {
      const v = Array.isArray(raw?.ffprobe) ? raw.ffprobe.find((s) => s.codec_type === 'video') : null;
      const a = Array.isArray(raw?.ffprobe) ? raw.ffprobe.filter((s) => s.codec_type === 'audio') : [];
      const trackers = String(raw?.Tracker || '')
        .split(/,\s*/)
        .map((item) => String(item || '').trim())
        .filter(Boolean);
      const primaryTracker = trackers[0] || translate('torbox_not_available');

      const tech = {
        video_codec: v?.codec_name || null,
        video_resolution: v ? `${v.width}x${v.height}` : null,
        audio_langs: LangDetect.detect(raw),
        audio_codecs: [...new Set(a.map((s) => s?.codec_name).filter(Boolean))].map((x) => String(x).toUpperCase()),
        has_hdr: /(^|\W)hdr(\W|$)/i.test(raw?.Title || '') || /hdr/i.test(raw?.info?.videotype || ''),
        has_dv: /(dv|dolby\s*vision)/i.test(raw?.Title || '') || /(dovi|dolby\s*vision)/i.test(raw?.info?.videotype || ''),
      };

      const isCached = cachedSet.has(hashHex.toLowerCase());
      const publishDate = raw?.PublishDate ? new Date(raw.PublishDate) : null;

      const viewItem = {
        title: Utils.escapeHtml(raw?.Title || translate('torbox_no_title')),
        raw_title: raw?.Title || '',
        size: Number(raw?.Size) || 0,
        magnet: raw?.MagnetUri || '',
        hash: hashHex,
        last_known_seeders: Number(raw?.Seeders) || 0,
        last_known_peers: Number(raw?.Peers || raw?.Leechers) || 0,
        trackers,
        icon: isCached ? '⚡' : '☁️',
        cached: isCached,
        publish_date: raw?.PublishDate || '',
        publish_timestamp: publishDate && isFinite(publishDate) ? publishDate.getTime() : 0,
        age: Utils.formatAge(raw?.PublishDate),
        quality: Utils.getQualityLabel(raw?.Title || '', raw),
        video_type: String(raw?.info?.videotype || '').toLowerCase() || 'unknown',
        voices: Array.isArray(raw?.info?.voices) ? raw.info.voices : [],
        video_codec: tech.video_codec,
        audio_langs: tech.audio_langs,
        audio_codecs: tech.audio_codecs,
        info_formated:
          `[${Utils.getQualityLabel(raw?.Title || '', raw)}] ${Utils.formatBytes(raw?.Size)} ` +
          `| 🟢<span style="color:var(--color-good);">${Number(raw?.Seeders) || 0}</span>` +
          ` / 🔴<span style="color:var(--color-bad);">${Number(raw?.Peers || raw?.Leechers) || 0}</span>`,
        meta_formated:
          `${translate('torbox_info_trackers')}: ${Utils.escapeHtml(primaryTracker)} ` +
          `| ${translate('torbox_info_added')}: ${Utils.formatAge(raw?.PublishDate) || translate('torbox_not_available')}`,
        tech_bar_html: this.buildTechBar(tech, raw),
      };

      storeRawTorrent(hashHex, raw);
      return viewItem;
    };

    // ───────────────────────────── Core actions ─────────────────────────────
    const drawEpisodes = (torrentData, preferredFile = null) => {
      focusState.zone = FocusZones.FILE;
      focusState.index = 0;
      scroll.clear();
      filter.render().hide();

      const mid = object.movie.imdb_id || object.movie.id || 'unknown';
      const torrentKey = torrentData.hash || torrentData.id;
      let watchedSet;
      try {
        const rawWatched = JSON.parse(Store.get(`torbox_watched_episodes_${mid}_${torrentKey}`, '[]'));
        let sanitized = Array.isArray(rawWatched) ? rawWatched.map((id) => String(id)).filter(Boolean) : [];
        if (sanitized.length > CONST.MAX_WATCHED_EPISODES) {
          sanitized = sanitized.slice(-CONST.MAX_WATCHED_EPISODES);
          Store.set(`torbox_watched_episodes_${mid}_${torrentKey}`, JSON.stringify(sanitized));
        } else if (sanitized.length !== (Array.isArray(rawWatched) ? rawWatched.length : 0)) {
          Store.set(`torbox_watched_episodes_${mid}_${torrentKey}`, JSON.stringify(sanitized));
        }
        watchedSet = new Set(sanitized);
      } catch {
        watchedSet = new Set();
        Store.set(`torbox_watched_episodes_${mid}_${torrentKey}`, '[]');
      }
      // Scope by torrent: TorBox file ids are per-torrent, so a movie-only key
      // would highlight/focus an unrelated file in a different release.
      const preferredFocusId =
        preferredFile && preferredFile.id !== undefined && preferredFile.id !== null ? String(preferredFile.id) : null;
      const storedLastPlayedId = Store.get(`torbox_last_played_file_${mid}_${torrentKey}`, null);

      const videoExtensions = getVideoExtensions();
      const videoRegex = new RegExp(
        `\\.(${videoExtensions.map((ext) => ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`,
        'i'
      );

      const vids = (Array.isArray(torrentData.files) ? torrentData.files : [])
        .filter((f) => videoRegex.test(f?.name || ''))
        .map((f, i) => Object.assign({ __idx: i }, f))
        .sort(Utils.naturalEpisodeSort);

      if (!vids.length) {
        ErrorHandler.show('validation', { message: translate('torbox_error_no_video_files') });
        return;
      }

      let focusEl = null;
      let firstFileEl = null;

      vids.forEach((file, idx) => {
        const clean = (file.name || '').split('/').pop();
        let item = Lampa.Template.get('torbox_episode_item', {
          title: Utils.escapeHtml(clean || file.name || translate('torbox_no_title')),
          size: Utils.formatBytes(file.size || 0),
          file_id: Utils.escapeHtml(String(file.id)),
          download_label: Utils.escapeHtml(translate('torbox_file_download')),
        });
        if (!firstFileEl) firstFileEl = item;

        const fileIdStr = String(file.id);
        const isWatched = watchedSet.has(fileIdStr);
        const isLastPlayed = storedLastPlayedId !== null && fileIdStr === String(storedLastPlayedId);
        const shouldFocus = preferredFocusId ? fileIdStr === preferredFocusId : isLastPlayed;
        const downloadBtn = item.find('.torbox-file-download');
        if (isWatched) item.addClass('torbox-file-item--watched');
        if (isLastPlayed) {
          item.addClass('torbox-file-item--last-played');
        }
        if (shouldFocus) {
          focusEl = item;
        }

        item
          .data('torboxZone', FocusZones.FILE)
          .data('torboxIndex', idx)
          .on('hover:focus', (e) => {
            const target = $(e.currentTarget);
            updateFocusMetaFromElement(target);
            scroll.update(target, true);
          })
          .on('hover:enter', () => {
            rememberPreferredFile(torrentData, file);
            play(torrentData, file, {
              onStart: ({ changed }) => {
                // Some Lampa builds may not reliably fire Player.callback on exit.
                // Mark the file as watched as soon as playback successfully starts,
                // so the UI/state is consistent when returning later.
                if (!watchedSet.has(fileIdStr) && changed) {
                  watchedSet.add(fileIdStr);
                  item.addClass('torbox-file-item--watched');
                }
              },
              onSuccess: ({ changed }) => {
                if (!watchedSet.has(fileIdStr) && changed) {
                  watchedSet.add(fileIdStr);
                  item.addClass('torbox-file-item--watched');
                }
                drawEpisodes(torrentData);
                Lampa.Controller.toggle('content');
              },
              onFail: () => Lampa.Controller.toggle('content'),
            });
          });

        downloadBtn
          .data('torboxZone', FocusZones.FILE_DOWNLOAD)
          .data('torboxIndex', idx)
          .attr('title', translate('torbox_file_download'))
          .on('hover:focus', (e) => {
            const target = $(e.currentTarget);
            updateFocusMetaFromElement(target);
            scroll.update(item, true);
          })
          .on('hover:enter', (e) => {
            if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
            if (e && typeof e.preventDefault === 'function') e.preventDefault();
            downloadFileLink(torrentData, file, downloadBtn);
          });

        scroll.append(item);
      });

      if (focusEl || firstFileEl) focusElement(focusEl || firstFileEl);
      Lampa.Controller.enable('content');
      updateDebugOverlay(focusEl || firstFileEl || null);
    };

    const _getPlayerConfig = (url, file, movie) => {
      const cleanName = (file?.name || '').split('/').pop();
      const cfg = {
        url,
        title: cleanName || movie.title || 'TorBox',
        poster: Lampa.Utils.cardImgBackgroundBlur(movie),
        id: movie.id,
        movie,
        // Lampa's player reads the card from `card` (header title, footer info).
        card: movie,
      };
      // Infer season/episode numbers when present
      const s = (cleanName || '').match(/[Ss](\d{1,2})/);
      const e = (cleanName || '').match(/[Ee](\d{1,3})/);
      if (s) cfg.season = parseInt(s[1], 10);
      if (e) cfg.episode = parseInt(e[1], 10);
      // Episode without a season marker ("Show - 05.mkv"): Lampa treats it as season 1.
      if (!s && e && movie.number_of_seasons) cfg.season = 1;
      // Lampa only records playback progress when the config carries a timeline.
      // Key on title/season/episode (Lampa's card.js convention) so the rotating
      // TorBox link never invalidates it. TV cards keep the title in original_name.
      const origTitle = movie.original_title || movie.original_name || movie.title || '';
      const tlKey =
        cfg.season != null && cfg.episode != null
          ? [cfg.season, cfg.season > 10 ? ':' : '', cfg.episode, origTitle].join('')
          : String(origTitle);
      if (Lampa.Timeline && typeof Lampa.Timeline.view === 'function') {
        cfg.timeline = Lampa.Timeline.view(Lampa.Utils.hash(tlKey));
      }
      return cfg;
    };

    const _markWatched = (torrentHashOrId, fileId) => {
      const mid = object.movie.imdb_id || object.movie.id || 'unknown';
      const key = `torbox_watched_episodes_${mid}_${torrentHashOrId}`;
      let rawList;
      try {
        rawList = JSON.parse(Store.get(key, '[]'));
      } catch {
        rawList = [];
      }
      if (!Array.isArray(rawList)) rawList = [];

      const seen = new Set();
      const normalized = [];
      rawList.forEach((entry) => {
        const id = String(entry);
        if (!id || seen.has(id)) return;
        seen.add(id);
        normalized.push(id);
      });

      let changed = normalized.length !== rawList.length;
      const fileKey = String(fileId);
      if (fileKey && !seen.has(fileKey)) {
        normalized.push(fileKey);
        seen.add(fileKey);
        changed = true;
      }

      if (normalized.length > CONST.MAX_WATCHED_EPISODES) {
        const cut = normalized.slice(-CONST.MAX_WATCHED_EPISODES);
        normalized.length = 0;
        normalized.push(...cut);
        changed = true;
      }

      Store.set(key, JSON.stringify(normalized));
      // Match drawEpisodes' torrent-scoped read (file ids are per-torrent).
      if (fileKey) Store.set(`torbox_last_played_file_${mid}_${torrentHashOrId}`, fileKey);
      return changed;
    };

    const preferredFileStorageKey = (torrentData) => {
      const mid = object.movie.imdb_id || object.movie.id || 'unknown';
      const torrentKey = torrentData?.hash || torrentData?.id || 'unknown';
      return `torbox_preferred_file_${mid}_${torrentKey}`;
    };

    const rememberPreferredFile = (torrentData, file) => {
      const fid = file?.id;
      if (fid === undefined || fid === null) return;
      Store.set(preferredFileStorageKey(torrentData), String(fid));
    };

    const getRememberedFile = (torrentData, files) => {
      const remembered = Store.get(preferredFileStorageKey(torrentData), '');
      if (!remembered) return null;
      const list = Array.isArray(files) ? files : [];
      return list.find((file) => String(file?.id) === String(remembered)) || null;
    };

    const isSeriesContent = () => {
      const movie = object?.movie || {};
      return !!(
        movie.name ||
        movie.original_name ||
        movie.first_air_date ||
        movie.season_number ||
        movie.number_of_seasons ||
        (Array.isArray(movie.seasons) && movie.seasons.length) ||
        movie.media_type === 'tv'
      );
    };

    const pickBestVideoFile = (files) => {
      const list = Array.isArray(files) ? files : [];
      if (!list.length) return null;

      // Prefer real content files over extras/samples/trailers.
      const sampleRe = /(sample|trailer|тизер|teaser|featurette|extras?|behind[ ._-]?the[ ._-]?scenes)/i;
      const candidates = list.filter((file) => !sampleRe.test(String(file?.name || '').split('/').pop() || ''));
      const base = candidates.length ? candidates : list;

      return base
        .slice()
        .sort((a, b) => {
          const sizeA = Number(a?.size) || 0;
          const sizeB = Number(b?.size) || 0;
          if (sizeA !== sizeB) return sizeB - sizeA;
          const nameA = String(a?.name || '');
          const nameB = String(b?.name || '');
          return nameA.localeCompare(nameB);
        })[0] || null;
    };

    const normalizeSafeDownloadLink = (link) => {
      if (!link || typeof link !== 'string') return null;

      try {
        const url = new URL(link.trim());
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        return url.href;
      } catch (_) {
        return null;
      }
    };

    const resolveFileDownloadLink = async (torrentData, file) => {
      const dl = await Api.requestDl(torrentData.id, file.id);
      const link = normalizeSafeDownloadLink(dl?.url || dl?.data);
      if (!link) throw { type: 'api', message: translate('torbox_error_file_link') };
      return link;
    };

    const getFileDownloadFilename = (file) => {
      const clean = String(file?.name || '').split('/').pop().trim();
      const fallback = `torbox-file-${file?.id ?? 'download'}.mp4`;
      const filename = (clean || fallback)
        .replace(/[\x00-\x1F\\/:*?"<>|]+/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180);
      return filename || fallback;
    };

    const getAndroidBridgeVersion = () => {
      try {
        if (typeof AndroidJS === 'undefined' || typeof AndroidJS.appVersion !== 'function') return 0;
        const parts = String(AndroidJS.appVersion() || '').split('-');
        const raw = parts.pop();
        const version = parseInt(raw, 10);
        return Number.isFinite(version) ? version : 0;
      } catch (_) {
        return 0;
      }
    };

    const canUseAndroidBrowser = () => {
      try {
        if (typeof AndroidJS !== 'undefined' && typeof AndroidJS.openBrowser === 'function') return true;
        return !!(
          typeof Lampa !== 'undefined' &&
          Lampa?.Platform?.is &&
          Lampa.Platform.is('android') &&
          Lampa?.Android?.openBrowser &&
          getAndroidBridgeVersion() >= 484
        );
      } catch (_) {
        return false;
      }
    };

    const tryAndroidDownloadOpen = (link) => {
      try {
        if (typeof AndroidJS !== 'undefined' && typeof AndroidJS.openBrowser === 'function') {
          AndroidJS.openBrowser(link);
          return true;
        }
      } catch (e) {
        LOG('AndroidJS download open failed', e?.message || e);
      }

      try {
        if (canUseAndroidBrowser()) {
          Lampa.Android.openBrowser(link);
          return true;
        }
      } catch (e) {
        LOG('Android download open failed', e?.message || e);
      }

      return false;
    };

    const closePreparedDownloadOpen = (opener) => {
      try {
        if (opener && !opener.closed && typeof opener.close === 'function') opener.close();
      } catch (_) {
        /* ignore cross-window close failures */
      }
    };

    const prepareFileDownloadOpen = (file) => {
      if (canUseAndroidBrowser()) return null;

      try {
        if (typeof window.open !== 'function') return null;
        const opener = window.open('', '_blank');
        if (!opener) return null;

        try {
          opener.opener = null;
          if (opener.document) {
            opener.document.title = getFileDownloadFilename(file);
            if (opener.document.body) {
              opener.document.body.style.font = '16px sans-serif';
              opener.document.body.style.padding = '24px';
              opener.document.body.textContent = translate('torbox_download_preparing');
            }
          }
        } catch (_) {
          /* Some WebViews expose an opener object but not its document. */
        }

        return opener;
      } catch (e) {
        LOG('Download target prepare failed', e?.message || e);
        return null;
      }
    };

    const clickAnchorDownload = (link, file) => {
      try {
        if (typeof document === 'undefined' || !document.body) return false;
        const filename = getFileDownloadFilename(file);
        const anchor = document.createElement('a');
        anchor.href = link;
        anchor.setAttribute('download', filename);
        anchor.setAttribute('target', '_blank');
        anchor.setAttribute('rel', 'noopener');
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        setTimeout(() => {
          try {
            anchor.remove();
          } catch (_) {
            /* ignore DOM cleanup failures */
          }
        }, 0);
        return true;
      } catch (e) {
        LOG('Anchor download failed', e?.message || e);
        return false;
      }
    };

    const tryOpenDownloadLink = (link) => {
      try {
        if (typeof window.open === 'function') {
          const opened = window.open(link, '_blank', 'noopener');
          if (opened) return true;
        }
      } catch (e) {
        LOG('Download link open failed', e?.message || e);
      }
      return false;
    };

    const startFileDownload = (link, file, opener) => {
      if (tryAndroidDownloadOpen(link)) return 'system';

      try {
        if (opener && !opener.closed) {
          opener.location.href = link;
          return 'system';
        }
      } catch (e) {
        LOG('Prepared download open failed', e?.message || e);
        closePreparedDownloadOpen(opener);
      }

      if (clickAnchorDownload(link, file) || tryOpenDownloadLink(link)) return 'attempted';
      return 'copy_only';
    };

    const downloadFileLink = async (torrentData, file, button) => {
      const btn = button && button.length ? button : null;
      if (btn && btn.data('torboxDownloading')) return;
      let opener = null;

      try {
        if (btn) {
          btn.data('torboxDownloading', true);
          btn.addClass('torbox-file-download--loading');
        }

        opener = prepareFileDownloadOpen(file);
        const link = await resolveFileDownloadLink(torrentData, file);
        const downloadState = startFileDownload(link, file, opener);
        opener = null;
        Lampa.Utils.copyTextToClipboard(link, () => {
          const message =
            downloadState === 'system'
              ? translate('torbox_download_started')
              : downloadState === 'attempted'
                ? translate('torbox_download_attempted')
                : translate('torbox_download_link_copied');
          Lampa.Noty.show(message);
        }, () => {
          const message =
            downloadState === 'system'
              ? translate('torbox_download_started_no_copy')
              : downloadState === 'attempted'
                ? translate('torbox_download_attempted_no_copy')
                : translate('torbox_download_link_copy_failed');
          Lampa.Noty.show(message);
        });
      } catch (e) {
        closePreparedDownloadOpen(opener);
        ErrorHandler.show(e?.type || 'error', e);
      } finally {
        if (btn) {
          btn.data('torboxDownloading', false);
          btn.removeClass('torbox-file-download--loading');
        }
        Lampa.Controller.toggle('content');
      }
    };

    const play = async (torrentData, file, callbacks = {}) => {
      const { onSuccess, onFail, onFinally, onStart } = callbacks || {};
      let playbackStarted = false;
      let finished = false;

      try {
        preparePlaybackState(torrentData);

        if (object.movie?.id) Lampa.Favorite.add('history', object.movie);

        const link = await resolveFileDownloadLink(torrentData, file);

        const playbackConfig = _getPlayerConfig(link, file, object.movie);

        const startResult = Lampa.Player.play(playbackConfig);
        playbackStarted = startResult !== false;
        if (!playbackStarted) {
          throw { type: 'cancel', message: translate('torbox_error_player_cancelled') };
        }

        if (pendingPlayback) pendingPlayback.started = true;

        // Mark watched as early as possible after successful player start.
        // We still also mark on Player.callback; this early mark improves UX robustness.
        let changedAtStart = false;
        try {
          changedAtStart = _markWatched(torrentData.hash || torrentData.id, file.id);
        } catch (e) {
          LOG('Mark watched onStart error', e);
        }
        if (typeof onStart === 'function') onStart({ torrentData, file, changed: changedAtStart });

        Lampa.Player.callback(() => {
          if (finished) return;
          finished = true;
          const changed = _markWatched(torrentData.hash || torrentData.id, file.id);
          finalizePendingPlayback();
          if (typeof onSuccess === 'function') onSuccess({ torrentData, file, changed });
        });
      } catch (e) {
        if (!playbackStarted) {
          const reverted = revertPendingPlayback();
          if (reverted && state.view === 'torrents') build();
        }
        if (typeof onFail === 'function') onFail(e);
        if (e?.type !== 'cancel') ErrorHandler.show(e.type || 'error', e);
      } finally {
        if (typeof onFinally === 'function') onFinally({ started: playbackStarted, file, torrentData });
      }
    };

    const updateContinueWatchingPanel = (snapshotParam) => {
      if (state.view !== 'torrents') return;

      const snapshot = snapshotParam ?? loadLastTorrentSnapshot();
      let panel = scroll.body().find('.torbox-watched-item');

      if (snapshot) {
        const info = buildContinueInfo(snapshot);

        if (panel.length) {
          panel.find('.torbox-watched-item__info').text(info);
          panel.data('torboxSnapshot', snapshot);
          panel.data('torboxZone', FocusZones.CONTINUE);
          panel.data('torboxIndex', 0);
          // Panel may be created outside a collection refresh; ensure it's navigable.
          try {
            if (Lampa.Controller && typeof Lampa.Controller.collectionAppend === 'function') {
              Lampa.Controller.collectionAppend(panel);
            }
          } catch {}
        } else {
          const historyItem = Lampa.Template.get('torbox_watched_item', {
            title: translate('torbox_continue_watching'),
            info,
          });
          historyItem
            .data('torboxSnapshot', snapshot)
            .data('torboxZone', FocusZones.CONTINUE)
            .data('torboxIndex', 0);
          historyItem
            .on('hover:focus', (e) => {
              const target = $(e.currentTarget);
              updateFocusMetaFromElement(target);
              scroll.update(target, true);
            })
            .on('hover:enter', (e) => {
              const snap = $(e.currentTarget).data('torboxSnapshot');
              if (snap) onTorrentClick(snap);
            });
          scroll.body().prepend(historyItem);
          try {
            if (Lampa.Controller && typeof Lampa.Controller.collectionAppend === 'function') {
              Lampa.Controller.collectionAppend(historyItem);
            }
          } catch {}
        }
      } else if (panel.length) {
        const panelEl = panel[0];
        panel.remove();
        try {
          if (window.Navigator && typeof Navigator.remove === 'function' && panelEl) {
            Navigator.remove(panelEl);
          }
        } catch {}
        if (focusState.zone === FocusZones.CONTINUE) {
          focusState.zone = null;
          focusState.index = 0;
          lastFocused = null;
        }
      }
    };

    const selectFile = (torrentData) => {
      const videoExtensions = Store.get('torbox_video_extensions', 'mkv,mp4,avi,ts,m4v,webm')
        .split(',')
        .map((ext) => ext.trim().toLowerCase())
        .filter(Boolean);
      const videoRegex = new RegExp(
        `\\.(${videoExtensions.map((ext) => ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`,
        'i'
      );

      const vids = (Array.isArray(torrentData.files) ? torrentData.files : []).filter((f) =>
        videoRegex.test(f?.name || '')
      );
      if (!vids.length) {
        ErrorHandler.show('validation', { message: translate('torbox_error_no_video_files') });
        return;
      }

      const openFileList = (preferredFile = null) => {
        state.view = 'episodes';
        state.current_torrent_data = torrentData;
        drawEpisodes(torrentData, preferredFile);
      };

      const remembered = getRememberedFile(torrentData, vids);
      if (remembered) {
        openFileList(remembered);
        return;
      }

      if (!isSeriesContent() && getAutoPickMovieFile()) {
        const best = pickBestVideoFile(vids);
        if (best) {
          openFileList(best);
          return;
        }
      }

      openFileList();
    };

    const beginPendingPlayback = (hash, snapshot) => {
      const previousSnapshot = loadLastTorrentSnapshot();
      pendingPlayback = {
        hash,
        snapshot: snapshot || null,
        previousSnapshot,
        previousHash: previousSnapshot?.hash || null,
        started: false,
      };
    };

    const revertPendingPlayback = () => {
      if (!pendingPlayback || pendingPlayback.started) return false;
      saveLastTorrentSnapshot(pendingPlayback.previousSnapshot || null);
      updateContinueWatchingPanel(pendingPlayback.previousSnapshot || null);
      state.last_hash = pendingPlayback.previousHash || null;
      pendingPlayback = null;
      return true;
    };

    const finalizePendingPlayback = () => {
      pendingPlayback = null;
    };

    const preparePlaybackState = (source) => {
      if (!source || !source.hash) return null;
      if (pendingPlayback && pendingPlayback.hash === source.hash) return pendingPlayback.snapshot || null;
      const original = state.all_torrents.find((t) => t.hash === source.hash) || source;
      const snapshot = compactTorrentSnapshot(original);
      if (!snapshot) return null;
      beginPendingPlayback(source.hash, snapshot);
      saveLastTorrentSnapshot(snapshot);
      updateContinueWatchingPanel(snapshot);
      if (original?.markAsLastPlayed) setTimeout(() => original.markAsLastPlayed(), 0);
      return snapshot;
    };

    const track = (id, signal) =>
      new Promise((resolve, reject) => {
        let active = true;
        let retries = 0;
        let pollTimer = null;
        const maxRetries = getTrackRetries();
        const intervalMs = getTrackIntervalMs();
        const scheduleNext = () => {
          pollTimer = setTimeout(loop, intervalMs);
        };

        const cancel = () => {
          if (!active) return;
          active = false;
          if (pollTimer) clearTimeout(pollTimer);
          signal.removeEventListener('abort', cancel);
          Lampa.Loading.stop();
          reject({ name: 'AbortError', message: translate('torbox_error_aborted') });
        };
        signal.addEventListener('abort', cancel);

        const loop = async () => {
          if (!active) return;

          if (retries++ > maxRetries) {
            active = false;
            signal.removeEventListener('abort', cancel);
            return reject({ type: 'api', message: translate('torbox_error_torrent_timeout') });
          }

          try {
            const arr = (await Api.myList(id, signal))?.data || [];
            const d = arr[0];
            if (!d) {
              scheduleNext();
              return;
            }

            const phase = Utils.downloadPhase(d);

            if (phase === 'ready') {
              active = false;
              signal.removeEventListener('abort', cancel);
              resolve(d);
              return;
            }

            const loadingText = $('.loading-layer .loading-layer__text');
            if (phase === 'finalizing') {
              // Downloaded but TorBox is still caching/preparing files — a download
              // ETA/speed here is stale (shows nonsense like "24h"), so reassure the
              // user that it is being prepared rather than still downloading.
              loadingText.text(translate('torbox_loading_finalizing'));
            } else {
              const progress = Utils.normalizeProgress(d.progress);
              const speedTxt = Utils.formatBytes(d.download_speed, true);
              const etaTxt = Utils.formatTime(d.eta);
              const seeds = Number(d.seeds) || 0;
              const peers = Number(d.peers) || 0;
              loadingText.text(
                translateWithParams('torbox_loading_progress', {
                  progress: progress.toFixed(2),
                  speed: speedTxt,
                  seeds,
                  peers,
                  eta: etaTxt,
                })
              );
            }
            scheduleNext();
          } catch (e) {
            active = false;
            signal.removeEventListener('abort', cancel);
            reject(e);
          }
        };

        loop();
      });

    const onTorrentClick = (item) => {
      if (!item?.magnet) {
        return ErrorHandler.show('validation', { message: translate('torbox_error_no_magnet') });
      }
      if (!item?.hash || !Utils.isHex40(item.hash)) {
        return ErrorHandler.show('validation', { message: translate('torbox_error_bad_hash') });
      }

      try {
        preparePlaybackState(item);
      } catch (e) {
        LOG('History save error', e);
      }

      const storageKey = `torbox_id_for_hash_${item.hash}`;
      const savedId = Store.get(storageKey, '');

      cancelActiveTorrentFlow();

      const controller = new AbortController();
      const signal = controller.signal;
      activeTorrentController = controller;

      Lampa.Loading.start(() => controller.abort(), translate('torbox_loading_connect'));

      const finalizeTracker = () => {
        if (activeTorrentController === controller) activeTorrentController = null;
      };

      const processAndOpen = (data, hash) => {
        data.hash = hash;
        Lampa.Loading.stop();
        finalizeTracker();
        selectFile(data);
      };

      const addThenTrack = (magnet, hash) => {
        $('.loading-layer .loading-layer__text').text(translate('torbox_loading_add'));
        Api.addMagnet(magnet, signal)
          .then((res) => {
            const newId = res?.data?.torrent_id || res?.data?.id;
            if (!newId) throw { type: 'api', message: translate('torbox_error_no_torrent_id') };
            Store.set(storageKey, String(newId));
            LOG('New TorBox ID saved', newId, 'for', hash);
            $('.loading-layer .loading-layer__text').text(translate('torbox_loading_wait'));
            return track(newId, signal);
          })
          .then((data) => processAndOpen(data, hash))
          .catch((err) => {
            Lampa.Loading.stop();
            finalizeTracker();
            if (err?.name !== 'AbortError') ErrorHandler.show(err.type || 'error', err);
          });
      };

      if (savedId) {
        LOG('Using saved TorBox ID:', savedId);
        $('.loading-layer .loading-layer__text').text(translate('torbox_loading_wait'));
        track(savedId, signal)
          .then((data) => processAndOpen(data, item.hash))
          .catch((err) => {
            // If ID became stale (deleted/expired), re-add magnet and retry
            const stale = err?.type === 'api' || /not\s*found/i.test(err?.message || '');
            if (err?.name !== 'AbortError' && stale) {
              LOG('Stale TorBox ID, re-adding magnet...');
              Store.set(storageKey, '');
              addThenTrack(item.magnet, item.hash);
            } else {
              Lampa.Loading.stop();
              finalizeTracker();
              if (err?.name !== 'AbortError') ErrorHandler.show(err.type || 'error', err);
            }
          });
      } else {
        LOG('No saved TorBox ID. Adding...');
        addThenTrack(item.magnet, item.hash);
      }
    };

    // ───────────────────────────── Search/Build pipeline ─────────────────────────────
    const build = () => {
      buildFilter();
      // Ensure filter is visible (in case we came back from episodes view)
      if (filter && typeof filter.render === 'function') filter.render().show();
      if (cachedToggleBtn) updateCachedToggleVisual();
      const filtered = applyFiltersSort();
      if (Config.debug) {
        const snapshotRaw = Store.get(lastTorrentStorageKey(), '') || '';
        LOG('TorBox render stats', {
          total: state.all_torrents.length,
          filtered: filtered.length,
          cachedOnly: state.show_only_cached,
          snapshotBytes: snapshotRaw.length,
          rawCache: rawTorrentByHash.size,
        });
      }
      draw(filtered);
      updateDebugOverlay(lastFocused ? $(lastFocused) : null);
    };

    const Modules = Object.freeze({
      utils: {
        sanitizeExtensions,
        setVideoExtensions,
        getVideoExtensions,
        generateSearchCombinations,
      },
      state: {
        setTrackRetries,
        getTrackRetries,
        setTrackIntervalMs,
        getTrackIntervalMs,
      },
      cache: {
        storeRawTorrent,
        getRawTorrentByHash,
      },
      ui: {
        focusFirstListItem,
        formatRefineTags,
        updateContinueWatchingPanel,
      },
      diagnostics: {
        buildReport: buildDiagnosticsReport,
      },
    });

    this.modules = Modules;

    const applyFiltersSort = () => {
      const prefs = readPreferenceState();
      const excludedTrackersSet = new Set(
        (prefs.excludedTrackers || []).map((item) => String(item || '').toLowerCase())
      );
      const qualityRank = new Map((prefs.qualityOrder || []).map((quality, idx) => [quality, idx]));
      const audioRank = new Map((prefs.audioLangs || []).map((lang, idx) => [lang, idx]));
      const codecRank = new Map((prefs.videoCodecs || []).map((codec, idx) => [codec, idx]));

      const preferenceScore = (torrent) => {
        const quality = String(torrent?.quality || '').toUpperCase();
        const qualityScore = qualityRank.has(quality) ? qualityRank.get(quality) : qualityRank.size + 1;

        const langs = Array.isArray(torrent?.audio_langs)
          ? torrent.audio_langs.map((lang) => String(lang || '').toUpperCase())
          : [];
        const audioScore = langs.length
          ? langs.reduce((best, lang) => Math.min(best, audioRank.has(lang) ? audioRank.get(lang) : audioRank.size + 1), audioRank.size + 1)
          : audioRank.size + 1;

        const codec = String(torrent?.video_codec || '').toUpperCase();
        const codecScore = codecRank.has(codec) ? codecRank.get(codec) : codecRank.size + 1;

        return qualityScore * 100 + audioScore * 10 + codecScore;
      };

      // Apply filters
      const rules = [
        (t) => !state.show_only_cached || !!t.cached,
        (t) => !isTrackerExcluded(t.trackers, excludedTrackersSet),
        (t) => state.filters.quality === 'all' || t.quality === state.filters.quality,
        (t) => state.filters.video_type === 'all' || t.video_type === state.filters.video_type,
        (t) => state.filters.translation === 'all' || (Array.isArray(t.voices) && t.voices.includes(state.filters.translation)),
        (t) => LangDetect.matches(t.audio_langs, state.filters.lang),
        (t) => state.filters.video_codec === 'all' || (t.video_codec && t.video_codec.toUpperCase() === state.filters.video_codec.toUpperCase()),
        (t) => state.filters.audio_codec === 'all' || (Array.isArray(t.audio_codecs) && t.audio_codecs.includes(state.filters.audio_codec.toUpperCase())),
        (t) => state.filters.tracker === 'all' || (Array.isArray(t.trackers) && t.trackers.includes(state.filters.tracker)),
      ];

      let list = state.all_torrents.filter((t) => rules.every((fn) => fn(t)));

      // Stable sort by index when equal
      const sort = sortVariants.find((s) => s.key === state.sort) || sortVariants[0];
      list = list
        .map((x, i) => ({ x, i }))
        .sort((A, B) => {
          const a = A.x[sort.field] ?? 0;
          const b = B.x[sort.field] ?? 0;
          if (a < b) return -1;
          if (a > b) return 1;

          const prefA = preferenceScore(A.x);
          const prefB = preferenceScore(B.x);
          if (prefA !== prefB) return prefA - prefB;

          return A.i - B.i; // stable
        })
        .map((q) => q.x);

      if (sort.reverse) list.reverse();

      // Guard: cap number of rendered items (performance on low-end)
      if (list.length > CONST.MAX_DRAW_ITEMS) list = list.slice(0, CONST.MAX_DRAW_ITEMS);

      return list;
    };

    const draw = (items) => {
      lastFocused = null;
      focusState.zone = null;
      focusState.index = 0;
      scroll.clear();

      // Playback progress (Lampa internal storage may be object or JSON string)
      let viewDataForMovie = null;
      try {
        const viewRaw = Lampa.Storage.get('view', '{}');
        const viewObj = typeof viewRaw === 'string' ? JSON.parse(viewRaw) : viewRaw;
        viewDataForMovie = viewObj?.[object.movie?.id];
      } catch {
        viewDataForMovie = null;
      }

      if (!Array.isArray(items) || !items.length) {
        return empty(translate('torbox_empty_filters'));
      }

      // Last played hash marker
      const lastSnapshot = loadLastTorrentSnapshot();
      let lastHash = lastSnapshot?.hash || null;

      items.forEach((data, idx) => {
        const lastPlayedIcon =
          lastHash && data.hash === lastHash
            ? `<span class="torbox-item__last-played-icon"><svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14.5V7.5l5.25 3.5L11 16.5z" fill="currentColor"></path></svg></span>`
            : '';

        const item = Lampa.Template.get('torbox_item', {
          ...data,
          last_played_icon: lastPlayedIcon,
        });

        item.data('torboxZone', FocusZones.LIST).data('torboxIndex', idx);

        // Playback progress (if present)
        if (viewDataForMovie && viewDataForMovie.total > 0 && viewDataForMovie.time >= 0) {
          const percent = Math.round((viewDataForMovie.time / viewDataForMovie.total) * 100);
          item.append(
            `<div class="torbox-item__progress"><div style="width:${Utils.clamp(percent, 0, 100)}%"></div></div>`
          );

          const timeWidget = Lampa.Template.get('player_time', {
            time: Lampa.Utils.secondsToTime(viewDataForMovie.time),
            left: Lampa.Utils.secondsToTime(viewDataForMovie.total - viewDataForMovie.time),
          });
          item.find('.torbox-item__main-info').after(timeWidget);
        }

        // Method used by "onTorrentClick" to mark the last played visually and persistently
        data.markAsLastPlayed = () => {
          scroll.render().find('.torbox-item__last-played-icon').remove();
          const titleEl = item.find('.torbox-item__title');
          if (titleEl.length && !titleEl.find('.torbox-item__last-played-icon').length) {
            titleEl.prepend(
              `<span class="torbox-item__last-played-icon"><svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14.5V7.5l5.25 3.5L11 16.5z" fill="currentColor"></path></svg></span>`
            );
          }
          const snapshot = compactTorrentSnapshot(data);
          saveLastTorrentSnapshot(snapshot);
          updateContinueWatchingPanel(snapshot);
        };

        item
          .on('hover:focus', (e) => {
            const target = $(e.currentTarget);
            target.data('torboxIndex', idx);
            updateFocusMetaFromElement(target);
            scroll.update(target, true);
            state.last_hash = data.hash;
          })
          .on('hover:enter', () => onTorrentClick(data))
          .on('hover:long', () => {
            Lampa.Select.show({
              title: translate('torbox_actions_title'),
              items: [{ title: translate('torbox_actions_copy_magnet') }],
              onSelect: () => {
                Lampa.Utils.copyTextToClipboard(data.magnet, () =>
                  Lampa.Noty.show(translate('torbox_actions_copied'))
                );
                Lampa.Controller.toggle('content');
              },
              onBack: () => Lampa.Controller.toggle('content'),
            });
          });

        scroll.append(item);
      });

      Lampa.Controller.enable('content');

      updateContinueWatchingPanel(lastSnapshot);

      if (state.last_hash) {
        const saved = scroll.render().find(`[data-hash="${state.last_hash}"]`).first();
        if (saved.length && focusElement(saved)) return;
      }

      focusFirstListItem();
    };

    const empty = (msg) => {
      scroll.clear();
      const el = Lampa.Template.get('torbox_empty', {
        message: Utils.escapeHtml(msg || translate('torbox_empty_list')),
      });
      el
        .addClass('selector')
        .data('torboxZone', FocusZones.EMPTY)
        .data('torboxIndex', 0)
        .on('hover:focus', (e) => {
          const target = $(e.currentTarget);
          updateFocusMetaFromElement(target);
          scroll.update(target, true);
        })
        .on('hover:enter', () =>
          Lampa.Noty.show(translate('torbox_no_results_prompt'))
        );
      scroll.append(el);
      Lampa.Controller.enable('content');
      updateDebugOverlay(el);
    };

    const reset = () => {
      lastFocused = null;
      scroll.clear();
      scroll.reset();
    };

    const generateKeyForMovie = (customTitle) => {
      if (customTitle) return `torbox_custom_search_${customTitle}`;
      const mid = object.movie?.id || object.movie?.imdb_id || 'unknown';
      return `torbox_hybrid_${mid}`;
    };

    const buildFilter = () => {
      const buildOne = (key, titleKey, arrays) => {
        const uni = [...new Set(arrays.flat().filter(Boolean).map((x) => String(x)))].sort((a, b) =>
          a.toUpperCase().localeCompare(b.toUpperCase())
        );
        const items = [
          {
            title: translate('torbox_filter_all'),
            value: 'all',
            selected: state.filters[key] === 'all',
          },
          ...uni.map((v) => ({
            title: Utils.escapeHtml(v.toUpperCase()),
            value: v,
            selected: state.filters[key] === v,
          })),
        ];
        const subRaw = state.filters[key] === 'all' ? translate('torbox_filter_all') : state.filters[key].toUpperCase();
        const sub = Utils.escapeHtml(subRaw);
        return { title: translate(titleKey), subtitle: sub, items, stype: key };
      };

      const baseItems = [
        { title: translate('torbox_filter_refine'), refine: true },
        buildOne('quality', 'torbox_filter_quality', state.all_torrents.map((t) => t.quality)),
        buildOne('video_type', 'torbox_filter_video_type', state.all_torrents.map((t) => t.video_type)),
        buildOne('translation', 'torbox_filter_translation', state.all_torrents.map((t) => t.voices || [])),
        (() => {
          const one = buildOne('lang', 'torbox_filter_audio_lang', [...state.all_torrents.map((t) => t.audio_langs || []), 'BG']);
          one.items.splice(1, 0, { title: 'RU / UK', value: 'RU/UK', selected: state.filters.lang === 'RU/UK' });
          return one;
        })(),
        buildOne('video_codec', 'torbox_filter_video_codec', state.all_torrents.map((t) => (t.video_codec ? [t.video_codec] : []))),
        buildOne('audio_codec', 'torbox_filter_audio_codec', state.all_torrents.map((t) => t.audio_codecs || [])),
        buildOne('tracker', 'torbox_filter_tracker', state.all_torrents.map((t) => t.trackers || [])),
        { title: translate('torbox_filter_reset'), reset: true },
        { title: translate('torbox_filter_refresh'), refresh: true },
      ];

      filter.set('filter', baseItems);
      filter.render().find('.filter--filter span').text(translate('torbox_filter_title'));
      filter
        .render()
        .find('.filter--search input')
        .attr('placeholder', state.search_query || object.movie.title || object.movie.name);

      const chosen = baseItems
        .filter((f) => f.stype && state.filters[f.stype] !== 'all')
        .map((f) => Utils.escapeHtml(`${f.title}: ${state.filters[f.stype]}`));
      filter.chosen('filter', chosen);

      const sorts = sortVariants.map((s) => ({
        key: s.key,
        title: translate(s.labelKey),
        field: s.field,
        reverse: s.reverse,
        selected: s.key === state.sort,
      }));
      filter.set('sort', sorts);
      filter.render().find('.filter--sort span').text(translate('torbox_sort_title'));

      // Ensure cachedToggleBtn is present and bound
      if (cachedToggleBtn && !filter.render().find('.torbox-cached-toggle').length) {
        filter.render().find('.filter--sort').before(cachedToggleBtn);
      }

      refreshFilterFocusBinding();
    };

    const search = (force = false, customTitle = null) => {
      cancelActiveTorrentFlow();
      abort.abort();
      abort = new AbortController();
      const signal = abort.signal;
      DebugTelemetry.parserAttempts = [];
      DebugTelemetry.selectedParser = null;

      this.activity.loader(true);
      reset();
      state.search_query = customTitle;

      const movieForSearch = customTitle
        ? { ...object.movie, title: customTitle, original_title: customTitle, year: '' }
        : object.movie;

      const cacheKey = generateKeyForMovie(customTitle);
      const cached = !force && Cache.get(cacheKey);
      if (cached) {
        state.all_torrents = cached;
        LOG('Loaded from RAM cache:', state.all_torrents.length);
        build();
        this.activity.loader(false);
        return;
      }

      empty(
        customTitle
          ? translateWithParams('torbox_search_custom', { query: Utils.escapeHtml(customTitle) })
          : translate('torbox_search_fetching')
      );

      Api.searchPublicTrackers(movieForSearch, signal)
        .then((parserPayload) => {
          if (signal.aborted) return;
          const mapByHash = parserPayload?.entriesByHash;
          if (!(mapByHash instanceof Map) || !mapByHash.size) {
            return empty(translate('torbox_search_parser_empty'));
          }

          const hashes = Array.from(mapByHash.keys());
          empty(translateWithParams('torbox_check_cache_progress', { count: hashes.length }));

          return Api.checkCached(hashes, signal).then((cachedMap) => ({ mapByHash, cachedMap }));
        })
        .then((payload) => {
          if (!payload || signal.aborted) return;

          const cachedEntries = Object.entries(payload.cachedMap || {});
          const cachedSet = new Set(
            cachedEntries
              .filter(([, flag]) => isCachedFlagTrue(flag))
              .map(([h]) => h.toLowerCase())
          );
          const list = [];

          payload.mapByHash.forEach((raw, hex) => {
            list.push(toViewItem(raw, hex, cachedSet));
          });

          Cache.set(cacheKey, list);
          state.all_torrents = list;
          build();
        })
        .catch((err) => {
          if (!signal.aborted) {
            empty(err?.message || translate('torbox_generic_error'));
            ErrorHandler.show(err?.type || 'error', err);
          }
        })
        .finally(() => {
          this.activity.loader(false);
        });
    };

    // ───────────────────────────── Lifecycle & Controller ─────────────────────────────
    this.create = function () {
      this.activity.loader(false);
      scroll.body().addClass('torbox-list-container');
      files.appendFiles(scroll.render());
      files.appendHead(filter.render());
      scroll.minus(files.render().find('.explorer__files-head'));
      return this.render();
    };

    this.render = function () {
      return files.render();
    };

    this.initialize = function () {
      Lampa.Controller.add('content', {
        toggle: () => {
          if (isTorrentsView()) {
            Lampa.Controller.collectionSet(filter.render(), scroll.render());
          } else {
            // Episodes view: filter is hidden, keep navigation only within file list.
            Lampa.Controller.collectionSet(scroll.render());
          }
          Lampa.Controller.collectionFocus(lastFocused || false, scroll.render());
          ensureFocusExists();
        },
        up: () => handleDirectionalNavigation('up'),
        down: () => handleDirectionalNavigation('down'),
        left: () => handleDirectionalNavigation('left'),
        right: () => handleDirectionalNavigation('right'),
        back: this.back.bind(this),
      });

      Lampa.Controller.toggle('content');

      // Filter events
      filter.onSelect = (type, a, b) => {
        Lampa.Select.close();
        if (type === 'sort') {
          state.sort = a.key;
          Store.set('torbox_sort_method', a.key);
        } else if (type === 'filter') {
          if (a.refine) {
            const combos = generateSearchCombinations(object.movie);
            if (!combos.length) {
              Lampa.Noty.show(translate('torbox_refine_not_enough_data'));
              return Lampa.Controller.toggle('content');
            }
            Lampa.Select.show({
              title: translate('torbox_refine_title'),
              items: combos.map((combo) => ({
                title: Utils.escapeHtml(combo.label),
                subtitle: Utils.escapeHtml(formatRefineTags(combo.tags)),
                search_query: combo.query,
              })),
              onSelect: (sel) => {
                search(true, sel.search_query);
                Lampa.Controller.toggle('content');
              },
              onBack: () => Lampa.Controller.toggle('content'),
            });
            return;
          }
          if (a.refresh) return search(true);
          if (a.reset) state.filters = JSON.parse(JSON.stringify(defaultFilters));
          else if (a.stype) state.filters[a.stype] = b.value;
          Store.set('torbox_filters_v4', JSON.stringify(state.filters));
        }
        state.last_hash = null; // reset focus
        build();
        Lampa.Controller.toggle('content');
      };
      filter.onBack = () => this.start();
      filter.onSearch = (v) => search(true, v);
      if (filter.addButtonBack) filter.addButtonBack();

      // Cached-only toggle button
      const toggleMarkup = `
        <span class="torbox-cached-toggle__icon">☁️</span>
        <div class="torbox-cached-toggle__label"></div>
      `;
      cachedToggleBtn = $(
        `<div class="simple-button simple-button--filter selector torbox-cached-toggle" role="button" aria-pressed="false">${toggleMarkup}</div>`
      );
      cachedToggleBtn.on('hover:enter', () => {
          state.show_only_cached = !state.show_only_cached;
          Store.set('torbox_show_only_cached', state.show_only_cached ? '1' : '0');
          build();
          cachedToggleBtn.removeClass('focus');
          lastFocused = null;
          focusState.zone = null;
          focusState.index = 0;
        });
      filter.render().find('.filter--sort').before(cachedToggleBtn);
      updateCachedToggleVisual();

      empty(translate('torbox_loading_initial'));
      search();
    };

    this.start = function () {
      if (Lampa.Activity.active().activity !== this.activity) return;
      Lampa.Background.immediately(Lampa.Utils.cardImgBackgroundBlur(object.movie));
      if (!initialized) {
        initialized = true;
        this.initialize();
      } else {
        build();
        Lampa.Controller.toggle('content');
      }
    };

    this.back = function () {
      if (state.view === 'episodes') {
        state.view = 'torrents';
        filter.render().show();
        revertPendingPlayback();
        build();
      } else {
        cancelActiveTorrentFlow();
        abort.abort();
        Lampa.Activity.backward();
      }
    };

    this.destroy = function () {
      cancelActiveTorrentFlow();
      abort.abort();
      Lampa.Controller.clear('content');
      try {
        if (scroll) scroll.destroy();
        if (files) files.destroy();
        if (filter) filter.destroy();
      } catch {}
      if (debugOverlayEl) {
        debugOverlayEl.remove();
        debugOverlayEl = null;
      }
      if (window.__torbox_active_component === this) {
        window.__torbox_active_component = null;
      }
      scroll = files = filter = lastFocused = null;
    };

    this.pause = function () {};
    this.stop = function () {};

    function updateCachedToggleVisual() {
      if (!cachedToggleBtn) return;
      const on = state.show_only_cached;
      const iconEl = cachedToggleBtn.find('.torbox-cached-toggle__icon');
      const labelEl = cachedToggleBtn.find('.torbox-cached-toggle__label');
      const icon = on ? '⚡' : '☁️';
      const labelKey = on ? 'torbox_cached_toggle_cached' : 'torbox_cached_toggle_all';
      const hintKey = on ? 'torbox_cached_toggle_hint_cached' : 'torbox_cached_toggle_hint_all';
      const labelText = translate(labelKey);
      const hintText = translate(hintKey);

      iconEl.text(icon);
      labelEl.text(labelText);
      cachedToggleBtn
        .toggleClass('torbox-cached-toggle--active', on)
        .attr('title', hintText)
        .attr('aria-label', hintText)
        .attr('aria-pressed', String(on));
    }
  }

  // ───────────────────────────── Integration with Lampa ─────────────────────────────
  (function integrate() {
    let fullListener = null;

    const launchTorBox = (movieData = {}) => {
      const title = movieData.title || movieData.name || '';
      Lampa.Activity.push({
        component: 'torbox_main',
        title: `${Lampa.Lang.translate('title_torbox')} - ${title}`,
        movie: movieData,
      });
    };

    const manifest = {
      type: 'video',
      version: VERSION,
      name: 'TorBox',
      description: translate('torbox_manifest_description'),
      component: 'torbox_main',
      onContextMenu: () => true,
      onContextLauch: (card) => launchTorBox(card || {}),
    };

    // i18n
    Lampa.Lang.add({
      torbox_watch: { ru: 'Смотреть через TorBox', en: 'Watch via TorBox', uk: 'Дивитися через TorBox' },
      title_torbox: { ru: 'TorBox', uk: 'TorBox', en: 'TorBox' },
      torbox_cached_toggle_all: { ru: 'Все торренты', en: 'All torrents', uk: 'Усі торренти' },
      torbox_cached_toggle_cached: { ru: 'Только кешированные', en: 'Cached only', uk: 'Лише кешовані' },
      torbox_cached_toggle_hint_all: { ru: 'Показаны все торренты', en: 'Showing all torrents', uk: 'Показано всі торренти' },
      torbox_cached_toggle_hint_cached: { ru: 'Показаны только кешированные', en: 'Showing cached torrents only', uk: 'Показано лише кешовані торренти' },
      torbox_time_infinite: { ru: '∞', en: '∞', uk: '∞' },
      torbox_time_hours_short: { ru: '{value}ч', en: '{value}h', uk: '{value}год' },
      torbox_time_minutes_short: { ru: '{value}м', en: '{value}m', uk: '{value}хв' },
      torbox_time_seconds_short: { ru: '{value}с', en: '{value}s', uk: '{value}с' },
      torbox_age_seconds: { ru: '{value}с назад', en: '{value}s ago', uk: '{value}с тому' },
      torbox_age_minutes: { ru: '{value}м назад', en: '{value}m ago', uk: '{value}хв тому' },
      torbox_age_hours: { ru: '{value}ч назад', en: '{value}h ago', uk: '{value}год тому' },
      torbox_age_days: { ru: '{value}д назад', en: '{value}d ago', uk: '{value}д тому' },
      torbox_not_available: { ru: 'н/д', en: 'n/a', uk: 'н/д' },
      torbox_error_cors_missing: {
        ru: 'CORS‑прокси не задан. Укажите URL в настройках TorBox.',
        en: 'CORS proxy is not set. Specify the URL in TorBox settings.',
        uk: 'CORS-проксі не задано. Вкажіть URL у налаштуваннях TorBox.',
      },
      torbox_error_api_key_missing: {
        ru: 'API‑ключ TorBox не задан. Введите ключ в настройках TorBox.',
        en: 'TorBox API key is missing. Enter it in TorBox settings.',
        uk: 'API-ключ TorBox не задано. Введіть його в налаштуваннях TorBox.',
      },
      torbox_error_401: {
        ru: '401 – неверный API‑ключ',
        en: '401 – invalid API key',
        uk: '401 – некоректний API-ключ',
      },
      torbox_error_403: {
        ru: '403 – доступ запрещён, проверьте права ключа',
        en: '403 – access denied, check key permissions',
        uk: '403 – доступ заборонено, перевірте права ключа',
      },
      torbox_error_404: {
        ru: '404 – ресурс не найден',
        en: '404 – resource not found',
        uk: '404 – ресурс не знайдено',
      },
      torbox_error_429: {
        ru: '429 – слишком много запросов, попробуйте позже',
        en: '429 – too many requests, try again later',
        uk: '429 – забагато запитів, спробуйте пізніше',
      },
      torbox_error_server: {
        ru: 'Ошибка сервера ({status})',
        en: 'Server error ({status})',
        uk: 'Помилка сервера ({status})',
      },
      torbox_error_request: {
        ru: 'Ошибка запроса ({status})',
        en: 'Request error ({status})',
        uk: 'Помилка запиту ({status})',
      },
      torbox_error_bad_json: {
        ru: 'Некорректный JSON в ответе',
        en: 'Invalid JSON in response',
        uk: 'Некоректний JSON у відповіді',
      },
      torbox_error_api: {
        ru: 'Неизвестная ошибка API',
        en: 'Unknown API error',
        uk: 'Невідома помилка API',
      },
      torbox_error_no_torrent_id: {
        ru: 'ID торрента не получен',
        en: 'Torrent ID was not received',
        uk: 'ID торренту не отримано',
      },
      torbox_error_timeout: {
        ru: 'Таймаут запроса ({seconds} сек)',
        en: 'Request timeout ({seconds} s)',
        uk: 'Тайм-аут запиту ({seconds} с)',
      },
      torbox_error_network: {
        ru: 'Сетевая ошибка',
        en: 'Network error',
        uk: 'Мережева помилка',
      },
      torbox_error_public_parsers_empty: {
        ru: 'Публичные парсеры недоступны или вернули пустой список',
        en: 'Public parsers unavailable or returned no results',
        uk: 'Публічні парсери недоступні або повернули порожній список',
      },
      torbox_error_public_parsers_invalid: {
        ru: 'Публичные парсеры ответили невалидными данными',
        en: 'Public parsers returned invalid data',
        uk: 'Публічні парсери повернули невалідні дані',
      },
      torbox_error_unknown: {
        ru: 'Неизвестная ошибка',
        en: 'Unknown error',
        uk: 'Невідома помилка',
      },
      torbox_error_prefix_auth: { ru: 'Авторизация', en: 'Auth', uk: 'Авторизація' },
      torbox_error_prefix_validation: { ru: 'Проверка настроек', en: 'Validation', uk: 'Перевірка налаштувань' },
      torbox_error_prefix_network: { ru: 'Сеть', en: 'Network', uk: 'Мережа' },
      torbox_error_prefix_api: { ru: 'TorBox', en: 'TorBox', uk: 'TorBox' },
      torbox_error_prefix_generic: { ru: 'Ошибка', en: 'Error', uk: 'Помилка' },
      torbox_no_title: { ru: 'Без названия', en: 'Untitled', uk: 'Без назви' },
      torbox_info_trackers: { ru: 'Трекеры', en: 'Trackers', uk: 'Трекери' },
      torbox_info_added: { ru: 'Добавлено', en: 'Added', uk: 'Додано' },
      torbox_error_no_video_files: {
        ru: 'Видеофайлы не найдены',
        en: 'Video files not found',
        uk: 'Відеофайли не знайдені',
      },
      torbox_error_file_link: {
        ru: 'Не удалось получить ссылку на файл',
        en: 'Failed to obtain file link',
        uk: 'Не вдалося отримати посилання на файл',
      },
      torbox_file_download: {
        ru: 'Ссылка для загрузки',
        en: 'Download link',
        uk: 'Посилання для завантаження',
      },
      torbox_download_link_copied: {
        ru: 'Ссылка для загрузки скопирована',
        en: 'Download link copied',
        uk: 'Посилання для завантаження скопійовано',
      },
      torbox_download_link_copy_failed: {
        ru: 'Ссылка получена, но не скопирована',
        en: 'Download link obtained, but not copied',
        uk: 'Посилання отримано, але не скопійовано',
      },
      torbox_download_link_opened: {
        ru: 'Ссылка открыта и скопирована',
        en: 'Download link opened and copied',
        uk: 'Посилання відкрито та скопійовано',
      },
      torbox_download_preparing: {
        ru: 'TorBox готовит ссылку для загрузки...',
        en: 'TorBox is preparing the download link...',
        uk: 'TorBox готує посилання для завантаження...',
      },
      torbox_download_attempted: {
        ru: 'Попробовали открыть загрузку, ссылка скопирована',
        en: 'Tried to open the download, link copied',
        uk: 'Спробували відкрити завантаження, посилання скопійовано',
      },
      torbox_download_attempted_no_copy: {
        ru: 'Попробовали открыть загрузку',
        en: 'Tried to open the download',
        uk: 'Спробували відкрити завантаження',
      },
      torbox_download_started: {
        ru: 'Загрузка передана системе, ссылка скопирована',
        en: 'Download sent to the system, link copied',
        uk: 'Завантаження передано системі, посилання скопійовано',
      },
      torbox_download_started_no_copy: {
        ru: 'Загрузка передана системе',
        en: 'Download sent to the system',
        uk: 'Завантаження передано системі',
      },
      torbox_error_player_cancelled: {
        ru: 'Воспроизведение отменено',
        en: 'Playback cancelled',
        uk: 'Відтворення скасовано',
      },
      torbox_last_torrent_fallback: {
        ru: 'Последний просмотренный торрент',
        en: 'Last viewed torrent',
        uk: 'Останній переглянутий торрент',
      },
      torbox_continue_watching: { ru: 'Продолжить просмотр', en: 'Continue watching', uk: 'Продовжити перегляд' },
      torbox_continue_info_template: {
        ru: '{icon} {title} • {size} • 🟢 {seeders}',
        en: '{icon} {title} • {size} • 🟢 {seeders}',
        uk: '{icon} {title} • {size} • 🟢 {seeders}',
      },
      torbox_error_aborted: {
        ru: 'Отменено пользователем',
        en: 'Cancelled by user',
        uk: 'Скасовано користувачем',
      },
      torbox_error_torrent_timeout: {
        ru: 'Торрент не найден в TorBox (таймаут)',
        en: 'Torrent not found in TorBox (timeout)',
        uk: 'Торрент не знайдено в TorBox (тайм-аут)',
      },
      torbox_loading_progress: {
        ru: 'Загрузка: {progress}% | {speed} | 👤 {seeds}/{peers} | ⏳ {eta}',
        en: 'Loading: {progress}% | {speed} | 👤 {seeds}/{peers} | ⏳ {eta}',
        uk: 'Завантаження: {progress}% | {speed} | 👤 {seeds}/{peers} | ⏳ {eta}',
      },
      torbox_error_no_magnet: {
        ru: 'Magnet‑ссылка не найдена',
        en: 'Magnet link not found',
        uk: 'Magnet-посилання не знайдено',
      },
      torbox_error_bad_hash: {
        ru: 'Некорректный BTIH‑хеш',
        en: 'Invalid BTIH hash',
        uk: 'Некоректний BTIH-хеш',
      },
      torbox_loading_connect: {
        ru: 'TorBox: Подключение...',
        en: 'TorBox: Connecting...',
        uk: 'TorBox: Підключення...',
      },
      torbox_loading_add: {
        ru: 'TorBox: Добавление магнета...',
        en: 'TorBox: Adding magnet...',
        uk: 'TorBox: Додавання магнету...',
      },
      torbox_loading_wait: {
        ru: 'TorBox: Ожидание загрузки...',
        en: 'TorBox: Waiting for download...',
        uk: 'TorBox: Очікування завантаження...',
      },
      torbox_loading_finalizing: {
        ru: 'TorBox: Загрузка завершена, готовим к запуску…',
        en: 'TorBox: Download complete, preparing to play…',
        uk: 'TorBox: Завантаження завершено, готуємо до запуску…',
      },
      torbox_empty_filters: {
        ru: 'Ничего не найдено по заданным фильтрам',
        en: 'No results for the selected filters',
        uk: 'Нічого не знайдено за вибраними фільтрами',
      },
      torbox_actions_title: { ru: 'Действия', en: 'Actions', uk: 'Дії' },
      torbox_actions_copy_magnet: { ru: 'Скопировать Magnet', en: 'Copy magnet link', uk: 'Скопіювати Magnet' },
      torbox_actions_copied: {
        ru: 'Magnet‑ссылка скопирована',
        en: 'Magnet link copied',
        uk: 'Magnet-посилання скопійовано',
      },
      torbox_empty_list: { ru: 'Торренты не найдены', en: 'No torrents found', uk: 'Торренти не знайдені' },
      torbox_no_results_prompt: {
        ru: 'Нет результатов. Измените фильтры или уточните запрос.',
        en: 'No results. Adjust filters or refine the search.',
        uk: 'Немає результатів. Змініть фільтри або уточніть запит.',
      },
      torbox_filter_all: { ru: 'Все', en: 'All', uk: 'Усі' },
      torbox_filter_refine: { ru: 'Уточнить поиск', en: 'Refine search', uk: 'Уточнити пошук' },
      torbox_filter_quality: { ru: 'Качество', en: 'Quality', uk: 'Якість' },
      torbox_filter_video_type: { ru: 'Тип видео', en: 'Video type', uk: 'Тип відео' },
      torbox_filter_translation: { ru: 'Перевод', en: 'Voiceover', uk: 'Озвучення' },
      torbox_filter_audio_lang: { ru: 'Язык аудио', en: 'Audio language', uk: 'Мова аудіо' },
      torbox_filter_video_codec: { ru: 'Видео кодек', en: 'Video codec', uk: 'Відеокодек' },
      torbox_filter_audio_codec: { ru: 'Аудио кодек', en: 'Audio codec', uk: 'Аудіокодек' },
      torbox_filter_tracker: { ru: 'Трекер', en: 'Tracker', uk: 'Трекер' },
      torbox_filter_reset: { ru: 'Сбросить фильтры', en: 'Reset filters', uk: 'Скинути фільтри' },
      torbox_filter_refresh: { ru: 'Обновить список', en: 'Refresh list', uk: 'Оновити список' },
      torbox_filter_title: { ru: 'Фильтр', en: 'Filter', uk: 'Фільтр' },
      torbox_sort_seeders_desc: { ru: 'По сидам (убыв.)', en: 'Seeders (desc)', uk: 'За сідами (спадання)' },
      torbox_sort_size_desc: { ru: 'По размеру (убыв.)', en: 'Size (desc)', uk: 'За розміром (спадання)' },
      torbox_sort_size_asc: { ru: 'По размеру (возр.)', en: 'Size (asc)', uk: 'За розміром (зростання)' },
      torbox_sort_age: { ru: 'По дате добавления', en: 'Recently added', uk: 'За датою додавання' },
      torbox_sort_title: { ru: 'Сортировка', en: 'Sorting', uk: 'Сортування' },
      torbox_search_custom: { ru: 'Поиск: «{query}»…', en: 'Searching for “{query}”…', uk: 'Пошук: «{query}»…' },
      torbox_search_fetching: { ru: 'Получение списка…', en: 'Fetching list…', uk: 'Отримання списку…' },
      torbox_search_parser_empty: {
        ru: 'Парсер не вернул результатов.',
        en: 'Parser returned no results.',
        uk: 'Парсер не повернув результатів.',
      },
      torbox_search_no_valid_hashes: {
        ru: 'Не найдено валидных BTIH‑хешей (hex/base32).',
        en: 'No valid BTIH hashes found (hex/base32).',
        uk: 'Не знайдено валідних BTIH-хешів (hex/base32).',
      },
      torbox_search_no_valid_results: {
        ru: 'Результаты без валидных BTIH‑хешей.',
        en: 'Results contain no valid BTIH hashes.',
        uk: 'Результати без валідних BTIH-хешів.',
      },
      torbox_check_cache_progress: {
        ru: 'Проверка кэша ({count})…',
        en: 'Checking cache ({count})…',
        uk: 'Перевірка кешу ({count})…',
      },
      torbox_generic_error: { ru: 'Ошибка', en: 'Error', uk: 'Помилка' },
      torbox_refine_not_enough_data: {
        ru: 'Недостаточно данных для уточнения запроса',
        en: 'Not enough data to refine the query',
        uk: 'Недостатньо даних для уточнення запиту',
      },
      torbox_refine_title: { ru: 'Уточнить поиск', en: 'Refine search', uk: 'Уточнити пошук' },
      torbox_refine_tag_original: { ru: 'Оригинал', en: 'Original', uk: 'Оригінал' },
      torbox_refine_tag_translation: { ru: 'Перевод', en: 'Translation', uk: 'Переклад' },
      torbox_refine_tag_alt: { ru: 'Альтернативное название', en: 'Alternate title', uk: 'Альтернативна назва' },
      torbox_refine_tag_year: { ru: 'Год', en: 'Year', uk: 'Рік' },
      torbox_refine_tag_season: { ru: 'Сезон', en: 'Season', uk: 'Сезон' },
      torbox_refine_tag_episode: { ru: 'Эпизод', en: 'Episode', uk: 'Епізод' },
      torbox_refine_tag_keyword: { ru: 'Ключевое слово', en: 'Keyword', uk: 'Ключове слово' },
      torbox_refine_tag_id: { ru: 'Идентификатор', en: 'Identifier', uk: 'Ідентифікатор' },
      torbox_refine_tag_mix: { ru: 'Комбинация', en: 'Combination', uk: 'Комбінація' },
      torbox_loading_initial: { ru: 'Загрузка...', en: 'Loading...', uk: 'Завантаження...' },
      torbox_manifest_description: {
        ru: 'Плагин для просмотра торрентов через TorBox',
        en: 'TorBox plugin for streaming torrents',
        uk: 'Плагін для перегляду торрентів через TorBox',
      },
      torbox_settings_proxy_name: { ru: 'URL CORS‑прокси', en: 'CORS proxy URL', uk: 'URL CORS-проксі' },
      torbox_settings_proxy_desc: {
        ru: 'Введите URL прокси, через который будут идти ВСЕ запросы',
        en: 'Enter the proxy URL that will handle ALL requests',
        uk: 'Введіть URL проксі, через який підуть УСІ запити',
      },
      torbox_settings_api_name: { ru: 'API‑ключ', en: 'API key', uk: 'API-ключ' },
      torbox_settings_api_desc: {
        ru: 'Введите ваш API‑ключ от TorBox',
        en: 'Enter your TorBox API key',
        uk: 'Введіть свій API-ключ TorBox',
      },
      torbox_settings_debug_name: { ru: 'Debug‑режим', en: 'Debug mode', uk: 'Debug-режим' },
      torbox_settings_debug_desc: {
        ru: 'Подробные логи в консоль',
        en: 'Detailed logs in console',
        uk: 'Детальні логи у консолі',
      },
      torbox_settings_retries_name: {
        ru: 'Повторы отслеживания',
        en: 'Tracking retries',
        uk: 'Повтори відстеження',
      },
      torbox_settings_retries_desc: {
        ru: 'Сколько раз запрашивать статус торрента перед тайм-аутом (3–120 попыток).',
        en: 'How many status polling attempts to perform before timing out (3–120 attempts).',
        uk: 'Скільки разів опитувати статус торрента перед тайм-аутом (3–120 спроб).',
      },
      torbox_settings_interval_name: {
        ru: 'Интервал отслеживания (мс)',
        en: 'Tracking interval (ms)',
        uk: 'Інтервал відстеження (мс)',
      },
      torbox_settings_interval_desc: {
        ru: 'Задержка между запросами статуса торрента. Допустимо от 3000 до 60000 мс.',
        en: 'Delay between status polling requests. Allowed range: 3000–60000 ms.',
        uk: 'Затримка між запитами статусу торрента. Допустимий діапазон: 3000–60000 мс.',
      },
      torbox_settings_video_ext_name: {
        ru: 'Видео-расширения',
        en: 'Video extensions',
        uk: 'Відеорозширення',
      },
      torbox_settings_video_ext_desc: {
        ru: 'Список допустимых расширений через запятую. Пустое значение вернёт настройки по умолчанию.',
        en: 'Comma-separated list of allowed extensions. Leave empty to restore defaults.',
        uk: 'Список дозволених розширень через кому. Порожнє значення поверне налаштування за замовчуванням.',
      },
      torbox_settings_custom_parsers_name: {
        ru: 'Пользовательские парсеры',
        en: 'Custom parsers',
        uk: 'Користувацькі парсери',
      },
      torbox_settings_custom_parsers_desc: {
        ru: 'Список доменов (через запятую) для поиска. Добавляются перед публичными.',
        en: 'Comma-separated list of domains for search. Added before public ones.',
        uk: 'Список доменів (через кому) для пошуку. Додаються перед публічними.',
      },
      torbox_settings_default_cached_name: {
        ru: 'По умолчанию: только кеш',
        en: 'Default: cached only',
        uk: 'За замовчуванням: лише кеш',
      },
      torbox_settings_default_cached_desc: {
        ru: 'Если включено, новый экран TorBox стартует в режиме только кешированных торрентов.',
        en: 'If enabled, TorBox starts with cached-only mode on.',
        uk: 'Якщо увімкнено, TorBox стартує у режимі лише кешованих торрентів.',
      },
      torbox_settings_permanent_link_name: {
        ru: 'Предпочитать permanent link',
        en: 'Prefer permanent link',
        uk: 'Надавати перевагу permanent link',
      },
      torbox_settings_permanent_link_desc: {
        ru: 'Пробовать requestdl с redirect=true и откатываться на обычный режим при ошибке.',
        en: 'Try requestdl with redirect=true and fallback to classic mode on failure.',
        uk: 'Пробувати requestdl з redirect=true і відкотитись на класичний режим при помилці.',
      },
      torbox_settings_auto_pick_name: {
        ru: 'Автовыбор файла (фильмы)',
        en: 'Auto-pick file (movies)',
        uk: 'Автовибір файла (фільми)',
      },
      torbox_settings_auto_pick_desc: {
        ru: 'Для фильмов выбирать лучший видеофайл автоматически (крупнейший, без sample/trailer).',
        en: 'For movies, auto-select the best video file (largest, excluding sample/trailer).',
        uk: 'Для фільмів автообирати найкращий відеофайл (найбільший, без sample/trailer).',
      },
      torbox_settings_quality_order_name: {
        ru: 'Приоритет качества',
        en: 'Quality priority',
        uk: 'Пріоритет якості',
      },
      torbox_settings_quality_order_desc: {
        ru: 'Порядок через запятую: 4K,FHD,HD,SD. Используется как tie-break при сортировке.',
        en: 'Comma-separated order: 4K,FHD,HD,SD. Used as tie-break during sorting.',
        uk: 'Порядок через кому: 4K,FHD,HD,SD. Використовується як tie-break під час сортування.',
      },
      torbox_settings_audio_langs_name: {
        ru: 'Предпочтительные языки аудио',
        en: 'Preferred audio languages',
        uk: 'Бажані мови аудіо',
      },
      torbox_settings_audio_langs_desc: {
        ru: 'Список кодов через запятую (например: RU,EN,UK).',
        en: 'Comma-separated language codes (for example: RU,EN,UK).',
        uk: 'Список кодів через кому (наприклад: RU,EN,UK).',
      },
      torbox_settings_video_codecs_name: {
        ru: 'Предпочтительные видео кодеки',
        en: 'Preferred video codecs',
        uk: 'Бажані відеокодеки',
      },
      torbox_settings_video_codecs_desc: {
        ru: 'Список кодеков через запятую (например: HEVC,AV1,H264).',
        en: 'Comma-separated codecs (for example: HEVC,AV1,H264).',
        uk: 'Список кодеків через кому (наприклад: HEVC,AV1,H264).',
      },
      torbox_settings_excluded_trackers_name: {
        ru: 'Исключить трекеры',
        en: 'Exclude trackers',
        uk: 'Виключити трекери',
      },
      torbox_settings_excluded_trackers_desc: {
        ru: 'Трекеры через запятую будут исключены из результатов.',
        en: 'Comma-separated trackers will be excluded from results.',
        uk: 'Трекери через кому будуть виключені з результатів.',
      },
      torbox_settings_debug_overlay_name: {
        ru: 'Debug overlay',
        en: 'Debug overlay',
        uk: 'Debug overlay',
      },
      torbox_settings_debug_overlay_desc: {
        ru: 'Показывать на экране текущую зону/индекс фокуса и selector.',
        en: 'Show current focus zone/index and selector on screen.',
        uk: 'Показувати на екрані поточну зону/індекс фокуса та selector.',
      },
      torbox_settings_export_diag_name: {
        ru: 'Экспорт диагностики',
        en: 'Export diagnostics',
        uk: 'Експорт діагностики',
      },
      torbox_settings_export_diag_desc: {
        ru: 'Скопировать JSON-отчет (версия, настройки без ключа, последний error, последние логи).',
        en: 'Copy JSON report (version, settings without key, last error, recent logs).',
        uk: 'Скопіювати JSON-звіт (версія, налаштування без ключа, остання помилка, останні логи).',
      },
      torbox_diag_copied: {
        ru: 'Диагностика скопирована в буфер обмена',
        en: 'Diagnostics copied to clipboard',
        uk: 'Діагностику скопійовано у буфер обміну',
      },
      torbox_diag_copy_failed: {
        ru: 'Не удалось скопировать диагностику',
        en: 'Failed to copy diagnostics',
        uk: 'Не вдалося скопіювати діагностику',
      },
    });

    // Templates used by the component
    function addTemplates() {
      Lampa.Template.add(
        'torbox_item',
        '<div class="torbox-item selector" data-hash="{hash}">' +
          '<div class="torbox-item__title">{last_played_icon}{icon} {title}</div>' +
          '<div class="torbox-item__main-info">{info_formated}</div>' +
          '<div class="torbox-item__meta">{meta_formated}</div>' +
          '{tech_bar_html}' +
        '</div>'
      );
      Lampa.Template.add('torbox_empty', '<div class="empty"><div class="empty__text">{message}</div></div>');
      Lampa.Template.add(
        'torbox_watched_item',
        '<div class="torbox-watched-item selector">' +
          '<div class="torbox-watched-item__icon"><svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14.5V7.5l5.25 3.5L11 16.5z" fill="currentColor"></path></svg></div>' +
          '<div class="torbox-watched-item__body">' +
            '<div class="torbox-watched-item__title">{title}</div>' +
            '<div class="torbox-watched-item__info">{info}</div>' +
          '</div>' +
        '</div>'
      );
      Lampa.Template.add(
        'torbox_episode_item',
        '<div class="torbox-file-item selector" data-file-id="{file_id}">' +
          '<div class="torbox-file-item__body">' +
            '<div class="torbox-file-item__title">{title}</div>' +
            '<div class="torbox-file-item__subtitle">{size}</div>' +
          '</div>' +
          '<div class="torbox-file-download selector" role="button" aria-label="{download_label}">⬇</div>' +
        '</div>'
      );
    }

    // Settings (keeps original keys and public surface)
    function addSettings() {
      if (!Lampa.SettingsApi) return;
      Lampa.SettingsApi.addComponent({ component: 'torbox_enh', name: 'TorBox', icon: ICON });

      const params = [
        {
          key: 'torbox_proxy_url',
          name: translate('torbox_settings_proxy_name'),
          desc: translate('torbox_settings_proxy_desc'),
          type: 'input',
          default: DEFAULT_PROXY_URL,
          get: () => Config.proxyUrl,
          set: (v) => (Config.proxyUrl = String(v || '').trim()),
        },
        {
          key: 'torbox_api_key',
          name: translate('torbox_settings_api_name'),
          desc: translate('torbox_settings_api_desc'),
          type: 'input',
          default: '',
          get: () => Config.apiKey,
          set: (v) => (Config.apiKey = String(v || '').trim()),
          mask: true,
        },
      ];

      params.forEach((p) => {
        let currentField = null;
        Lampa.SettingsApi.addParam({
          component: 'torbox_enh',
          param: { name: p.key, type: p.type, values: '', default: p.default },
          field: { name: p.name, description: p.desc },
          onChange: (v) => {
            const value = typeof v === 'object' ? v.value : v;
            const sanitized = p.set ? p.set(value) : value;
            if (currentField && currentField.length) {
              const input = currentField.find('input');
              if (input.length) input.val(p.get());
            }
            return sanitized;
          },
          onRender: (field) => {
            currentField = field;
            const input = field.find('input');
            if (input.length) {
              input.val(p.get());
              if (p.mask) input.attr('type', 'password');
              if (p.inputmode) input.attr('inputmode', p.inputmode);
              if (p.placeholder) input.attr('placeholder', p.placeholder);
            }
            if (typeof p.render === 'function') p.render(field);
          },
        });
      });
    }

    function boot() {
      Lampa.Component.add('torbox_main', MainComponent);
      addTemplates();
      addSettings();

      if (fullListener) Lampa.Listener.remove('full', fullListener);
      fullListener = (e) => {
        if (e.type !== 'complite' || !e.data?.movie) return;
        const root = e.object?.activity?.render?.();
        if (!root?.length || root.find('.view--torbox').length) return;

        const btn = $(
          `<div class="full-start__button selector view--torbox" data-subtitle="TorBox">${ICON}<span>TorBox</span></div>`
        );
        btn.on('hover:enter', () => launchTorBox(e.data.movie || {}));

        const torrentBtn = root.find('.view--torrent');
        torrentBtn.length ? torrentBtn.after(btn) : root.find('.full-start__play').after(btn);
      };
      Lampa.Listener.follow('full', fullListener);

      // Scoped styles (inject once)
      if (!document.getElementById('torbox-stable-styles')) {
        const css = document.createElement('style');
        css.id = 'torbox-stable-styles';
        css.textContent = `
          .torbox-list-container { display:block; padding:1em; }
          .torbox-item { position:relative; padding:1em 1.2em; margin:0 0 1em 0; border-radius:.8em; background: var(--color-background-light); cursor:pointer; transition:.25s; border:2px solid transparent; overflow:hidden; }
          .torbox-item:last-child { margin-bottom:0; }
          .torbox-item:hover, .torbox-item.focus,
          .torbox-watched-item:hover, .torbox-watched-item.focus,
          .torbox-file-item:hover, .torbox-file-item.focus {
            background:var(--color-primary); color:var(--color-background); transform:translateY(-1px); border-color:rgba(255,255,255,.28);
            box-shadow:0 6px 24px rgba(0,0,0,.18);
          }
          .torbox-item__title { font-weight:600; margin-bottom:.35em; font-size:1.05em; line-height:1.35; display:flex; align-items:center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
          .torbox-item__last-played-icon { display:inline-flex; width:1.1em; height:1.1em; margin-right:.5em; color:var(--color-second); }
          .torbox-item__last-played-icon svg{ width:100%; height:100%; }
          .torbox-item__main-info { font-size:.95em; opacity:.95; line-height:1.4; margin-bottom:.25em; }
          .torbox-item__meta { font-size:.88em; opacity:.75; line-height:1.4; margin-bottom:.7em; }
          .torbox-item__progress { position:absolute; left:0; right:0; bottom:0; height:3px; background:rgba(255,255,255,.22); }
          .torbox-item__progress > div { height:100%; background:var(--color-primary); }
          .torbox-item__tech-bar { display:flex; flex-wrap:wrap; gap:.55em; margin:0 -1.2em -1em; padding:.6em 1.2em; background:rgba(0,0,0,.08); font-size:.84em; font-weight:500; transition:background .2s; }
          .torbox-item__tech-item { padding:.22em .55em; border-radius:.4em; color:#fff; }
          .torbox-item__tech-item--res { background:#3b82f6; }
          .torbox-item__tech-item--codec { background:#16a34a; }
          .torbox-item__tech-item--audio { background:#f97316; }
          .torbox-item__tech-item--hdr { background:linear-gradient(45deg,#ff8c00,#ffa500); }
          .torbox-item__tech-item--dv  { background:linear-gradient(45deg,#4b0082,#8a2be2); }
          .torbox-cached-toggle { display:inline-flex; align-items:center; justify-content:center; border:2px solid transparent; transition:.2s; gap:.5em; padding:0 .8em; min-height:2.5em; }
          .torbox-cached-toggle__icon { font-size:1.5em; line-height:1; }
          .torbox-cached-toggle__label { font-size:.85em; font-weight:500; white-space:nowrap; }
          .torbox-cached-toggle.focus, .torbox-cached-toggle:hover {
            background:var(--color-primary); color:var(--color-background); border-color:rgba(255,255,255,.28);
          }
          /* "Cached only" engaged: subtle accent border, NOT the selection fill, so it
             is not mistaken for keyboard focus (the ⚡ icon + label already show state). */
          .torbox-cached-toggle.torbox-cached-toggle--active:not(.focus):not(:hover) {
            border-color:var(--color-second);
          }
          .torbox-file-item { display:flex; justify-content:space-between; align-items:center; gap:1em; padding:1em 1.2em; margin-bottom:1em; border-radius:.8em; background:var(--color-background-light); transition:.25s; border:2px solid transparent; }
          .torbox-file-item__body { min-width:0; flex:1 1 auto; }
          .torbox-file-item__title { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
          .torbox-file-item__subtitle { font-size:.9em; opacity:.75; }
          .torbox-file-download { flex:0 0 2.4em; width:2.4em; height:2.4em; display:flex; align-items:center; justify-content:center; border-radius:.5em; border:2px solid rgba(255,255,255,.18); background:rgba(0,0,0,.12); color:inherit; font-size:1.05em; line-height:1; }
          .torbox-file-download:hover, .torbox-file-download.focus { background:var(--color-second); color:var(--color-background); border-color:rgba(255,255,255,.35); }
          .torbox-file-download--loading { opacity:.55; pointer-events:none; }
          .torbox-file-item--last-played { border-left:4px solid var(--color-second); }
          .torbox-file-item--watched { color:#8a8a8a; }
          .torbox-watched-item { display:flex; align-items:center; padding:1em; margin-bottom:1em; border-radius:.8em; background:var(--color-background-light); border-left:4px solid var(--color-second); transition:.25s; border:2px solid transparent; }
          .torbox-watched-item__icon { flex-shrink:0; margin-right:1em; }
          .torbox-watched-item__icon svg{ width:2em; height:2em; }
          .torbox-watched-item__title { font-weight:600; }
          .torbox-watched-item__info { font-size:.9em; opacity:.75; }
        `;
        document.head.appendChild(css);
      }

      try {
        const plugins = Lampa?.Manifest?.plugins;
        const alreadyRegistered = Array.isArray(plugins)
          ? plugins.some((plugin) => plugin && plugin.name === manifest.name)
          : false;
        if (!alreadyRegistered) {
          Lampa.Manifest.plugins = manifest;
        }
      } catch (e) {
        // Fallback for non-standard builds where plugins setter is unavailable.
        LOG('Manifest registration fallback', e?.message || e);
        try {
          Lampa.Manifest.plugins[manifest.name] = manifest;
        } catch {}
      }
      LOG('TorBox plugin ready', manifest.version);
    }

    if (window.Lampa?.Activity) {
      boot();
    } else {
      const bootOnce = Lampa.Listener.follow('app', (e) => {
        if (e.type === 'ready') {
          boot();
          Lampa.Listener.remove('app', bootOnce);
        }
      });
    }
  })();
})();
} catch (torboxFatalError) {
  try {
    console.error('[TorBox] fatal boot error', torboxFatalError);
  } catch {}
  try {
    const msg = torboxFatalError && torboxFatalError.stack ? torboxFatalError.stack : String(torboxFatalError);
    localStorage.setItem('torbox_boot_error', msg);
  } catch {}
  try {
    if (window.Lampa?.Noty) {
      Lampa.Noty.show('TorBox boot error: ' + (torboxFatalError?.message || torboxFatalError), { type: 'error' });
    }
  } catch {}
}
