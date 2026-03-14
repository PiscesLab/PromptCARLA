"""
CARLA Simulator Service

Bridges the agent's HTTP config requests to the CARLA Python API.
Manages a persistent CARLA client connection, handles map switching,
actor lifecycle, and autopilot for spawned vehicles.
"""

import os
import random
import asyncio
import logging
import time
from typing import Optional, List
from contextlib import asynccontextmanager
from pathlib import Path

import carla
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv
from logging.handlers import RotatingFileHandler

# ===================== 1. Configuration & Logging =====================

# Load .env from current or parent directory
for _candidate in [Path(__file__).parent / '.env', Path(__file__).parent.parent / '.env']:
    if _candidate.exists():
        load_dotenv(dotenv_path=_candidate)
        break

# CARLA Engine Connection
CARLA_HOST = os.getenv("CARLA_HOST", "localhost")
CARLA_PORT = int(os.getenv("CARLA_PORT", "2000"))
CARLA_TIMEOUT = float(os.getenv("CARLA_TIMEOUT", "20.0"))

# Network & Ports
# Priority: 1. PORT (Docker standard) 2. SERVICE_PORT 3. NEXT_PUBLIC_API_PORT 4. Default 8502
LISTENING_PORT = int(os.getenv("PORT", os.getenv("SERVICE_PORT", os.getenv("NEXT_PUBLIC_API_PORT", "8502"))))
TM_PORT = int(os.getenv("TM_PORT", "5000"))

# Logging Setup
LOG_DIR = Path(os.getenv("LOG_DIR", "/app/logs"))
LOG_DIR.mkdir(parents=True, exist_ok=True)

LOG_FORMAT = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
logging.basicConfig(level=logging.INFO, format=LOG_FORMAT)

# File Logging with Rotation
_log_file = LOG_DIR / "simulator.log"
_file_handler = RotatingFileHandler(_log_file, maxBytes=10 * 1024 * 1024, backupCount=5)
_file_handler.setFormatter(logging.Formatter(LOG_FORMAT))
_file_handler.setLevel(logging.INFO)
logging.getLogger().addHandler(_file_handler)

logger = logging.getLogger("simulator_service")

# Log startup config for easier debugging
logger.info(f"Configured Simulator: Port={LISTENING_PORT}, TM_Port={TM_PORT}, CARLA={CARLA_HOST}:{CARLA_PORT}")


# ===================== 2. Request/Response Models =====================

class ConfigRequest(BaseModel):
    weather: str = Field(default="ClearNoon", description="CARLA weather preset")
    map: Optional[str] = Field(default=None, description="CARLA map/town name")
    number_of_vehicles: int = Field(default=20, ge=0)
    number_of_pedestrians: int = Field(default=10, ge=0)
    enable_autopilot: bool = Field(default=True)


class CleanupResponse(BaseModel):
    status: str
    vehicles_destroyed: int = 0
    pedestrians_destroyed: int = 0
    controllers_destroyed: int = 0
    sensors_destroyed: int = 0


class ApplyResponse(BaseModel):
    status: str
    map: Optional[str] = None
    weather: str = ""
    vehicles_spawned: List[int] = []
    pedestrians_spawned: List[int] = []
    error: Optional[str] = None


# ===================== 3. CARLA Client Manager =====================

class CarlaClientManager:
    def __init__(self, host: str, port: int, timeout: float, tm_port: int):
        self._host = host
        self._port = port
        self._timeout = timeout
        self._tm_port = tm_port
        self._client: Optional[carla.Client] = None
        self._traffic_manager: Optional[carla.TrafficManager] = None

    def connect(self) -> carla.Client:
        if self._client is not None:
            try:
                self._client.get_server_version()
                return self._client
            except Exception:
                logger.warning("Lost connection to CARLA, reconnecting...")
                self._client = None
                self._traffic_manager = None

        logger.info(f"Connecting to CARLA at {self._host}:{self._port}")
        client = carla.Client(self._host, self._port)
        client.set_timeout(self._timeout)
        version = client.get_server_version()
        logger.info(f"Connected to CARLA server v{version}")
        self._client = client
        return client

    @property
    def client(self) -> carla.Client:
        return self.connect()

    @property
    def world(self) -> carla.World:
        return self.client.get_world()

    @property
    def traffic_manager(self) -> carla.TrafficManager:
        """Uses unique TM_PORT to avoid bind errors on host network."""
        if self._traffic_manager is None:
            logger.info(f"Initializing Traffic Manager on port {self._tm_port}")
            self._traffic_manager = self.client.get_trafficmanager(self._tm_port)
            self._traffic_manager.set_global_distance_to_leading_vehicle(2.5)
            self._traffic_manager.set_synchronous_mode(False)
        return self._traffic_manager

    def load_map(self, map_name: str) -> carla.World:
        current_map = self.world.get_map().name
        current_short = current_map.split("/")[-1]
        if current_short == map_name:
            logger.info(f"Map {map_name} already loaded, skipping reload")
            return self.world
        
        logger.info(f"Loading map {map_name} (current: {current_short})")
        self._client.load_world(map_name)
        # Give CARLA a moment to switch and initialize
        time.sleep(2) 
        world = self._client.get_world()
        logger.info(f"Map {map_name} loaded successfully")
        return world

    def disconnect(self):
        self._client = None
        self._traffic_manager = None
        logger.info("Disconnected from CARLA")


# Initialize global manager
carla_manager = CarlaClientManager(CARLA_HOST, CARLA_PORT, CARLA_TIMEOUT, TM_PORT)


# ===================== 4. Actor Management =====================

def destroy_all_actors(world: carla.World) -> CleanupResponse:
    actors = world.get_actors()
    result = CleanupResponse(status="success")

    # Filter and destroy sensors first (cleaner shutdown)
    for actor in actors.filter("sensor.*"):
        try:
            actor.destroy()
            result.sensors_destroyed += 1
        except RuntimeError: pass

    for actor in actors.filter("controller.ai.walker"):
        try:
            actor.stop()
            actor.destroy()
            result.controllers_destroyed += 1
        except RuntimeError: pass

    for actor in actors.filter("vehicle.*"):
        try:
            actor.set_autopilot(False)
            actor.destroy()
            result.vehicles_destroyed += 1
        except RuntimeError: pass

    for actor in actors.filter("walker.pedestrian.*"):
        try:
            actor.destroy()
            result.pedestrians_destroyed += 1
        except RuntimeError: pass

    logger.info(f"Cleanup finished. Actors destroyed: {result}")
    return result


def spawn_vehicles(
    world: carla.World, 
    count: int, 
    enable_autopilot: bool, 
    traffic_manager: carla.TrafficManager
) -> List[int]:
    if count <= 0:
        return []

    blueprints = world.get_blueprint_library().filter("vehicle.*")
    spawn_points = world.get_map().get_spawn_points()
    random.shuffle(spawn_points)

    if count > len(spawn_points):
        logger.warning(f"Capping vehicles at {len(spawn_points)} spawn points")
        count = len(spawn_points)

    batch = []
    for i in range(count):
        bp = random.choice(blueprints)
        if bp.has_attribute("color"):
            color = random.choice(bp.get_attribute("color").recommended_values)
            bp.set_attribute("color", color)
        
        batch.append(
            carla.command.SpawnActor(bp, spawn_points[i]).then(
                carla.command.SetAutopilot(
                    carla.command.FutureActor, enable_autopilot, traffic_manager.get_port()
                )
            )
        )

    results = carla_manager.client.apply_batch_sync(batch, True)
    spawned = [r.actor_id for r in results if not r.error]
    logger.info(f"Spawned {len(spawned)}/{count} vehicles")
    return spawned


def spawn_pedestrians(world: carla.World, count: int) -> List[int]:
    if count <= 0:
        return []

    blueprints = world.get_blueprint_library().filter("walker.pedestrian.*")
    controller_bp = world.get_blueprint_library().find("controller.ai.walker")

    walker_batch = []
    for _ in range(count):
        bp = random.choice(blueprints)
        location = world.get_random_location_from_navigation()
        if location:
            walker_batch.append(carla.command.SpawnActor(bp, carla.Transform(location)))

    walker_results = carla_manager.client.apply_batch_sync(walker_batch, True)
    walker_ids = [r.actor_id for r in walker_results if not r.error]

    # Spawn AI controllers for successful walkers
    controller_batch = [
        carla.command.SpawnActor(controller_bp, carla.Transform(), world.get_actor(wid))
        for wid in walker_ids
    ]
    controller_results = carla_manager.client.apply_batch_sync(controller_batch, True)

    for r in controller_results:
        if not r.error:
            controller = world.get_actor(r.actor_id)
            if controller:
                controller.start()
                dest = world.get_random_location_from_navigation()
                if dest: controller.go_to_location(dest)

    logger.info(f"Spawned {len(walker_ids)}/{count} pedestrians")
    return walker_ids


# ===================== 5. FastAPI Application =====================

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(f"Simulator service starting. CARLA target: {CARLA_HOST}:{CARLA_PORT}")
    try:
        carla_manager.connect()
    except Exception as e:
        logger.error(f"Failed to connect to CARLA on startup: {e}")
    yield
    carla_manager.disconnect()

app = FastAPI(title="CARLA Simulator Service", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root():
    return {
        "status": "online",
        "carla_host": CARLA_HOST,
        "tm_port": TM_PORT,
        "api_port": LISTENING_PORT
    }


@app.post("/apply_config", response_model=ApplyResponse)
async def apply_config(config: ConfigRequest):
    """Bridge for the Agent to apply LLM-generated configurations."""
    try:
        # Offload heavy simulation logic to a separate thread
        result = await asyncio.get_event_loop().run_in_executor(
            None, _apply_config_sync, config
        )
        return result
    except Exception as e:
        logger.error(f"Failed to apply config: {e}")
        return ApplyResponse(status="error", error=str(e))


def _apply_config_sync(config: ConfigRequest) -> ApplyResponse:
    """Synchronous core logic for map switching and actor management."""
    # 1. Map Handling
    if config.map:
        world = carla_manager.load_map(config.map)
    else:
        world = carla_manager.world

    # 2. Complete actor purge
    destroy_all_actors(world)

    # 3. Weather update
    try:
        weather_param = getattr(carla.WeatherParameters, config.weather)
        world.set_weather(weather_param)
        logger.info(f"Weather preset applied: {config.weather}")
    except AttributeError:
        logger.warning(f"Invalid weather preset requested: {config.weather}")

    # Synchronize world state
    world.tick()

    # 4. Spawning workflow
    v_ids = spawn_vehicles(
        world, 
        config.number_of_vehicles, 
        config.enable_autopilot, 
        carla_manager.traffic_manager
    )
    p_ids = spawn_pedestrians(world, config.number_of_pedestrians)

    return ApplyResponse(
        status="success",
        map=world.get_map().name.split("/")[-1],
        weather=config.weather,
        vehicles_spawned=v_ids,
        pedestrians_spawned=p_ids
    )


if __name__ == "__main__":
    import time # Needed for the map load sleep
    # Entry point
    uvicorn.run("simulator_service:app", host="0.0.0.0", port=LISTENING_PORT, log_level="info")
