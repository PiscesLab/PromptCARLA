import os
import asyncio
import logging
import json
import re
import uuid
import time
from typing import Optional, Dict, Any, List
from datetime import datetime
from contextlib import asynccontextmanager
from pathlib import Path
from logging.handlers import RotatingFileHandler
import httpx

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from pydantic import BaseModel, Field, field_validator, ValidationError
from dotenv import load_dotenv

from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_anthropic import ChatAnthropic
from langchain_openai import ChatOpenAI

# ===================== 1. Configuration and Logging =====================

for _candidate in [Path(__file__).parent / '.env', Path(__file__).parent.parent / '.env']:
    if _candidate.exists():
        load_dotenv(dotenv_path=_candidate)
        break

LOG_DIR = Path(os.getenv("LOG_DIR", "/app/logs"))
LOG_DIR.mkdir(parents=True, exist_ok=True)
LOG_FORMAT = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
logging.basicConfig(level=logging.INFO, format=LOG_FORMAT)

_file_handler = RotatingFileHandler(LOG_DIR / "agent.log", maxBytes=10*1024*1024, backupCount=5)
_file_handler.setFormatter(logging.Formatter(LOG_FORMAT))
logging.getLogger().addHandler(_file_handler)
logger = logging.getLogger(__name__)

# Environment-driven Ports and IPs
# Using AGENT_PORT from .env, defaulting to 8500
LISTENING_PORT = int(os.getenv("AGENT_PORT", os.getenv("PORT", "8500")))

# In network_mode: "host", services communicate via localhost.
# We ignore NEXT_PUBLIC_NODE_IP for internal routing to avoid NAT/Firewall issues.
INTERNAL_NODE_IP = "localhost"
SIM_PORT = os.getenv("SIMULATOR_PORT", "8502") 

CARLA_SERVER_URL = f"http://{INTERNAL_NODE_IP}:{SIM_PORT}/apply_config"
CARLA_TIMEOUT = int(os.getenv("CARLA_TIMEOUT", "30"))


# ===================== 2. Valid Enums =====================

VALID_WEATHERS = [
    "Default", "ClearNoon", "CloudyNoon", "WetNoon", "WetCloudyNoon",
    "SoftRainNoon", "MidRainyNoon", "HardRainNoon",
    "ClearSunset", "CloudySunset", "WetSunset",
    "WetCloudySunset", "SoftRainSunset", "MidRainSunset", "HardRainSunset",
    "ClearNight", "CloudyNight", "WetNight", "WetCloudyNight",
]

VALID_MAPS = [
    "Town01", "Town02", "Town03", "Town04", "Town05",
    "Town06", "Town07", "Town10", "Town11", "Town12",
]


# ===================== 3. Pydantic Models =====================

class CarlaConfig(BaseModel):
    """Validated CARLA configuration schema."""

    weather: str = Field(description="Weather preset")
    map: str = Field(description="CARLA town/map name")
    time_of_day: Optional[str] = Field(default=None, description="Time of day")
    visibility: Optional[int] = Field(default=None, description="Visibility percentage")
    number_of_vehicles: int = Field(description="Number of vehicles")
    number_of_pedestrians: int = Field(description="Number of pedestrians")

    @field_validator("weather")
    @classmethod
    def validate_weather(cls, v: str) -> str:
        if v not in VALID_WEATHERS:
            raise ValueError(f"Invalid weather '{v}'. Must be one of: {VALID_WEATHERS}")
        return v

    @field_validator("map")
    @classmethod
    def validate_map(cls, v: str) -> str:
        if v not in VALID_MAPS:
            raise ValueError(f"Invalid map '{v}'. Must be one of: {VALID_MAPS}")
        return v

    @field_validator("number_of_vehicles")
    @classmethod
    def validate_vehicles(cls, v: int) -> int:
        if v < 0:
            raise ValueError(f"number_of_vehicles must be >= 0, got {v}")
        return v

    @field_validator("number_of_pedestrians")
    @classmethod
    def validate_pedestrians(cls, v: int) -> int:
        if v < 0:
            raise ValueError(f"number_of_pedestrians must be >= 0, got {v}")
        return v

    class Config:
        extra = "allow"


class ModelResult(BaseModel):
    model_name: str
    status: str
    config: Optional[Dict[str, Any]] = None
    validation_success: bool = False
    validation_errors: List[str] = []
    latency_ms: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    error: Optional[str] = None


class PromptRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=2000)
    simulator: str = Field(default="carla")
    user_id: Optional[str] = None
    timestamp: Optional[str] = None


class ConfigResponse(BaseModel):
    status: str
    simulator: str
    simulation_id: Optional[str] = None
    timestamp: str
    model_results: List[ModelResult] = []
    error: Optional[str] = None


# ===================== 4. System Instruction =====================

CARLA_SYSTEM_INSTRUCTION = """\
You are a CARLA traffic simulation expert. Generate realistic configurations \
based on user prompts.

**CARLA Weather Presets:**
Default, ClearNoon, CloudyNoon, WetNoon, WetCloudyNoon, \
MidRainyNoon, HardRainNoon, SoftRainNoon, ClearSunset, CloudySunset, \
WetSunset, WetCloudySunset, MidRainSunset, HardRainSunset, SoftRainSunset, \
ClearNight, CloudyNight, WetNight, WetCloudyNight

**CARLA Maps:**
- Town01: A small, simple town with a river and several bridges.
- Town02: A small simple town with a mixture of residential and commercial buildings.
- Town03: A larger, urban map with a roundabout and large junctions.
- Town04: A small town embedded in the mountains with a special "figure of 8" infinite highway.
- Town05: Squared-grid town with cross junctions and a bridge. Multiple lanes per direction.
- Town06: Long many lane highways with many highway entrances and exits.
- Town07: A rural environment with narrow roads, corn, barns and hardly any traffic lights.
- Town10: A downtown urban environment with skyscrapers, residential buildings and an ocean promenade.
- Town11: A Large Map that is undecorated.
- Town12: A Large Map with numerous different regions.

**Parameters:**
- weather: One of the weather presets listed above (must match exactly)
- map: One of the town names listed above (must match exactly, e.g. "Town01")
- number_of_vehicles: integer >= 0
- number_of_pedestrians: integer >= 0
- visibility: 0-100 (percentage)

Generate a configuration that best matches the user's description. \
Return ONLY valid JSON."""


# ===================== 5. Model Registry =====================

MODEL_CONFIGS: Dict[str, Dict[str, str]] = {
    "gemini-2.5-flash": {
        "provider": "google",
        "model_id": "gemini-2.5-flash",
        "env_key": "GOOGLE_API_KEY",
    },
    "claude-sonnet-4": {
        "provider": "anthropic",
        "model_id": "claude-sonnet-4-20250514",
        "env_key": "ANTHROPIC_API_KEY",
    },
    "gpt-4.1-mini": {
        "provider": "openai",
        "model_id": "gpt-4.1-mini",
        "env_key": "OPENAI_API_KEY",
    },
    "deepseek-v3": {
        "provider": "deepseek",
        "model_id": "deepseek-chat",
        "env_key": "DEEPSEEK_API_KEY",
    },
}


def _make_llm(provider: str, model_id: str):
    """Instantiate the correct LangChain chat model."""
    common = {"temperature": 0.1}
    if provider == "google":
        return ChatGoogleGenerativeAI(
            model=model_id,
            google_api_key=os.getenv("GOOGLE_API_KEY"),
            **common,
        )
    if provider == "anthropic":
        return ChatAnthropic(
            model=model_id,
            anthropic_api_key=os.getenv("ANTHROPIC_API_KEY"),
            **common,
        )
    if provider == "openai":
        return ChatOpenAI(
            model=model_id,
            openai_api_key=os.getenv("OPENAI_API_KEY"),
            **common,
        )
    if provider == "deepseek":
        return ChatOpenAI(
            model=model_id,
            openai_api_key=os.getenv("DEEPSEEK_API_KEY"),
            openai_api_base=os.getenv("DEEPSEEK_API_BASE", "https://api.deepseek.com/v1"),
            **common,
        )
    raise ValueError(f"Unsupported provider: {provider}")


def _get_available_models() -> Dict[str, Any]:
    """Initialize only models whose API keys are present."""
    available = {}
    for name, cfg in MODEL_CONFIGS.items():
        if os.getenv(cfg["env_key"]):
            try:
                available[name] = _make_llm(cfg["provider"], cfg["model_id"])
                logger.info(f"Model initialized: {name}")
            except Exception as e:
                logger.warning(f"Failed to initialize {name}: {e}")
        else:
            logger.info(f"Skipping {name}: {cfg['env_key']} not set")
    return available


AVAILABLE_MODELS = _get_available_models()

if not AVAILABLE_MODELS:
    raise EnvironmentError(
        "No LLM API keys found. Set at least one of: "
        "GOOGLE_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY"
    )


# ===================== 6. Token Extraction =====================

def _extract_tokens(ai_message) -> Dict[str, int]:
    """Pull token counts from AIMessage.response_metadata across providers."""
    meta = getattr(ai_message, "response_metadata", {}) or {}
    usage = (
        meta.get("token_usage")
        or meta.get("usage")
        or meta.get("usage_metadata")
        or {}
    )
    input_tok = (
        usage.get("input_tokens")
        or usage.get("prompt_tokens")
        or usage.get("prompt_token_count")
        or 0
    )
    output_tok = (
        usage.get("output_tokens")
        or usage.get("completion_tokens")
        or usage.get("candidates_token_count")
        or 0
    )
    total = (
        usage.get("total_tokens")
        or usage.get("total_token_count")
        or (input_tok + output_tok)
    )
    return {
        "input_tokens": int(input_tok),
        "output_tokens": int(output_tok),
        "total_tokens": int(total),
    }


# ===================== 7. JSON Extraction & Validation =====================

def _extract_json(text: str) -> Optional[str]:
    """Best-effort JSON extraction from LLM output."""
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if m:
        return m.group(1)
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if m:
        return m.group()
    return None


def _validate_config(text: str) -> tuple[bool, Dict[str, Any], List[str]]:
    """Parse raw LLM text -> CarlaConfig. Returns (success, config_dict, errors)."""
    json_str = _extract_json(text)
    if json_str is None:
        return False, {}, ["No JSON object found in output"]
    try:
        data = json.loads(json_str)
    except json.JSONDecodeError as exc:
        return False, {}, [f"JSON decode error: {exc}"]
    try:
        config = CarlaConfig(**data)
        return True, config.model_dump(), []
    except (ValidationError, TypeError) as exc:
        return False, data, [str(exc)]


# ===================== 8. Per-Model Config Generation =====================

async def _generate_with_model(model_name: str, llm: Any, prompt: str) -> ModelResult:
    """Generate config with a single model, capturing latency and tokens."""
    full_prompt = f"""{CARLA_SYSTEM_INSTRUCTION}

=== USER REQUEST ===
{prompt}

Generate JSON configuration using EXACT numbers from the user request above."""

    start = time.perf_counter()
    try:
        ai_message = await llm.ainvoke(full_prompt)
        latency_ms = (time.perf_counter() - start) * 1000

        raw_text = ai_message.content
        tokens = _extract_tokens(ai_message)
        success, config, errors = _validate_config(raw_text)

        logger.info(
            f"[{model_name}] latency={latency_ms:.1f}ms "
            f"tokens={tokens} valid={success} config={json.dumps(config)}"
        )

        return ModelResult(
            model_name=model_name,
            status="success" if success else "validation_error",
            config=config if config else None,
            validation_success=success,
            validation_errors=errors,
            latency_ms=round(latency_ms, 1),
            **tokens,
        )

    except Exception as e:
        latency_ms = (time.perf_counter() - start) * 1000
        logger.error(f"[{model_name}] error after {latency_ms:.1f}ms: {e}")
        return ModelResult(
            model_name=model_name,
            status="error",
            latency_ms=round(latency_ms, 1),
            error=str(e),
        )


async def generate_all_models(prompt: str) -> List[ModelResult]:
    """Run all available models in parallel and return results."""
    tasks = [
        _generate_with_model(name, llm, prompt)
        for name, llm in AVAILABLE_MODELS.items()
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    model_results = []
    for r in results:
        if isinstance(r, ModelResult):
            model_results.append(r)
        else:
            logger.error(f"Unexpected task exception: {r}")
    return model_results


# ===================== 9. Simulator Integration =====================

async def send_to_carla(config: CarlaConfig) -> Dict[str, Any]:
    """Send configuration to CARLA simulator."""
    carla_payload = {
        "weather": config.weather,
        "map": config.map,
        "number_of_vehicles": config.number_of_vehicles,
        "number_of_pedestrians": config.number_of_pedestrians,
    }
    if config.visibility is not None:
        carla_payload["visibility"] = config.visibility

    logger.info(f"Sending config to CARLA: {carla_payload}")

    try:
        async with httpx.AsyncClient(timeout=CARLA_TIMEOUT) as client:
            response = await client.post(
                CARLA_SERVER_URL,
                json=carla_payload,
                headers={"Content-Type": "application/json"},
            )
            try:
                carla_data = response.json()
            except Exception:
                carla_data = {"raw_response": response.text}

            if response.status_code == 200:
                logger.info("CARLA accepted configuration")
                return {"status": "success", "status_code": response.status_code, "data": carla_data}
            else:
                logger.warning(f"CARLA returned status: {response.status_code}")
                return {"status": "error", "status_code": response.status_code, "data": carla_data}

    except httpx.TimeoutException:
        logger.error(f"CARLA request timeout after {CARLA_TIMEOUT}s")
        return {"status": "timeout", "error": f"CARLA did not respond within {CARLA_TIMEOUT}s"}
    except Exception as e:
        logger.error(f"Error sending to CARLA: {e}")
        return {"status": "error", "error": str(e)}


# ===================== 10. FastAPI Application =====================

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("CARLA Configuration Agent Service started")
    logger.info(f"Available models: {list(AVAILABLE_MODELS.keys())}")
    logger.info(f"CARLA endpoint: {CARLA_SERVER_URL}")
    yield
    logger.info("CARLA Configuration Agent Service shutting down")


app = FastAPI(
    title="CARLA Configuration Agent",
    description="Natural language to CARLA simulation configuration (multi-model)",
    version="5.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        start = time.perf_counter()
        body = None
        if request.method == "POST":
            body_bytes = await request.body()
            try:
                body = json.loads(body_bytes)
            except Exception:
                body = body_bytes.decode("utf-8", errors="replace")

        logger.info(
            f"REQ  {request.method} {request.url.path} "
            f"client={request.client.host if request.client else 'unknown'}"
            + (f" body={json.dumps(body)}" if body else "")
        )
        response = await call_next(request)
        elapsed_ms = (time.perf_counter() - start) * 1000
        logger.info(
            f"RESP {request.method} {request.url.path} "
            f"status={response.status_code} latency={elapsed_ms:.1f}ms"
        )
        return response


app.add_middleware(RequestLoggingMiddleware)


@app.get("/")
async def root():
    return {
        "service": "CARLA Configuration Agent",
        "version": "5.0.0",
        "status": "running",
        "available_models": list(AVAILABLE_MODELS.keys()),
    }


@app.get("/health")
async def health_check():
    return {"status": "healthy", "timestamp": datetime.utcnow().isoformat()}


@app.get("/models")
async def list_models():
    """List available models and their providers."""
    return {
        "models": [
            {"name": name, "provider": MODEL_CONFIGS[name]["provider"]}
            for name in AVAILABLE_MODELS.keys()
        ]
    }


@app.post("/generate_config", response_model=ConfigResponse)
async def generate_config(request: PromptRequest, apply_to_simulator: bool = False):
    """
    Generate CARLA config from all available LLMs in parallel.
    Returns per-model results with config, latency, and token usage.
    """
    user_id = request.user_id or str(uuid.uuid4())
    simulator = request.simulator.lower()

    if simulator != "carla":
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported simulator '{simulator}'. Currently supported: carla",
        )

    try:
        logger.info(f"Processing request from user {user_id}: {request.prompt}")

        total_start = time.perf_counter()
        model_results = await generate_all_models(request.prompt)
        total_ms = (time.perf_counter() - total_start) * 1000

        simulation_id = f"sim_{uuid.uuid4().hex[:8]}"

        logger.info(
            f"Completed {simulation_id} for user {user_id} "
            f"total_latency={total_ms:.1f}ms models={len(model_results)}"
        )

        return ConfigResponse(
            status="success",
            simulator="carla",
            simulation_id=simulation_id,
            timestamp=datetime.utcnow().isoformat(),
            model_results=model_results,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error processing request: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class ApplyConfigRequest(BaseModel):
    config: Dict[str, Any]
    model_name: Optional[str] = None


class ApplyConfigResponse(BaseModel):
    status: str
    simulation_id: str
    config: Dict[str, Any]
    simulator_status: str
    simulator_response: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


@app.post("/apply_config", response_model=ApplyConfigResponse)
async def apply_config(request: ApplyConfigRequest):
    """
    Apply a previously generated config to the CARLA simulator.
    Used when the user selects a specific model's config from the chat.
    """
    simulation_id = f"sim_{uuid.uuid4().hex[:8]}"
    try:
        carla_config = CarlaConfig(**request.config)
        logger.info(
            f"Applying config {simulation_id} to CARLA "
            f"model={request.model_name} config={json.dumps(request.config)}"
        )
        result = await send_to_carla(carla_config)
        logger.info(
            f"CARLA response for {simulation_id}: status={result.get('status')}"
        )
        return ApplyConfigResponse(
            status="success",
            simulation_id=simulation_id,
            config=request.config,
            simulator_status=result.get("status", "unknown"),
            simulator_response=result,
        )
    except ValidationError as e:
        logger.error(f"Invalid config for {simulation_id}: {e}")
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.error(f"Error applying config {simulation_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ===================== 11. Run Server =====================

# ===================== 11. Run Server =====================

if __name__ == "__main__":
    logger.info(f"Starting Agent Service on host port {LISTENING_PORT}")
    logger.info(f"Internal routing to Simulator at {CARLA_SERVER_URL}")

    # We use "0.0.0.0" so it's accessible externally via your NEXT_PUBLIC_NODE_IP,
    # but internally it will also respond to localhost requests.
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=LISTENING_PORT)
