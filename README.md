# MetisCity — CARLA Configuration Agent

A web application that generates CARLA traffic simulation configurations from natural language prompts using multiple LLMs (Gemini, Claude, GPT-4.1-mini, DeepSeek) in parallel.

## Prerequisites

- Docker and Docker Compose
- At least one LLM API key (see below)

## Quick Start

1. **Clone and enter the project directory:**

```bash
cd metis-cais26-artifacts
```

2. **Create your `.env` file:**

```bash
cp .env.example .env
```

Edit `.env` and add your API keys. Only models with keys present will be used:

```
GOOGLE_API_KEY=your-key
ANTHROPIC_API_KEY=your-key
OPENAI_API_KEY=your-key
DEEPSEEK_API_KEY=your-key
```

3. **Build and launch:**

```bash
docker compose up --build -d
```

4. **Open the application:**

- Frontend: [http://localhost:3000](http://localhost:3000)
- API health check: [http://localhost:8500/health](http://localhost:8500/health)
- Available models: [http://localhost:8500/models](http://localhost:8500/models)

If running on a remote server, replace `localhost` with the server's IP address.

## Usage

Type a natural language description of a traffic scenario into the chat interface. The system sends the prompt to all available LLMs in parallel and displays each model's generated CARLA configuration side by side, along with latency and token usage metrics.

Example prompts:

- "Light traffic on a clear day in a small town"
- "Pouring rain with heavy traffic downtown"
- "Night highway scene, 3 vehicles, no pedestrians"
- "Rural road with fog and a single car"

## Architecture

```
metis-cais26-artifacts/
  .env                  # API keys (not committed)
  .env.example          # Template
  docker-compose.yml    # Orchestrates both services

  agent/                # FastAPI backend (port 8500)
    agent_service.py    # Multi-model config generation
    requirements.txt
    Dockerfile

  frontend/             # Next.js frontend (port 3000)
    app/
      page.tsx          # Chat interface
      layout.tsx
      globals.css
    Dockerfile
```

The **agent service** accepts a prompt via `POST /generate_config`, runs all available LLMs in parallel using LangChain, validates each output against the CARLA configuration schema (Pydantic), and returns per-model results with configs, latency, and token counts.

The **frontend** is a chat-style Next.js interface that displays each model's response in a color-coded card with syntax-highlighted JSON.

## Useful Commands

```bash
# View logs (both services)
docker compose logs -f

# View agent logs only
docker compose logs -f agent

# Rebuild after code changes
docker compose up --build -d

# Stop everything
docker compose down

# Check which models are loaded
curl http://localhost:8500/models
```

## API Reference

**`POST /generate_config`**

```json
{
  "prompt": "rainy highway with 5 cars",
  "simulator": "carla"
}
```

Returns per-model results with config, validation status, latency, and token usage.

**`GET /models`** — Lists available models and their providers.

**`GET /health`** — Health check endpoint.

## Logs

Agent logs are written to `./logs/agent/agent.log` (persisted via Docker volume) and to stdout (visible via `docker compose logs`). Frontend logs appear in `docker compose logs frontend` and in the browser developer console.
