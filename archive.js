'use strict';

const axios = require('axios');

const ARCHIVE_BASE_URL = 'https://archive.org';
const S3_ENDPOINT = 'https://s3.us.archive.org';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta';

// Video extensions supported by Stremio
const SUPPORTED_VIDEO_EXTS = ['.mp4', '.mkv', '.webm', '.ogv'];

// Ignored filename suffixes (e.g., metadata, wave forms, thumbnails)
const IGNORED_SUFFIXES = [
  '_thumb',
  '_spectrogram',
  '_waveform',
  '_meta',
  '_files',
  '_itemimage',
  '.sample'
];

/**
 * In-memory TTL Cache with maximum size to avoid unbounded memory growth.
 */
class MemoryCache {
  constructor(defaultTtlMs = 30 * 60 * 1000, maxSize = 1000) {
    this.defaultTtlMs = defaultTtlMs;
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key, value, ttlMs = this.defaultTtlMs) {
    if (this.cache.size >= this.maxSize) {
      // Evict oldest entry
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttlMs
    });
  }

  clear() {
    this.cache.clear();
  }
}

/**
 * Queue-based Rate Limiter to respect Archive.org API limits.
 */
class RateLimiter {
  constructor(minDelayMs = 150, maxConcurrent = 5) {
    this.minDelayMs = minDelayMs;
    this.maxConcurrent = maxConcurrent;
    this.currentConcurrent = 0;
    this.lastRequestTime = 0;
    this.queue = [];
  }

  async acquire() {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this._processQueue();
    });
  }

  _processQueue() {
    if (this.queue.length === 0 || this.currentConcurrent >= this.maxConcurrent) {
      return;
    }

    const now = Date.now();
    const timeSinceLast = now - this.lastRequestTime;
    const delay = Math.max(0, this.minDelayMs - timeSinceLast);

    setTimeout(() => {
      if (this.queue.length === 0 || this.currentConcurrent >= this.maxConcurrent) {
        return;
      }
      this.currentConcurrent++;
      this.lastRequestTime = Date.now();
      const resolve = this.queue.shift();
      resolve(() => {
        this.currentConcurrent--;
        this._processQueue();
      });
    }, delay);
  }
}

/**
 * Archive.org Scraper & Authenticated API Client
 */
class ArchiveClient {
  constructor(options = {}) {
    this.cache = new MemoryCache(options.cacheTtl || 30 * 60 * 1000, options.cacheMaxSize || 1000);
    this.rateLimiter = new RateLimiter(options.rateLimitDelay || 150, options.maxConcurrent || 5);
    this.maxRetries = options.maxRetries || 3;
    this.baseDelay = options.baseDelay || 500;
    this.timeout = options.timeout || 12000;
  }

  /**
   * Constructs the appropriate authentication header object for Archive.org.
   * Format for S3: { 'Authorization': 'LOW <access_key>:<secret_key>' }
   * Format for Cookies: { 'Cookie': 'logged_in_user=<user>; logged_in_sig=<sig>' }
   *
   * @param {Object} authConfig
   * @returns {Object} Headers dictionary
   */
  getAuthHeaders(authConfig = {}) {
    const headers = {
      'User-Agent': 'Stremio-ArchiveOrg-Addon/1.0 (+https://github.com/stremio)'
    };

    if (!authConfig) return headers;

    // Check S3 API Keys
    const accessKey = authConfig.access_key || authConfig.accessKey;
    const secretKey = authConfig.secret_key || authConfig.secretKey;
    if (accessKey && secretKey) {
      headers['Authorization'] = `LOW ${String(accessKey).trim()}:${String(secretKey).trim()}`;
      return headers;
    }

    // Check Session Cookies
    const loggedInUser = authConfig.logged_in_user || authConfig.loggedInUser;
    const loggedInSig = authConfig.logged_in_sig || authConfig.loggedInSig;
    if (loggedInUser && loggedInSig) {
      headers['Cookie'] = `logged_in_user=${encodeURIComponent(String(loggedInUser).trim())}; logged_in_sig=${encodeURIComponent(String(loggedInSig).trim())}`;
      return headers;
    }

    return headers;
  }

  /**
   * Extracts headers formatted specifically for Stremio's behaviorHints.proxyHeaders.request.
   *
   * @param {Object} authConfig
   * @returns {Object|null}
   */
  getProxyHeaders(authConfig = {}) {
    if (!authConfig) return null;

    const accessKey = authConfig.access_key || authConfig.accessKey;
    const secretKey = authConfig.secret_key || authConfig.secretKey;
    if (accessKey && secretKey) {
      return {
        Authorization: `LOW ${String(accessKey).trim()}:${String(secretKey).trim()}`
      };
    }

    const loggedInUser = authConfig.logged_in_user || authConfig.loggedInUser;
    const loggedInSig = authConfig.logged_in_sig || authConfig.loggedInSig;
    if (loggedInUser && loggedInSig) {
      return {
        Cookie: `logged_in_user=${encodeURIComponent(String(loggedInUser).trim())}; logged_in_sig=${encodeURIComponent(String(loggedInSig).trim())}`
      };
    }

    return null;
  }

  /**
   * Performs an HTTP request with rate limiting and exponential backoff retry.
   *
   * @param {Object} config - Axios request config
   * @returns {Promise<any>}
   */
  async requestWithRetry(config) {
    let attempt = 0;

    while (attempt <= this.maxRetries) {
      const release = await this.rateLimiter.acquire();
      try {
        console.log(`[ArchiveClient] Requesting: ${config.method || 'GET'} ${config.url}`);
        const response = await axios({
          ...config,
          timeout: this.timeout,
          validateStatus: (status) => status < 500 && status !== 429
        });

        release();

        if (response.status === 429) {
          throw { response, isRateLimit: true, message: 'Too Many Requests (429)' };
        }

        return response.data;
      } catch (err) {
        release();
        attempt++;

        const isRateLimit = err.isRateLimit || (err.response && err.response.status === 429);
        const isServerError = err.response && (err.response.status === 503 || err.response.status === 502 || err.response.status === 504);
        const isNetworkErr = err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND' || err.message.includes('timeout');

        if ((isRateLimit || isServerError || isNetworkErr) && attempt <= this.maxRetries) {
          let retryDelay = this.baseDelay * Math.pow(2, attempt) + Math.random() * 200;

          // Check if server sent a Retry-After header
          if (err.response && err.response.headers && err.response.headers['retry-after']) {
            const serverDelay = parseInt(err.response.headers['retry-after'], 10);
            if (!isNaN(serverDelay)) {
              retryDelay = serverDelay * 1000;
            }
          }

          console.warn(`[ArchiveClient] Retryable error (${err.message}) on ${config.url}. Retrying attempt ${attempt}/${this.maxRetries} in ${Math.round(retryDelay)}ms...`);
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
          continue;
        }

        console.error(`[ArchiveClient] Request failed after ${attempt} attempts: ${config.url}`, err.message);
        throw err;
      }
    }
  }

  /**
   * Validates user credentials against Archive.org.
   *
   * @param {Object} authConfig
   * @returns {Promise<{valid: boolean, message: string}>}
   */
  async validateCredentials(authConfig = {}) {
    const accessKey = authConfig.access_key || authConfig.accessKey;
    const secretKey = authConfig.secret_key || authConfig.secretKey;
    const loggedInUser = authConfig.logged_in_user || authConfig.loggedInUser;
    const loggedInSig = authConfig.logged_in_sig || authConfig.loggedInSig;

    // Guest / Anonymous check
    if (!accessKey && !secretKey && !loggedInUser && !loggedInSig) {
      return { valid: true, message: 'Guest / Anonymous mode (No credentials specified).' };
    }

    if (accessKey || secretKey) {
      if (!accessKey || !secretKey) {
        return { valid: false, message: 'Both access_key and secret_key are required for S3 authentication.' };
      }

      try {
        // Test S3 credentials by probing S3 endpoint with user authorization header
        const res = await axios.get(`${S3_ENDPOINT}/`, {
          headers: {
            Authorization: `LOW ${String(accessKey).trim()}:${String(secretKey).trim()}`
          },
          timeout: 8000,
          validateStatus: null
        });

        // 403 with InvalidAccessKeyId or SignatureDoesNotMatch indicates invalid keys
        if (res.status === 403 && typeof res.data === 'string' && (res.data.includes('InvalidAccessKeyId') || res.data.includes('SignatureDoesNotMatch'))) {
          return { valid: false, message: 'Invalid S3 credentials. Archive.org rejected the access/secret key.' };
        }

        return { valid: true, message: 'S3 API credentials verified successfully.' };
      } catch (err) {
        return { valid: false, message: `Could not reach Archive.org S3 endpoint: ${err.message}` };
      }
    }

    if (loggedInUser || loggedInSig) {
      if (!loggedInUser || !loggedInSig) {
        return { valid: false, message: 'Both logged_in_user and logged_in_sig are required for cookie authentication.' };
      }

      try {
        const res = await axios.get(`${ARCHIVE_BASE_URL}/account/`, {
          headers: {
            Cookie: `logged_in_user=${encodeURIComponent(String(loggedInUser).trim())}; logged_in_sig=${encodeURIComponent(String(loggedInSig).trim())}`
          },
          maxRedirects: 0,
          timeout: 8000,
          validateStatus: null
        });

        // If cookies are completely invalid, Archive.org redirects to /account/login
        if (res.status === 302 && res.headers.location && res.headers.location.includes('/account/login')) {
          return { valid: false, message: 'Session cookies rejected or expired. Please re-login on Archive.org.' };
        }

        return { valid: true, message: 'Archive.org session cookies verified successfully.' };
      } catch (err) {
        return { valid: false, message: `Could not verify cookies: ${err.message}` };
      }
    }

    return { valid: true, message: 'Credentials verified.' };
  }

  /**
   * Searches Archive.org using the Advanced Search API.
   *
   * @param {string} query - Solr-style query
   * @param {Object} options - Pagination and field options
   * @param {Object} authConfig - User authentication config
   * @returns {Promise<Array>} Array of doc items
   */
  async search(query, options = {}, authConfig = {}) {
    const page = options.page || 1;
    const rows = options.rows || 20;
    const sort = options.sort || 'downloads desc';
    const fields = options.fields || ['identifier', 'title', 'year', 'description', 'downloads', 'mediatype', 'publicdate'];

    const cacheKey = `search:${query}:${page}:${rows}:${sort}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      console.log(`[ArchiveClient] Cache hit for search query: ${query}`);
      return cached;
    }

    const params = new URLSearchParams();
    params.set('q', query);
    fields.forEach((f) => params.append('fl[]', f));
    params.set('sort[]', sort);
    params.set('rows', String(rows));
    params.set('page', String(page));
    params.set('output', 'json');

    const searchUrl = `${ARCHIVE_BASE_URL}/advancedsearch.php?${params.toString()}`;
    const headers = this.getAuthHeaders(authConfig);

    try {
      const data = await this.requestWithRetry({
        method: 'GET',
        url: searchUrl,
        headers
      });

      const docs = (data && data.response && Array.isArray(data.response.docs)) ? data.response.docs : [];
      this.cache.set(cacheKey, docs, 15 * 60 * 1000); // 15 mins cache
      return docs;
    } catch (err) {
      console.error(`[ArchiveClient] Advanced search failed for query "${query}":`, err.message);
      return [];
    }
  }

  /**
   * Fetches full metadata and file list for an Archive.org item identifier.
   *
   * @param {string} identifier - Item identifier
   * @param {Object} authConfig - User credentials
   * @returns {Promise<Object>}
   */
  async getMetadata(identifier, authConfig = {}) {
    if (!identifier) return null;

    const cacheKey = `meta:${identifier}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      console.log(`[ArchiveClient] Cache hit for metadata: ${identifier}`);
      return cached;
    }

    const metaUrl = `${ARCHIVE_BASE_URL}/metadata/${encodeURIComponent(identifier)}`;
    const headers = this.getAuthHeaders(authConfig);

    try {
      const data = await this.requestWithRetry({
        method: 'GET',
        url: metaUrl,
        headers
      });

      if (!data || !data.metadata) {
        console.warn(`[ArchiveClient] No metadata found for identifier: ${identifier}`);
        return null;
      }

      this.cache.set(cacheKey, data, 30 * 60 * 1000); // 30 mins cache
      return data;
    } catch (err) {
      console.error(`[ArchiveClient] Failed to retrieve metadata for "${identifier}":`, err.message);
      return null;
    }
  }

  /**
   * Helper to determine video quality resolution and priority rank.
   *
   * @param {Object} file - Archive.org file object
   * @returns {{label: string, rank: number}}
   */
  detectQuality(file) {
    const height = parseInt(file.height, 10);
    const width = parseInt(file.width, 10);
    const name = (file.name || '').toLowerCase();
    const format = (file.format || '').toLowerCase();

    // Direct height matching
    if (!isNaN(height) && height > 0) {
      if (height >= 2160) return { label: '4K', rank: 6 };
      if (height >= 1080) return { label: '1080p', rank: 5 };
      if (height >= 720) return { label: '720p', rank: 4 };
      if (height >= 480) return { label: '480p', rank: 3 };
      if (height >= 360) return { label: '360p', rank: 2 };
      if (height >= 240) return { label: '240p', rank: 1 };
      return { label: `${height}p`, rank: 1 };
    }

    // Width matching fallback
    if (!isNaN(width) && width > 0) {
      if (width >= 3840) return { label: '4K', rank: 6 };
      if (width >= 1920) return { label: '1080p', rank: 5 };
      if (width >= 1280) return { label: '720p', rank: 4 };
      if (width >= 720) return { label: '480p', rank: 3 };
    }

    // Filename / Format heuristics
    if (name.includes('2160p') || name.includes('4k')) return { label: '4K', rank: 6 };
    if (name.includes('1080p')) return { label: '1080p', rank: 5 };
    if (name.includes('720p')) return { label: '720p', rank: 4 };
    if (name.includes('480p') || name.includes('dvd') || format.includes('dvd')) return { label: '480p', rank: 3 };
    if (name.includes('360p')) return { label: '360p', rank: 2 };
    if (name.includes('240p') || format.includes('512kb')) return { label: '240p', rank: 1 };

    return { label: 'SD', rank: 0 };
  }

  /**
   * Formats file size in human-readable bytes (MB or GB).
   *
   * @param {number|string} bytes
   * @returns {string}
   */
  formatBytes(bytes) {
    if (!bytes || isNaN(bytes)) return '';
    const b = parseInt(bytes, 10);
    if (b >= 1024 * 1024 * 1024) return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(0)} MB`;
    return `${(b / 1024).toFixed(0)} KB`;
  }

  /**
   * Filters and builds Stremio stream objects from Archive.org files.
   *
   * @param {string} identifier - Item identifier
   * @param {Object} authConfig - User credentials
   * @param {string} [titleOverride] - Custom movie or episode title
   * @returns {Promise<Array>} List of Stremio stream objects
   */
  async getStreamsForIdentifier(identifier, authConfig = {}, titleOverride = null) {
    const meta = await this.getMetadata(identifier, authConfig);
    if (!meta || !Array.isArray(meta.files)) return [];

    const movieTitle = titleOverride || (meta.metadata && meta.metadata.title) || identifier;
    const proxyHeaders = this.getProxyHeaders(authConfig);

    // Filter files for streamable video formats and exclude metadata/auxiliary files
    const videoFiles = meta.files.filter((file) => {
      const name = (file.name || '').toLowerCase();
      const hasValidExt = SUPPORTED_VIDEO_EXTS.some((ext) => name.endsWith(ext));
      if (!hasValidExt) return false;

      // Filter out ignored suffixes
      const isIgnored = IGNORED_SUFFIXES.some((suffix) => name.includes(suffix));
      if (isIgnored) return false;

      // Filter out very small files (less than 5MB), which are usually sample clips or broken files
      const size = parseInt(file.size, 10);
      if (!isNaN(size) && size < 5 * 1024 * 1024 && !name.includes('trailer')) {
        return false;
      }

      return true;
    });

    if (videoFiles.length === 0) {
      console.warn(`[ArchiveClient] No playable video files found in identifier "${identifier}".`);
      return [];
    }

    const streams = videoFiles.map((file) => {
      const q = this.detectQuality(file);
      const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
      const sizeStr = this.formatBytes(file.size);
      const sizeDisplay = sizeStr ? ` - ${sizeStr}` : '';

      // Direct download URL with safely encoded path segments
      const encodedFileName = file.name
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      const streamUrl = `${ARCHIVE_BASE_URL}/download/${encodeURIComponent(identifier)}/${encodedFileName}`;

      // Construct stream title format: [Archive.org] Movie Name (720p .mp4)
      const streamTitle = `[Archive.org] ${movieTitle} (${q.label} ${ext}${sizeDisplay})`;

      // Preference scoring for sorting
      const formatRank = ext === '.mp4' ? 4 : ext === '.mkv' ? 3 : ext === '.webm' ? 2 : 1;
      const fileBytes = parseInt(file.size || 0, 10);

      const streamObj = {
        title: streamTitle,
        url: streamUrl,
        behaviorHints: {
          notSupported: false
        },
        _qualityRank: q.rank,
        _formatRank: formatRank,
        _size: fileBytes
      };

      if (proxyHeaders) {
        streamObj.behaviorHints.proxyHeaders = {
          request: proxyHeaders
        };
      }

      return streamObj;
    });

    // Sort streams: Highest quality rank first, then preferred format (.mp4 > .mkv > .webm > .ogv), then size
    streams.sort((a, b) => {
      if (b._qualityRank !== a._qualityRank) return b._qualityRank - a._qualityRank;
      if (b._formatRank !== a._formatRank) return b._formatRank - a._formatRank;
      return b._size - a._size;
    });

    // Remove internal sorting properties before returning
    return streams.map(({ _qualityRank, _formatRank, _size, ...stream }) => stream);
  }

  /**
   * Resolves Cinemeta metadata for an IMDb ID.
   *
   * @param {string} type - 'movie' or 'series'
   * @param {string} id - IMDb ID (e.g. tt0063350 or tt0063350:1:2)
   * @returns {Promise<{name: string, year: number|null, season: number|null, episode: number|null}>}
   */
  async resolveCinemeta(type, id) {
    const parts = id.split(':');
    const imdbId = parts[0];
    const season = parts[1] ? parseInt(parts[1], 10) : null;
    const episode = parts[2] ? parseInt(parts[2], 10) : null;

    const cinemetaType = type === 'series' ? 'series' : 'movie';
    const url = `${CINEMETA_URL}/${cinemetaType}/${imdbId}.json`;

    try {
      console.log(`[ArchiveClient] Fetching Cinemeta metadata for ${id} (${url})`);
      const res = await axios.get(url, { timeout: 4000 });
      if (res.data && res.data.meta) {
        return {
          name: res.data.meta.name,
          year: res.data.meta.year ? parseInt(res.data.meta.year, 10) : null,
          season,
          episode
        };
      }
    } catch (err) {
      console.warn(`[ArchiveClient] Cinemeta lookup failed for ${id}: ${err.message}`);
    }

    return { name: null, year: null, season, episode };
  }

  /**
   * Resolves streams for IMDb ID or title query on Archive.org.
   *
   * @param {string} type - 'movie', 'series', or 'other'
   * @param {string} id - Stremio ID (e.g. tt0063350, archive:Night_Of_The_Living_Dead, etc.)
   * @param {Object} authConfig - User authentication config
   * @returns {Promise<Array>} Stremio stream array
   */
  async resolveStreams(type, id, authConfig = {}) {
    if (!id) return [];

    console.log(`[ArchiveClient] Resolving streams for type=${type}, id=${id}`);

    // Case 1: Direct Archive.org identifier (prefixed with 'archive:' or 'ia:' or raw)
    if (id.startsWith('archive:') || id.startsWith('ia:')) {
      const cleanIdentifier = id.replace(/^(archive|ia):/, '');
      return this.getStreamsForIdentifier(cleanIdentifier, authConfig);
    }

    // Case 2: IMDb ID (e.g. tt0063350 or tt0063350:1:1)
    if (id.startsWith('tt')) {
      const cinemeta = await this.resolveCinemeta(type, id);
      if (!cinemeta.name) {
        console.warn(`[ArchiveClient] Unable to find title for IMDb ID: ${id}`);
        return [];
      }

      const cleanTitle = cinemeta.name.replace(/[^\w\s]/gi, ' ').trim();
      let query;

      if (type === 'series' && cinemeta.season && cinemeta.episode) {
        // Series search with Season/Episode tokens
        const sPad = String(cinemeta.season).padStart(2, '0');
        const ePad = String(cinemeta.episode).padStart(2, '0');
        const epPattern = `(s${sPad}e${ePad} OR "Season ${cinemeta.season}" OR "Episode ${cinemeta.episode}")`;
        query = `title:("${cleanTitle}") AND ${epPattern} AND mediatype:(movies)`;
      } else if (cinemeta.year) {
        // Match title with year boost
        query = `title:(${cleanTitle}) AND mediatype:(movies)`;
      } else {
        query = `title:(${cleanTitle}) AND mediatype:(movies)`;
      }

      const docs = await this.search(query, { rows: 5, sort: 'downloads desc' }, authConfig);
      if (docs.length === 0) {
        // Fallback to broader title search
        const fallbackQuery = `title:(${cleanTitle}) AND mediatype:(movies)`;
        const fallbackDocs = await this.search(fallbackQuery, { rows: 5, sort: 'downloads desc' }, authConfig);
        if (fallbackDocs.length === 0) {
          console.log(`[ArchiveClient] No Archive.org items found for "${cleanTitle}"`);
          return [];
        }
        docs.push(...fallbackDocs);
      }

      // Collect streams from top matching items
      const streamResults = [];
      for (const doc of docs.slice(0, 3)) {
        const itemStreams = await this.getStreamsForIdentifier(doc.identifier, authConfig, cinemeta.name);
        streamResults.push(...itemStreams);
      }

      return streamResults;
    }

    // Case 3: Raw identifier lookup
    try {
      const directStreams = await this.getStreamsForIdentifier(id, authConfig);
      if (directStreams.length > 0) return directStreams;
    } catch (e) {
      // not a direct identifier
    }

    // Fallback: search by ID string as text
    const searchDocs = await this.search(`title:(${id}) AND mediatype:(movies)`, { rows: 3 }, authConfig);
    const searchStreams = [];
    for (const doc of searchDocs) {
      const streams = await this.getStreamsForIdentifier(doc.identifier, authConfig);
      searchStreams.push(...streams);
    }

    return searchStreams;
  }
}

// Export singleton instance and class
const archiveClient = new ArchiveClient();

module.exports = {
  ArchiveClient,
  archiveClient,
  SUPPORTED_VIDEO_EXTS
};
