'use strict';

const { addonBuilder } = require('stremio-addon-sdk');
const { archiveClient } = require('./archive');

/**
 * Stremio v3 Manifest Definition
 */
const manifest = {
  id: 'org.archive.stremio.addon',
  version: '1.0.0',
  name: 'Internet Archive Media & Stream',
  description: 'Stream movies, classic series, and public domain video directly from Archive.org with user authentication.',
  logo: 'https://archive.org/images/glogo.jpg',
  background: 'https://archive.org/services/img/NightOfTheLivingDeadTrailer',
  // Strict compliance with Requirement 4
  resources: ['catalog', 'stream'],
  types: ['movie', 'series', 'other'],
  catalogs: [
    {
      type: 'movie',
      id: 'archive_movies',
      name: 'Archive Feature Films',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    },
    {
      type: 'series',
      id: 'archive_series',
      name: 'Archive Classic TV & Shows',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    },
    {
      type: 'other',
      id: 'archive_other',
      name: 'Archive Video Vault',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    }
  ],
  behaviorHints: {
    configurable: true,
    configurationRequired: false
  }
};

const builder = new addonBuilder(manifest);

/**
 * Catalog Handler: /catalog/:type/:id/:extra?.json
 * Resolves browsing and search queries using Archive.org Advanced Search API.
 */
builder.defineCatalogHandler(async (args) => {
  const { type, id, extra = {}, config = {} } = args;
  console.log(`[Addon] Catalog request received: type=${type}, id=${id}, extra=${JSON.stringify(extra)}`);

  const skip = parseInt(extra.skip || 0, 10);
  const rows = 24;
  const page = Math.floor(skip / rows) + 1;

  let query = '';

  if (extra.search && extra.search.trim()) {
    // User search in Stremio's search bar
    const cleanSearch = extra.search.replace(/[^\w\s]/gi, ' ').trim();
    if (type === 'movie') {
      query = `title:(${cleanSearch}) AND mediatype:(movies)`;
    } else if (type === 'series') {
      query = `title:(${cleanSearch}) AND (collection:(classic_tv) OR mediatype:(movies))`;
    } else {
      query = `title:(${cleanSearch}) AND mediatype:(movies)`;
    }
  } else {
    // Catalog browsing by category
    if (type === 'movie') {
      query = 'collection:(feature_films) AND mediatype:(movies)';
    } else if (type === 'series') {
      query = 'collection:(classic_tv) AND mediatype:(movies)';
    } else {
      query = 'collection:(animationandcartoons OR SciFi_Horror OR movie_trailers) AND mediatype:(movies)';
    }
  }

  try {
    const docs = await archiveClient.search(
      query,
      {
        page,
        rows,
        sort: 'downloads desc'
      },
      config
    );

    const metas = docs.map((doc) => {
      const docTitle = doc.title || doc.identifier;
      const releaseYear = doc.year ? String(doc.year) : undefined;
      const posterUrl = `https://archive.org/services/img/${encodeURIComponent(doc.identifier)}`;

      return {
        id: `archive:${doc.identifier}`,
        type: type,
        name: docTitle,
        poster: posterUrl,
        posterShape: 'poster',
        description: doc.description || `Archive.org media: ${docTitle}`,
        releaseInfo: releaseYear
      };
    });

    console.log(`[Addon] Returning ${metas.length} catalog items for type=${type}`);
    return { metas };
  } catch (err) {
    console.error(`[Addon] Catalog error for type=${type}, id=${id}:`, err.message);
    return { metas: [] };
  }
});

/**
 * Stream Handler: /stream/:type/:id.json
 * Resolves streamable video URLs using Archive.org Metadata API with user authentication.
 */
builder.defineStreamHandler(async (args) => {
  const { type, id, config = {} } = args;
  console.log(`[Addon] Stream request received: type=${type}, id=${id}`);

  if (!id) {
    return { streams: [] };
  }

  try {
    const streams = await archiveClient.resolveStreams(type, id, config);
    console.log(`[Addon] Found ${streams.length} streams for ${id}`);
    return { streams };
  } catch (err) {
    console.error(`[Addon] Stream handler error for id=${id}:`, err.message);
    return { streams: [] };
  }
});

module.exports = {
  manifest,
  builder
};
