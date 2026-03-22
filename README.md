# PromptCarla

**PromptCarla** is a prompt-to-config agent that investigates the use of large language models for translating natural language traffic scenario descriptions into structured configuration files for the CARLA autonomous driving simulator. The system evaluates four LLMs in parallel — Gemini 2.5 Flash, Claude Sonnet 4, GPT-4.1 Mini, and DeepSeek V3 — on their ability to accurately interpret and encode scenario semantics into validated simulator parameters.


---

## Table of Contents

- [Overview](#overview)
- [Live Demo](#live-demo)
- [Architecture](#architecture)
- [Services](#services)
- [Setup and Installation](#setup-and-installation)
- [Usage](#usage)
- [API Reference](#api-reference)
- [Acknowledgements](#acknowledgements)

---

## Overview

Configuring traffic simulations traditionally requires manual authoring of structured parameter files, demanding familiarity with simulator-specific schemas. PromptCarla investigates whether LLMs can reliably bridge natural language and simulator configuration, enabling researchers and practitioners to describe scenarios in plain English.

A user submits a scenario description (e.g., *"heavy rain downtown, 20 vehicles, low visibility"*); the system dispatches the prompt concurrently to four LLMs, each producing a Pydantic-validated `CarlaConfig` JSON object. Results are presented side-by-side with per-model latency, token usage, and validation status, allowing direct comparison of model outputs. A selected configuration can then be applied to a running CARLA instance, with the resulting simulation streamed live to a monitoring dashboard.

**Key capabilities:**

- Natural language to validated CARLA configuration via multi-model parallel inference
- Pydantic-based schema validation with automatic constraint correction
- Per-model reporting of latency, token usage, and validation status for comparative evaluation
- Real-time 2D simulation map rendered with PixiJS v8 (WebGPU-accelerated)
- Live actor telemetry streamed over WebSocket at 20 Hz
- Docker Compose deployment across four isolated services

---

## Live Demo

A live deployment of PromptCarla is accessible at:

[Live Demo](http://128.105.144.57:3000)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        User (Browser)                           │
│                    Next.js 16 Frontend                          │
│         Chat UI · Results Dashboard · 2D Map (PixiJS)          │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTP / WebSocket
          ┌──────────────┴──────────────┐
          │                             │
          ▼                             ▼
┌─────────────────┐          ┌──────────────────────┐
│   Agent Service │          │   Snapshot Service   │
│   FastAPI       │          │   FastAPI            │
│   LangChain     │          │   CARLA Python API   │
│   Port 8500     │          │   Port 8000          │
└────────┬────────┘          └──────────┬───────────┘
         │                              │
         │ Parallel LLM calls           │ CARLA TCP
         │                              ▼
    ┌────┴─────────────────┐   ┌────────────────────┐
    │  Gemini 2.5 Flash    │   │   CARLA Simulator  │
    │  Claude Sonnet 4     │   │   UE4 / Port 2000  │
    │  GPT-4.1 Mini        │   └────────────────────┘
    │  DeepSeek V3         │
    └──────────────────────┘
```

**Request flow:**

1. User submits a natural language prompt via the chat interface.
2. The Agent Service dispatches the prompt concurrently to all four LLMs via LangChain LCEL chains.
3. Each model response is parsed and validated against the `CarlaConfig` Pydantic schema.
4. All results — including per-model latency, token usage, and validation status — are returned to the frontend simultaneously.
5. The user selects a configuration; the Agent Service forwards it to CARLA via `/apply_config`.
6. The Snapshot Service connects to the running CARLA instance and begins streaming actor state (vehicles, pedestrians, traffic lights) over WebSocket at 20 Hz.
7. The frontend renders the live simulation on a 2D PixiJS canvas with road geometry fetched from the CARLA map API.

---

## Services

### Agent Service (`/agent`)

A FastAPI application responsible for natural language processing and configuration generation.

| Component | Technology |
|-----------|-----------|
| Framework | FastAPI (async) |
| LLM orchestration | LangChain LCEL |
| Models | Gemini 2.5 Flash, Claude Sonnet 4, GPT-4.1 Mini, DeepSeek V3 |
| Validation | Pydantic v2 |
| Concurrency | `asyncio.gather` — all models queried in parallel |

Each model runs in an isolated LCEL chain with a shared system prompt, structured output parser, and per-provider timeout. Validation errors are returned per-model without failing the entire response.

### Snapshot Service (`/snapshot`)

A FastAPI application that bridges the CARLA Python API and the web frontend.

| Component | Technology |
|-----------|-----------|
| Framework | FastAPI (async) |
| CARLA interface | CARLA Python API 0.9.x |
| Streaming | WebSocket (20 Hz actor snapshots) |
| Map data | `carla.Map.generate_waypoints()` — dense lane geometry |

Actor state (position, rotation, velocity) is polled from CARLA every 50 ms and broadcast to all connected WebSocket clients. Road geometry is extracted once on connection using `generate_waypoints(2.0)` and cached for the session.

### Frontend (`/frontend`)

A Next.js 16 application providing the chat interface and simulation dashboard.

| Component | Technology |
|-----------|-----------|
| Framework | Next.js 16 (App Router, Turbopack) |
| UI components | shadcn/ui (Tailwind CSS v4) |
| Map renderer | PixiJS v8 (WebGPU preferred, Canvas fallback) |
| Real-time data | WebSocket — native browser API |
| Theming | CSS custom properties (oklch), dark/light mode via `next-themes` |

The map visualisation uses PixiJS retained-mode rendering: each vehicle, pedestrian, and traffic light is a persistent `Graphics` object updated in-place on each WebSocket message, avoiding full-scene redraws.

### CARLA Simulator

A standard CARLA 0.9.x instance running Unreal Engine 4. No modifications to the simulator are required. PromptCarla connects via the CARLA Python client API over TCP port 2000.

---

## Setup and Installation

### Prerequisites

- Docker and Docker Compose
- CARLA Simulator 0.9.x (running separately or via Docker)
- API keys for: Google Gemini, Anthropic Claude, OpenAI, DeepSeek

### Environment Variables

Create a `.env` file in the project root:

```env
# CARLA connection
CARLA_HOST=localhost
CARLA_PORT=2000
CARLA_TIMEOUT=30.0

# Service ports
AGENT_PORT=8500
SNAPSHOT_PORT=8000

# LLM API keys
GOOGLE_API_KEY=your_google_api_key
ANTHROPIC_API_KEY=your_anthropic_api_key
OPENAI_API_KEY=your_openai_api_key
DEEPSEEK_API_KEY=your_deepseek_api_key

# Frontend (build-time)
NEXT_PUBLIC_NODE_IP=localhost
NEXT_PUBLIC_AGENT_PORT=8500
NEXT_PUBLIC_SNAPSHOT_PORT=8000
```

All four API keys are required for full multi-model operation. If a key is missing or invalid, the corresponding model will return an error result while the remaining models continue to function. API keys can be obtained from the respective provider portals:

- `GOOGLE_API_KEY` — [Google AI Studio](https://aistudio.google.com/app/apikey)
- `ANTHROPIC_API_KEY` — [Anthropic Console](https://console.anthropic.com/)
- `OPENAI_API_KEY` — [OpenAI Platform](https://platform.openai.com/api-keys)
- `DEEPSEEK_API_KEY` — [DeepSeek Platform](https://platform.deepseek.com/)

### Running with Docker Compose

```bash
# Clone the repository
git clone https://github.com/your-org/promptcarla.git
cd promptcarla

# Copy and fill in environment variables
cp .env.example .env

# Build and start all services
docker compose up --build
```

Services will be available at:

| Service | URL |
|---------|-----|
| Frontend | http://localhost:3000 |
| Agent API | http://localhost:8500 |
| Snapshot API | http://localhost:8000 |

> **Note:** CARLA must be running and accessible at `CARLA_HOST:CARLA_PORT` before starting the Snapshot Service. The Agent Service and Frontend are functional without a running CARLA instance for configuration generation only.

### Running Without Docker

**Agent Service:**
```bash
cd agent
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8500 --reload
```

**Snapshot Service:**
```bash
cd snapshot
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

**Frontend:**
```bash
cd frontend
npm install
npm run dev
```

---

## Usage

### Generating a Configuration

1. Navigate to `http://localhost:3000`.
2. Enter a natural language traffic scenario description in the input field. Examples:
   - *"Busy downtown intersection during rush hour, heavy rain, 30 vehicles"*
   - *"Rural highway at night, clear sky, 5 vehicles, no pedestrians"*
   - *"Foggy morning in a residential area with moderate pedestrian activity"*
3. Click **Simulate**. All four models are queried concurrently. Results appear as cards showing the generated JSON configuration, validation status, latency, and token usage.
4. Click a valid configuration card to apply it to CARLA.

### Monitoring a Simulation

After applying a configuration, the results page presents three tabs:

- **Overview** — Simulation metadata, model attribution, and live metrics summary.
- **Real-time Map** — 2D PixiJS visualisation of the CARLA map with live vehicle positions, pedestrian positions, and traffic light states.
- **Live Dashboard** — Per-vehicle telemetry with speed, position, heading, and optional camera feed.

---

## API Reference

### Agent Service — `http://localhost:8500`

#### `GET /health`
Returns service and connectivity status.

**Response:**
```json
{ "status": "online" }
```

---

#### `POST /generate_config`
Generates CARLA configurations from a natural language prompt using all configured models in parallel.

**Request body:**
```json
{
  "prompt": "string",
  "simulator": "carla"
}
```

**Response:**
```json
{
  "status": "success",
  "simulator": "carla",
  "simulation_id": "sim_abc123",
  "timestamp": "2026-01-01T00:00:00Z",
  "model_results": [
    {
      "model_name": "gemini-2.5-flash",
      "status": "success",
      "config": { ... },
      "validation_success": true,
      "validation_errors": [],
      "latency_ms": 1240.5,
      "input_tokens": 312,
      "output_tokens": 87,
      "total_tokens": 399,
      "error": null
    }
  ]
}
```

---

#### `POST /apply_config`
Applies a selected configuration to the running CARLA instance.

**Request body:**
```json
{
  "config": { ... },
  "model_name": "gemini-2.5-flash"
}
```

**Response:**
```json
{
  "simulation_id": "sim_abc123",
  "simulator_status": "success"
}
```

---

### Snapshot Service — `http://localhost:8000`

#### `GET /health`
Returns service and CARLA connectivity status.

**Response:**
```json
{
  "status": "online",
  "carla_connected": true
}
```

---

#### `GET /map_data`
Returns lane geometry and spawn points for the active CARLA map. Cached after first call per session. Requires an active CARLA connection.

**Response:**
```json
{
  "map_name": "Carla/Maps/Town03",
  "lanes": [
    {
      "points": [
        { "x": 12.4, "y": -33.1, "width": 3.5 },
        ...
      ]
    }
  ],
  "spawn_points": [
    { "x": 10.0, "y": -30.0 },
    ...
  ]
}
```

---

#### `WebSocket /ws`
Streams simulation snapshots at approximately 20 Hz. No authentication required.

**Message format (JSON):**
```json
{
  "timestamp": 1700000000.0,
  "vehicles": [
    {
      "id": 42,
      "type": "vehicle.tesla.model3",
      "position": { "x": 10.2, "y": -5.3, "z": 0.1 },
      "rotation": { "yaw": 90.0, "pitch": 0.0, "roll": 0.0 },
      "velocity": { "speed_kmh": 27.4 },
      "autopilot_enabled": true
    }
  ],
  "pedestrians": [ ... ],
  "traffic_lights": [
    {
      "id": 7,
      "position": { "x": 5.0, "y": -2.0, "z": 3.5 },
      "state": "green"
    }
  ],
  "metrics": {
    "total_vehicles": 15,
    "total_pedestrians": 3,
    "average_speed_kmh": 22.1,
    "max_speed_kmh": 48.7,
    "traffic_density": 3.0,
    "total_collisions": 0
  }
}
```

---

## Acknowledgements

This project was developed at **San Diego State University** as part of ongoing research in smart city simulation and agentic AI systems.

**Simulator:** This work uses [CARLA](https://carla.org/), an open-source autonomous driving simulator developed by the Computer Vision Center (CVC) at the Universitat Autònoma de Barcelona.

**Models evaluated:**
- Google Gemini 2.5 Flash
- Anthropic Claude Sonnet 4
- OpenAI GPT-4.1 Mini
- DeepSeek V3

**Key dependencies:**
- [LangChain](https://www.langchain.com/) — LLM orchestration and LCEL chain composition
- [FastAPI](https://fastapi.tiangolo.com/) — Async Python web framework
- [PixiJS](https://pixijs.com/) — WebGPU-accelerated 2D rendering
- [Next.js](https://nextjs.org/) — React framework
- [shadcn/ui](https://ui.shadcn.com/) — UI component library

---

