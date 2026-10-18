# Internet Archive Stremio Addon

A complete, production-ready **Stremio v3 manifest-compliant Addon** written in Node.js using Express and the official `stremio-addon-sdk`. This addon enables users to browse, search, and stream public domain films, classic television series, animation, and cultural video collections from [Archive.org](https://archive.org) using user-authenticated sessions.

> 🌐 **Online Installation Dashboard**: [https://marcjuhl.github.io/stremio-archive-addon/](https://marcjuhl.github.io/stremio-archive-addon/)  
> Use the hosted GitHub Pages install screen to generate your configured manifest and install the addon into Stremio with a single click.

---

## 🌟 Key Features

- **Stateless Dynamic Authentication**:
  - Encodes Internet Archive credentials (S3 API Keys or Session Cookies) directly into the Stremio manifest URL (e.g., `https://<host>/<base64_config>/manifest.json`).
  - The server maintains zero persistent session storage or user databases—fully stateless and scalable across multiple serverless or container instances.
- **GitHub Pages & Local Install Dashboard**:
  - Hosted install screen on GitHub Pages ([`docs/index.html`](https://marcjuhl.github.io/stremio-archive-addon/)) and self-hosted on `/configure`.
  - Supports S3 API Keys (`access_key` / `secret_key`) and Session Cookies (`logged_in_user` / `logged_in_sig`).
  - Includes a live **Test Connection** feature to verify credentials against Archive.org before installing.
  - One-click Stremio installation button (`stremio://...`), Stremio Web button, and manifest URL clipboard copy.
- **Archive.org Catalog Browsing & Search**:
  - Feature Films catalog (`archive_movies`).
  - Classic TV & Shows catalog (`archive_series`).
  - Video Vault catalog for animation and historical collections (`archive_other`).
  - Native Stremio search bar integration using Archive.org's Advanced Search API.
  - Direct poster art generation via Archive.org Services (`https://archive.org/services/img/<identifier>`).
- **Universal Stream Lookup (IMDb & Direct Identifiers)**:
  - Resolves Stremio Cinemeta IMDb IDs (e.g., `tt0063350` or `tt0063350:1:1` for series episodes) by querying title and year, then scraping Archive.org for the highest-rated releases.
  - Direct Archive identifier streaming (e.g., `archive:Night.Of.The.Living.Dead_1080p`).
  - Multi-resolution stream sorting: 4K, 1080p, 720p, 480p, 360p, 240p across `.mp4`, `.mkv`, `.webm`, and `.ogv` formats.
- **Authenticated Proxy Streaming**:
  - Automatically attaches user authentication headers to outgoing API calls and playback stream descriptors via `behaviorHints.proxyHeaders.request`:
    - S3 format: `Authorization: LOW <access_key>:<secret_key>`
    - Cookie format: `Cookie: logged_in_user=<user>; logged_in_sig=<sig>`
- **Production Resilience & Performance**:
  - **Queue-based rate limiting** respecting Archive.org API bandwidth.
  - **Exponential backoff and jitter** with automated retries on 429 (Too Many Requests), 503, and network timeouts. Respects server `Retry-After` headers.
  - **In-memory LRU TTL Cache** for metadata and search queries to deliver sub-millisecond response times on repeat requests.

---

## 📂 Architecture & Directory Layout

```
├── addon.js                # Stremio SDK AddonBuilder, manifest, catalog & stream handlers
├── archive.js              # Archive.org API client: auth, rate limiter, retries, scraper & Cinemeta resolver
├── index.js                # Express HTTP server entrypoint, base64 routing, API endpoints
├── docs/
│   └── index.html          # GitHub Pages hosted install & configuration dashboard
├── public/
│   └── configure.html      # Server-hosted configuration interface
├── Dockerfile              # Minimal production container (Alpine, non-root user, healthcheck)
├── .dockerignore           # Container build exclusions
├── .gitignore              # Git exclusions
├── .env.example            # Environment variables template
├── package.json            # Node.js project manifests and scripts
├── test.js                 # Automated unit and integration test suite
└── README.md               # Complete installation and operations guide
```

---

## 🔑 Obtaining Internet Archive Credentials

While the addon supports **Guest Mode** for public domain titles, authenticating with your personal Archive.org account provides higher rate limits and access to restricted collections.

### Option 1: S3 API Keys (Recommended)
1. Log in to [Archive.org](https://archive.org).
2. Visit [https://archive.org/account/s3.php](https://archive.org/account/s3.php).
3. Click **Generate New Keys**.
4. Copy your **Access Key** and **Secret Key**.
5. Paste them into the **S3 API Keys** section on the `/configure` page.

> **Header Format Used**: `Authorization: LOW <access_key>:<secret_key>`

### Option 2: Session Cookies
1. Log in to [Archive.org](https://archive.org) in your web browser.
2. Open Developer Tools (`F12` or `Ctrl+Shift+I` / `Cmd+Option+I`).
3. Navigate to **Application** (Chrome/Edge) or **Storage** (Firefox) &rarr; **Cookies** &rarr; `https://archive.org`.
4. Locate and copy:
   - `logged_in_user`
   - `logged_in_sig`
5. Paste them into the **Session Cookies** section on the `/configure` page.

> **Header Format Used**: `Cookie: logged_in_user=<user>; logged_in_sig=<sig>`

---

## 🚀 Installation & Local Execution

### Prerequisites
- **Node.js**: v18.0.0 or higher
- **npm**: v9.0.0 or higher

### 1. Clone & Install Dependencies
```bash
git clone <repository_url>
cd splendid-meitner
npm install
```

### 2. Configure Environment (Optional)
Copy `.env.example` to `.env` to customize the port or client tuning:
```bash
cp .env.example .env
```
Default parameters in `.env`:
```ini
PORT=7000
HOST=0.0.0.0
RATE_LIMIT_DELAY_MS=150
MAX_CONCURRENT_REQUESTS=5
CACHE_TTL_MS=1800000
```

### 3. Run the Server
#### Production Mode:
```bash
npm start
```

#### Development Mode (Auto-reload on file changes):
```bash
npm run dev
```

The server will start listening at:
- **Configuration Dashboard**: `http://localhost:7000/configure`
- **Root Manifest**: `http://localhost:7000/manifest.json`
- **Health Check**: `http://localhost:7000/health`

### 4. Run the Automated Test Suite
The addon includes a comprehensive test suite testing manifest compliance, authentication generation, quality heuristics, and live endpoints:
```bash
npm test
```

---

## ☁️ 1-Click Free Cloud Deployment (No Local Server Needed)

You do not need to keep a local computer or home server running. You can deploy this addon to leading free serverless cloud platforms directly from this repository:

| Platform | Deployment Type | 1-Click Deploy Link |
|---|---|---|
| **Vercel** | Serverless Node.js (24/7, Global CDN, Free) | [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fmarcjuhl%2Fstremio-archive-addon) |
| **Render** | Cloud Web Service (Automated Git sync, Free) | [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/marcjuhl/stremio-archive-addon) |

### How It Works:
1. Click either **Deploy with Vercel** or **Deploy to Render**.
2. Sign in with GitHub and authorize the project creation.
3. Your cloud provider will automatically build and deploy the addon, generating a permanent HTTPS URL (e.g. `https://your-addon.vercel.app` or `https://stremio-archive.onrender.com`).
4. Open the [GitHub Pages Install Screen](https://marcjuhl.github.io/stremio-archive-addon/), input your new cloud URL, configure your credentials, and install directly into Stremio!

---

## 🐳 Docker Deployment

The included `Dockerfile` builds a production image based on `node:20-alpine` with an integrated healthcheck and unprivileged `node` user execution.

### Build the Docker Image
```bash
docker build -t stremio-archive-addon:latest .
```

### Run the Container
```bash
docker run -d \
  --name stremio-archive \
  -p 7000:7000 \
  --restart unless-stopped \
  stremio-archive-addon:latest
```

### Docker Compose
Create a `docker-compose.yml`:
```yaml
version: '3.8'

services:
  stremio-archive:
    build: .
    container_name: stremio-archive
    ports:
      - "7000:7000"
    environment:
      - PORT=7000
      - HOST=0.0.0.0
      - NODE_ENV=production
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:7000/health"]
      interval: 30s
      timeout: 5s
      retries: 3
```
Start with:
```bash
docker compose up -d
```

---

## 📺 Stremio Installation Guide

### Option A: Using the Hosted GitHub Pages Installer
1. Open the [GitHub Pages Install Screen](https://marcjuhl.github.io/stremio-archive-addon/).
2. In the **Addon Backend Server URL** field, enter your deployed server URL (or leave `http://localhost:7000` if running locally).
3. Select your authentication mode (**S3 Keys**, **Cookies**, or **Guest Mode**).
4. Click **⚡ Test Connection** to verify connectivity with Archive.org.
5. Click **🚀 Install to Stremio** or **🌐 Stremio Web** to install the addon into Stremio.

### Option B: Using the Self-Hosted / Local Configuration Page
1. Open your browser and navigate to:
   ```
   http://localhost:7000/configure
   ```
   *(Or your production domain: `https://your-domain.com/configure`)*
2. Select your preferred authentication mode (**S3 API Keys** or **Session Cookies**).
3. Enter your credentials and click **⚡ Test Connection**.
4. Click **🚀 Install to Stremio**:
   - On Desktop / Android: Stremio will automatically open and prompt to install the addon.
   - On Stremio Web: Click **🌐 Stremio Web** or copy the generated Manifest URL and paste it into the search bar under **Addons &rarr; Community Addons**.

---

## 📡 API & Protocol Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/configure` | Web UI for authentication and installation |
| `GET` | `/:config/configure` | Configuration page pre-filled with existing settings |
| `POST` | `/api/validate-auth` | Test credentials validity against Archive.org |
| `GET` | `/health` | Container uptime and health status |
| `GET` | `/manifest.json` | Default unconfigured Stremio v3 Manifest |
| `GET` | `/:config/manifest.json` | Authenticated Stremio v3 Manifest |
| `GET` | `[/:config]/catalog/:type/:id/:extra?.json` | Catalog listings and search queries |
| `GET` | `[/:config]/stream/:type/:id.json` | Stream resolution for IMDb IDs or Archive identifiers |

### Stream Object Output Format

```json
{
  "streams": [
    {
      "title": "[Archive.org] Night of the Living Dead (1080p .mp4 - 1.7 GB)",
      "url": "https://archive.org/download/Night.Of.The.Living.Dead_1080p/NightOfTheLivingDead_PS3.mp4",
      "behaviorHints": {
        "notSupported": false,
        "proxyHeaders": {
          "request": {
            "Authorization": "LOW <access_key>:<secret_key>"
          }
        }
      }
    }
  ]
}
```

---

## 🛡️ License

MIT License. Free to use, modify, and distribute.
Media items streamed via this addon are hosted by and subject to the terms of the [Internet Archive](https://archive.org).
