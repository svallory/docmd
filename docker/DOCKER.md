# Docker Image for docmd

Official Docker image for docmd - the minimalist, zero-config documentation generator.

## Quick Start

> The examples below use `:latest` so you can copy-paste and run them immediately.
> **For production, CI, and any reproducible build**, replace `:latest` with the specific version you want — see [Available Tags](#available-tags).

### Pull the Image

```bash
# Pull from GitHub Container Registry (GHCR)
docker pull ghcr.io/docmd-io/docmd:latest
```

### Run Demo Site

The image ships with a demo template in `/template`. When you run the container with no volume mount, the entrypoint copies `/template` into `/docs` on first start, so the demo site comes up immediately.

```bash
# Start with built-in demo site — works out of the box
docker run -p 3000:3000 ghcr.io/docmd-io/docmd:latest

# Visit http://localhost:3000
```

### Initialize New Project

```bash
# Create and initialize a new project
mkdir my-docs && cd my-docs
docker run -v $(pwd):/workspace ghcr.io/docmd-io/docmd:latest init

# Serve it in production mode
docker run -v $(pwd):/docs -p 3000:3000 ghcr.io/docmd-io/docmd:latest
```

### Use Existing Docs

The image's default command is `docmd serve --host 0.0.0.0`: it builds the site once and serves it in production mode, answering `GET /healthz` with `{"status":"ok","version":"<docmd version>"}`. Use `dev` only for development (see [Development Server](#development-server)).

Mounting your own docs into `/docs` always wins — the entrypoint only seeds the demo template when `/docs` is completely empty, so your content is never overwritten.

```bash
# Mount your docs and serve them (default command: `docmd serve --host 0.0.0.0`)
docker run -v $(pwd)/docs:/docs -p 3000:3000 ghcr.io/docmd-io/docmd:latest

# Build static site
docker run -v $(pwd)/docs:/docs -v $(pwd)/site:/site ghcr.io/docmd-io/docmd:latest build
```

## Available Tags

The image is published with two tags per release:

| Tag | Description | When to use |
|-----|-------------|-------------|
| `latest` | Floating alias for the most recent stable release | Quick start, local exploration, throwaway CI |
| `<X.Y.Z>` | Pinned stable release (substitute the version you want) | Production, CI/CD, anything that must be reproducible |

> **Pin a specific version in production.** The examples below use `:latest` so you can copy-paste and run them immediately. For any pipeline whose output must be reproducible (or whose contracts you don't want silently changing), replace `:latest` with the specific version you want (e.g. `0.8.7`). Check the [package versions page](https://github.com/orgs/docmd-io/packages/container/docmd/versions) for the full list.

## Multi-Platform Support

The image is built for multiple architectures:

- `linux/amd64` - Standard x86_64 servers
- `linux/arm64` - ARM-based servers (AWS Graviton, Raspberry Pi, Apple Silicon)

Docker automatically pulls the correct image for your platform.

## Usage Examples

### Docker Compose

```yaml
# Replace `:latest` with a specific version (e.g. `0.8.7`) for reproducible
# production builds. See the GitHub releases page for available versions.
services:
  docmd:
    image: ghcr.io/docmd-io/docmd:latest
    ports:
      - "3000:3000"
    volumes:
      - ./docs:/docs
      - ./site:/site
    # Default command of the image; shown here for clarity.
    command: ["serve", "--host", "0.0.0.0"]
    # If you change PORT, change the `ports:` mapping to match.
    environment:
      PORT: "3000"
```

### GitHub Actions CI/CD

```yaml
name: Build Docs

on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Build documentation
        # Pin to a specific version (replace `:latest`) for reproducible CI runs.
        run: |
          docker run --rm \
            -v ${{ github.workspace }}/docs:/docs \
            -v ${{ github.workspace }}/site:/site \
            ghcr.io/docmd-io/docmd:latest \
            build
      
      - name: Deploy to GitHub Pages
        uses: peaceiris/actions-gh-pages@v3
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./site
```

### Kubernetes Deployment

```yaml
# Replace `:latest` with a specific version (e.g. `0.8.7`) for reproducible
# production deploys. Update the tag when you upgrade.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: docmd-server
spec:
  replicas: 1
  selector:
    matchLabels:
      app: docmd
  template:
    metadata:
      labels:
        app: docmd
    spec:
      # `serve` clears and rewrites its output directory, so /docs must be
      # writable. A configMap mount is read-only: stage it and copy it into an
      # emptyDir. (configMap keys are flat; for a nested docs/ tree use a
      # git-sync init step or bake the docs into your own image instead.)
      initContainers:
      - name: stage-docs
        image: ghcr.io/docmd-io/docmd:latest
        command: ["sh", "-c", "cp -r /content/. /docs/ && chown -R 1001:1001 /docs"]
        volumeMounts:
        - name: content
          mountPath: /content
        - name: docs
          mountPath: /docs
      containers:
      - name: docmd
        image: ghcr.io/docmd-io/docmd:latest
        # No `command:`: the image's entrypoint and default command
        # (`serve --host 0.0.0.0`) run as intended.
        ports:
        - containerPort: 3000
        volumeMounts:
        - name: docs
          mountPath: /docs
        # /healthz returns 503 during the initial build; the startupProbe holds
        # off liveness until the first build finishes (up to 150 x 2s = 5 min).
        startupProbe:
          httpGet:
            path: /healthz
            port: 3000
          periodSeconds: 2
          failureThreshold: 150
        readinessProbe:
          httpGet:
            path: /healthz
            port: 3000
        livenessProbe:
          httpGet:
            path: /healthz
            port: 3000
      volumes:
      - name: content
        configMap:
          name: docs-content
      - name: docs
        emptyDir: {}
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Node environment | `production` |
| `DOCMD_CONTAINER` | Container mode flag | `true` |
| `DOCMD_HOST` | Bind address for `serve` and `dev` (overridden by `--host`) | `0.0.0.0` via the image's default command; `127.0.0.1` otherwise. Ignored with the image's default command (it passes `--host`); takes effect only when you override the command without `--host`. |
| `PORT` | Port for `serve` (overridden by `--port`); also used by the health check | `3000` |

### Behind a reverse proxy

If you enable `serve.actions` behind a reverse proxy, `serve.actions.origins` must list the public origin(s) users reach the site from (for example `https://docs.example.com`); WebSocket connections from any other origin are rejected. Actions are off by default.

## Building Locally

```bash
# Clone the repository
git clone https://github.com/docmd-io/docmd.git
cd docmd

# Build the image
docker build -t docmd:local -f docker/Dockerfile .

# Test the build
docker run --rm -v $(pwd)/docs:/docs docmd:local --version
```

## Security Features

- Runs as non-root user (`docmd`)
- Minimal Alpine Linux base image
- Multi-stage build reduces attack surface
- SBOM (Software Bill of Materials) included
- OCI provenance attestation

## Health Check

The image includes a health check that requests `GET /healthz` on `${PORT:-3000}`. It succeeds once the site is built and `docmd serve` is answering; while the initial build runs the server returns 503.

```bash
# Check container health
docker inspect --format='{{.State.Health.Status}}' <container-id>

# Probe it directly
curl -f http://localhost:3000/healthz
# {"status":"ok","version":"<docmd version>"}
```

## Development Server

For writing docs, run `dev` instead of `serve`. It rebuilds on change and live-reloads the browser; it is not meant for production.

```bash
docker run -v $(pwd)/docs:/docs -p 3000:3000 ghcr.io/docmd-io/docmd:latest dev --host 0.0.0.0
```

`dev` defaults to `127.0.0.1` (loopback), which is unreachable through a published port, so pass `--host 0.0.0.0` (or set `DOCMD_HOST=0.0.0.0`). It may move to a higher port when 3000 is taken, whereas `serve` binds exactly `PORT` or fails.

## Troubleshooting

### Permission Issues

The entrypoint automatically remaps to the uid:gid of the mounted directory, so files are always owned by the correct host user. If you hit permission issues, verify the mounted path exists and is writable on the host.

### Cannot reach the server from the host

The server must bind `0.0.0.0` inside the container for a published port to work. The image's default command does this. If you override the command, pass the host explicitly:

```bash
docker run -p 3000:3000 ghcr.io/docmd-io/docmd:latest serve --host 0.0.0.0
```

> **Security**: when you bind to 0.0.0.0, every host that can reach the container's port can connect. Publish the port only on trusted networks, or put a reverse proxy in front. With `dev`, the WebSocket requires an Origin matching the bind host (defence against CSWSH, CWE-1385); with `serve`, actions are off unless enabled and are then restricted to `serve.actions.origins`.

### Memory Issues

```bash
# For large documentation sites
docker run --memory=2g -v $(pwd)/docs:/docs ghcr.io/docmd-io/docmd:latest build
```

## License

MIT License - see [LICENSE](../LICENSE) for details.

## Support

- **Issues**: [GitHub Issues](https://github.com/docmd-io/docmd/issues)
- **Documentation**: [docs.docmd.io](https://docs.docmd.io)
- **Website**: [docmd.io](https://docmd.io)